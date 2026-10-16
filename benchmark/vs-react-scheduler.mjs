// Parity check: our sliced notify vs. React's scheduler on the same workload.
//
// The batching idea comes from React's `scheduler` package
// (packages/scheduler/src/forks/Scheduler.js). This compares three strategies
// running the SAME N callbacks, reporting the longest uninterrupted task:
//
//   1. `original`  — the branch's first cut, with the frozen-clock bug
//                    (`const date = new Date()` sampled once). The 5ms budget
//                    never expires, so it never actually yields.
//   2. `fixed`     — the current branch: 5ms budget sampled live via Date.now(),
//                    single shared MessageChannel, single in-flight drain.
//   3. `react`     — React's scheduler semantics: frameInterval = frameYieldMs
//                    (5ms), `startTime` reset per task, `getCurrentTime()`
//                    sampled live, one message loop (Scheduler.js:456-568).
//
// The point: `fixed` matches `react`; `original` degrades to one long task.
// Run: `node benchmark/vs-react-scheduler.mjs`

const BUDGET_MS = 5 // === React's frameYieldMs

// One shared scheduler (matches src/utils/batch.ts and Scheduler.js:549) — a
// single MessageChannel reused via a queue, NOT a new channel per yield.
let queue = []
const channel = new MessageChannel()
channel.port1.onmessage = () => {
  const pending = queue
  queue = []
  for (const cb of pending) cb()
}
const scheduleTask = (cb) => {
  queue.push(cb)
  if (queue.length === 1) channel.port2.postMessage(null)
}
const yieldToHost = () => new Promise((resolve) => scheduleTask(resolve))

const now = () => performance.now()
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

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

// 1. original — frozen clock: budget is computed from a timestamp captured once,
//    so `frozen < finishTime` is always true and the loop never yields.
async function runOriginal(listeners) {
  const frozen = now() // sampled ONCE, like `const date = new Date()`
  const wall = now()
  let i = 0
  let longest = 0
  let chunks = 0
  while (i < listeners.length) {
    const start = now()
    const finishTime = frozen + BUDGET_MS
    while (i < listeners.length && frozen < finishTime) {
      listeners[i]()
      i++
    }
    longest = Math.max(longest, now() - start)
    chunks++
    if (i < listeners.length) await yieldToHost()
  }
  return { longest, total: now() - wall, chunks }
}

// 2. fixed — live budget sampled per iteration (current branch).
async function runFixed(listeners) {
  const wall = now()
  let i = 0
  let longest = 0
  let chunks = 0
  while (i < listeners.length) {
    const start = now()
    const finishTime = Date.now() + BUDGET_MS
    while (i < listeners.length && Date.now() < finishTime) {
      listeners[i]()
      i++
    }
    longest = Math.max(longest, now() - start)
    chunks++
    if (i < listeners.length) await yieldToHost()
  }
  return { longest, total: now() - wall, chunks }
}

// 3. react — shouldYieldToHost: startTime reset per task, elapsed vs frameInterval.
async function runReact(listeners) {
  const wall = now()
  let i = 0
  let longest = 0
  let chunks = 0
  while (i < listeners.length) {
    const startTime = now() // Scheduler.js:507
    let chunkLongest = 0
    // work loop with shouldYieldToHost() checked after each unit
    while (i < listeners.length) {
      listeners[i]()
      i++
      if (now() - startTime >= BUDGET_MS) break // Scheduler.js:464-471
    }
    chunkLongest = now() - startTime
    longest = Math.max(longest, chunkLongest)
    chunks++
    if (i < listeners.length) await yieldToHost()
  }
  return { longest, total: now() - wall, chunks }
}

async function bench(n, repeats = 7) {
  const listeners = makeListeners(n)
  await runFixed(listeners) // warm up

  const pick = async (fn) => {
    const longest = []
    const total = []
    let chunks = 0
    for (let r = 0; r < repeats; r++) {
      state.tick++
      const res = await fn(listeners)
      longest.push(res.longest)
      total.push(res.total)
      chunks = res.chunks
    }
    return { longest: median(longest), total: median(total), chunks }
  }

  return {
    n,
    original: await pick(runOriginal),
    fixed: await pick(runFixed),
    react: await pick(runReact),
  }
}

const f = (x) => x.toFixed(2).padStart(8)
const rows = []
for (const n of [1_000, 10_000, 50_000, 100_000]) rows.push(await bench(n))

console.log('\n                    LONGEST TASK (ms) — lower is better        | chunks (fixed/react)')
console.log('subscribers |  original  |    fixed   |    react   |')
console.log('-----------:|-----------:|-----------:|-----------:|')
for (const r of rows) {
  console.log(
    `${String(r.n).padStart(11)} | ${f(r.original.longest)} | ${f(r.fixed.longest)} | ${f(r.react.longest)} | ${r.fixed.chunks} / ${r.react.chunks}`,
  )
}
console.log('\nJSON:' + JSON.stringify(rows))
process.exit(0)
