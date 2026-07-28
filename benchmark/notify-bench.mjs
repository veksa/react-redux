// Benchmark: main-thread blocking of a single store notification pass.
//
// react-redux notifies every subscriber synchronously in one pass. On a large
// app that pass is a single long task that blocks input until it finishes,
// which is exactly what INP measures. The `feature/optimize-subscription`
// branch slices that pass into ~5ms chunks and yields to the event loop
// between them, so the *longest uninterrupted block* stays small.
//
// This script compares the two strategies. The time-sliced loop is a faithful
// copy of `src/utils/listeners.ts` (5ms budget, `Date.now()` sampled per
// iteration, a macrotask yield between chunks). Run: `node benchmark/notify-bench.mjs`.

const CHUNK_BUDGET_MS = 5

// Macrotask yield — stands in for the branch's MessageChannel scheduler
// (`src/utils/batch.ts`); setImmediate is the same event-loop phase in Node.
const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve))

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

// A subscriber callback that mimics the cost of one `useSelector` check:
// read state, run a selector, do a shallow-equality comparison. `WORK` scales
// that cost so a single check lands around a few microseconds — the ballpark of
// a non-trivial memoized selector recompute + equality on a real app.
const WORK = 4000
const state = { items: Array.from({ length: 256 }, (_, i) => i), tick: 0 }

function makeCallback(i) {
  let last = -1
  return () => {
    let acc = 0
    for (let k = 0; k < WORK; k++) {
      acc += state.items[(i + k) & 255] ^ state.tick
    }
    const next = acc & 0xffff
    const changed = next !== last
    last = next
    return changed
  }
}

function makeListeners(n) {
  return Array.from({ length: n }, (_, i) => makeCallback(i))
}

// --- Strategy A: synchronous single pass (current upstream behavior) --------
function runSync(listeners) {
  const start = performance.now()
  for (let i = 0; i < listeners.length; i++) listeners[i]()
  const dur = performance.now() - start
  // One pass == one task, so the longest blocking task is the whole thing.
  return { longestTaskMs: dur, totalMs: dur, chunks: 1 }
}

// --- Strategy B: time-sliced pass (feature/optimize-subscription) -----------
async function runSliced(listeners) {
  const wallStart = performance.now()
  let i = 0
  let longestChunk = 0
  let chunks = 0

  while (i < listeners.length) {
    const chunkStart = performance.now()
    const finishTime = Date.now() + CHUNK_BUDGET_MS
    while (i < listeners.length && Date.now() < finishTime) {
      listeners[i]()
      i++
    }
    const chunkDur = performance.now() - chunkStart
    if (chunkDur > longestChunk) longestChunk = chunkDur
    chunks++
    if (i < listeners.length) await yieldToEventLoop()
  }

  return {
    longestTaskMs: longestChunk,
    totalMs: performance.now() - wallStart,
    chunks,
  }
}

async function bench(n, repeats = 7) {
  const listeners = makeListeners(n)

  // warm up JIT
  runSync(listeners)
  await runSliced(listeners)

  const sync = []
  const sliced = []
  const slicedTotal = []
  let chunks = 0

  for (let r = 0; r < repeats; r++) {
    state.tick++
    sync.push(runSync(listeners).longestTaskMs)

    state.tick++
    const b = await runSliced(listeners)
    sliced.push(b.longestTaskMs)
    slicedTotal.push(b.totalMs)
    chunks = b.chunks
  }

  return {
    n,
    syncLongest: median(sync),
    slicedLongest: median(sliced),
    slicedTotal: median(slicedTotal),
    chunks,
  }
}

const fmt = (x) => x.toFixed(2)

const rows = []
for (const n of [1_000, 5_000, 10_000, 20_000, 50_000, 100_000]) {
  rows.push(await bench(n))
}

console.log('\nsubscribers | sync longest task | sliced longest task | reduction | sliced chunks | sliced total wall')
console.log('-----------:|------------------:|--------------------:|----------:|--------------:|-----------------:')
for (const r of rows) {
  const reduction = ((1 - r.slicedLongest / r.syncLongest) * 100).toFixed(1)
  console.log(
    `${r.n.toLocaleString().padStart(11)} | ${fmt(r.syncLongest).padStart(14)} ms | ${fmt(r.slicedLongest).padStart(16)} ms | ${(reduction + '%').padStart(9)} | ${String(r.chunks).padStart(13)} | ${fmt(r.slicedTotal).padStart(14)} ms`,
  )
}

// machine-readable, for pasting into the results doc
console.log('\nJSON:' + JSON.stringify(rows))
