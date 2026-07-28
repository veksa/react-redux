# Notification pass: main-thread blocking benchmark

Measures the cost that the `feature/optimize-subscription` branch targets: the
length of the **single long task** produced when the store notifies its
subscribers.

react-redux notifies every subscriber **synchronously in one pass**. On a large
app that pass is one uninterrupted long task — the main thread can't paint or
handle input until the last subscriber returns. That blocking time is precisely
what **INP** (Interaction to Next Paint) penalizes.

This branch slices the pass into **~5 ms chunks** and yields to the event loop
between them (`src/utils/listeners.ts` + `src/utils/batch.ts`), so the *longest
uninterrupted block* stays around the 5 ms budget no matter how many subscribers
there are.

---

## TL;DR

| subscribers | sync — longest task | sliced — longest task | reduction |
|------------:|--------------------:|----------------------:|----------:|
|       1,000 |          `2.6 ms`   |           `2.6 ms`    |    ~0%    |
|       5,000 |         `13.1 ms`   |           `5.0 ms`    |   −62%    |
|      10,000 |         `26.4 ms`   |           `5.0 ms`    |   −81%    |
|      20,000 |         `52.9 ms`   |           `5.0 ms`    |   −90%    |
|      50,000 |        `134.3 ms`   |           `5.0 ms`    |   −96%    |
|     100,000 |        `265.1 ms`   |           `5.0 ms`    |   −98%    |

Below ~one frame of work the two are identical (no regression). Once the
synchronous pass grows past a frame, the sliced longest task flatlines at the
budget while the synchronous one grows linearly.

---

## Longest blocking task (lower is better)

```
                    0ms        50ms       100ms      150ms      200ms      250ms
                    |----------|----------|----------|----------|----------|
  1,000   sync   ▏  2.6ms
          sliced ▏  2.6ms

  5,000   sync   ██  13.1ms
          sliced ▏   5.0ms

 10,000   sync   █████  26.4ms
          sliced ▏      5.0ms

 20,000   sync   ██████████  52.9ms          ← crosses the 50ms "long task" line
          sliced ▏           5.0ms

 50,000   sync   █████████████████████████  134.3ms
          sliced ▏                           5.0ms

100,000   sync   ████████████████████████████████████████████████  265.1ms
          sliced ▏                                                  5.0ms
```

> The browser flags any task **≥ 50 ms** as a "long task": input arriving during
> it is delayed by up to that long. At 20k+ subscribers the synchronous pass is a
> long task on its own; the sliced version keeps every task under one frame, so
> input can be serviced between chunks.

---

## The trade-off (stated honestly)

Slicing does **not** make the total work cheaper — it makes it *interruptible*.
Total wall-clock time goes **up**, because the pass now yields between chunks:

| subscribers | sync total | sliced total (wall) | chunks |
|------------:|-----------:|--------------------:|-------:|
|      10,000 |   `26.4 ms`|            `30.4 ms`|     14 |
|      20,000 |   `52.9 ms`|           `136.2 ms`|     29 |
|      50,000 |  `134.3 ms`|           `339.3 ms`|     69 |
|     100,000 |  `265.1 ms`|           `674.3 ms`|    135 |

That extra wall-clock time is **not** idle waiting — it is exactly the window in
which the main thread is free to paint and respond to input. You trade a longer
"time to fully settle" for a responsive UI throughout. For a background store
update (the common case) that is the right trade; for a synchronous read-after-
dispatch it is not, which is why this must ship as **opt-in**, not the default.

> ⚠️ The `sliced total` column is **pessimistic** here: in Node the yield uses
> `setImmediate`, whose per-tick latency inflates under load. The branch itself
> yields via `MessageChannel`, which fires far sooner in a browser. The
> **longest-task** metric — the one that matters for INP — is independent of the
> scheduler and holds in both.

---

## Why existing solutions don't cover this

| Mechanism | Axis it optimizes | Caps the pass length? |
|---|---|---|
| RTK `autoBatchEnhancer` (issue [#1511]) | **number** of notification passes (coalesces many dispatches → one pass) | ❌ the single pass is still fully synchronous |
| Concurrent stores prototype ([#2263]) | the React **render** phase (transition-compatible updates) | ❌ the subscriber-notification pass is untouched |
| **This branch** | **length** of one notification pass | ✅ time-sliced to the ~5 ms budget |

The three are orthogonal. `autoBatch` turns *N* long tasks into *one* long task;
it does nothing about that one task being 265 ms. This work is what shortens it.

[#1511]: https://github.com/reduxjs/react-redux/issues/1511
[#2263]: https://github.com/reduxjs/react-redux/pull/2263

---

## Reproducing

```bash
node benchmark/notify-bench.mjs
```

The time-sliced loop in the benchmark is a faithful copy of the branch's
`createListenerCollection().notify()` (5 ms budget, `Date.now()` sampled per
iteration, a macrotask yield between chunks). Each cell is the median of 7 runs.

**Environment:** Node `v24.11.1` · AMD Ryzen 7 7840HS (16 threads) · Windows 11 ·
`WORK = 4000` (≈ a few µs per subscriber, modeling a non-trivial memoized
selector recompute + shallow-equality check). Absolute numbers scale with
per-subscriber cost and hardware; the **shape** — flat vs. linear — does not.
