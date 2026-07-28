// Responsiveness benchmark: worst-case input latency during a notification pass.
//
// react-redux on React's built-in `useSyncExternalStore` (v9) notifies every
// subscriber SYNCHRONOUSLY in one pass. While that pass runs, the event loop is
// blocked — a user interaction that arrives mid-pass can't be serviced until it
// finishes. That wait is what INP measures.
//
// We measure it directly. A high-frequency "heartbeat" (a stand-in for the
// event loop's ability to service an interaction) ticks throughout the run; the
// largest gap between consecutive ticks is the longest the main thread was
// unavailable — i.e. the worst-case input latency.
//
//   * `react-uSES`  — synchronous single pass (what react-redux does today).
//   * `time-sliced` — this branch: yield every ~5ms.
//
// Both use setImmediate to schedule, which is exactly what React's own
// scheduler uses under Node (Scheduler.js:531). Run: `node benchmark/responsiveness.mjs`.

const BUDGET_MS = 5
const now = () => performance.now()
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const nextTask = () => new Promise((resolve) => setImmediate(resolve))

const WORK = 4000
const state = { items: Array.from({ length: 256 }, (_, i) => i), tick: 0 }
function makeListeners(n) {
  return Array.from({ length: n }, (_, i) => {
    let last = -1
    return () => {
      let acc = 0
      for (let k = 0; k < WORK; k++) acc += state.items[(i + k) & 255] ^ state.tick
      const next = acc & 0xffff
      const changed = next !== last
      last = next
      return changed
    }
  })
}

// React useSyncExternalStore: synchronous notification, one uninterrupted task.
function runReactUSES(listeners) {
  for (let i = 0; i < listeners.length; i++) listeners[i]()
}

// This branch: drain in ~5ms chunks, yielding to the event loop between them.
async function runTimeSliced(listeners) {
  let i = 0
  while (i < listeners.length) {
    const startTime = now()
    do {
      listeners[i]()
      i++
    } while (i < listeners.length && now() - startTime < BUDGET_MS)
    if (i < listeners.length) await nextTask()
  }
}

// Run `pass` while a heartbeat ticks; return the largest gap between ticks.
async function worstInputLatency(pass, listeners) {
  const beats = []
  let running = true
  const beat = () => {
    beats.push(now())
    if (running) setImmediate(beat)
  }
  setImmediate(beat)

  // let the heartbeat settle
  for (let i = 0; i < 5; i++) await nextTask()

  await pass(listeners)

  running = false
  await nextTask()
  await nextTask()

  let maxGap = 0
  for (let i = 1; i < beats.length; i++) {
    maxGap = Math.max(maxGap, beats[i] - beats[i - 1])
  }
  return maxGap
}

async function bench(n, repeats = 7) {
  const listeners = makeListeners(n)
  await runTimeSliced(listeners) // warm up

  const pick = async (pass) => {
    const out = []
    for (let r = 0; r < repeats; r++) {
      state.tick++
      out.push(await worstInputLatency(pass, listeners))
    }
    return median(out)
  }

  return {
    n,
    reactUSES: await pick(runReactUSES),
    timeSliced: await pick(runTimeSliced),
  }
}

const f = (x) => x.toFixed(2).padStart(10)
const rows = []
for (const n of [1_000, 10_000, 50_000, 100_000]) rows.push(await bench(n))

console.log('\n            WORST-CASE INPUT LATENCY (ms) — max main-thread block during a pass')
console.log('subscribers | react-uSES (sync) | time-sliced (this branch) | improvement')
console.log('-----------:|------------------:|--------------------------:|-----------:')
for (const r of rows) {
  const imp = ((1 - r.timeSliced / r.reactUSES) * 100).toFixed(1)
  console.log(
    `${String(r.n).padStart(11)} | ${f(r.reactUSES)} ms   | ${f(r.timeSliced)} ms           | ${(imp + '%').padStart(9)}`,
  )
}
console.log('\nJSON:' + JSON.stringify(rows))
process.exit(0)
