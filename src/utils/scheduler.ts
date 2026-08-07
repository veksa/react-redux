// Host scheduling primitive, vendored from React's Scheduler so react-redux
// time-slices store notifications with the exact same, proven semantics.
// Source: react/packages/scheduler/src/forks/Scheduler.js (line refs below).
//
// We copy only what a notification pass needs — a macrotask scheduler plus a
// `shouldYield()` deadline — not the priority min-heap.
//
// DEVIATION FROM REACT (our improvement): React yields *early*, before the 5ms
// frame budget, when it knows a paint is pending (`needsPaint`, set by its own
// commit phase — a signal a library doesn't have). We reproduce that early
// yield for the one signal a library *does* have: `navigator.scheduling
// .isInputPending()`. An in-progress notification then releases the main thread
// the instant the user interacts, instead of holding it for the full frame.

// Scheduler.js:11 — frameYieldMs
const frameInterval = 5

// After blocking this long we yield even while input keeps arriving, so a burst
// of input can't starve the notification indefinitely.
const maxYieldInterval = 300

// Scheduler.js:59-71 — getCurrentTime
let getCurrentTime: () => number
if (typeof performance === 'object' && typeof performance.now === 'function') {
  const localPerformance = performance
  getCurrentTime = () => localPerformance.now()
} else {
  const localDate = Date
  const initialTime = localDate.now()
  getCurrentTime = () => localDate.now() - initialTime
}

export { getCurrentTime }

// navigator.scheduling.isInputPending — not in the DOM lib typings yet.
type Scheduling = {
  isInputPending?: (options?: { includeContinuous?: boolean }) => boolean
}
const scheduling: Scheduling | undefined =
  typeof navigator !== 'undefined'
    ? (navigator as unknown as { scheduling?: Scheduling }).scheduling
    : undefined
const isInputPending =
  scheduling && typeof scheduling.isInputPending === 'function'
    ? scheduling.isInputPending.bind(scheduling)
    : null
// Include continuous input (pointermove, scroll, …) so we also stay responsive
// mid-gesture, not just on discrete clicks/keypresses.
const continuousOptions = { includeContinuous: true }

let startTime = -1
let needsPaint = false

// Scheduler.js:474-479 — requestPaint. Exported for parity / host integration;
// a consumer that knows a paint is imminent can call it to force an early yield.
export function requestPaint(): void {
  needsPaint = true
}

// Scheduler.js:459-472 — shouldYieldToHost, extended with the isInputPending
// early-yield described above.
export function shouldYield(): boolean {
  if (needsPaint) {
    // A paint is pending. Yield now. (Scheduler.js:460-462)
    return true
  }
  const timeElapsed = getCurrentTime() - startTime
  if (timeElapsed < frameInterval) {
    // Under one frame of work. React would keep going; we additionally yield
    // early if the user is trying to interact, so we don't add input latency in
    // the middle of a notification pass — while still honoring the max interval
    // as a hard cap against input starving the pass.
    if (
      isInputPending !== null &&
      timeElapsed < maxYieldInterval &&
      isInputPending(continuousOptions)
    ) {
      return true
    }
    // The main thread has only been blocked for a really short amount of time;
    // smaller than a single frame. Don't yield yet. (Scheduler.js:465-468)
    return false
  }
  // Yield now. (Scheduler.js:470-471)
  return true
}

// Macrotask transport. Scheduler.js:530-561 prefers setImmediate (Node), then a
// single reused MessageChannel (avoids setTimeout's 4ms clamp), then setTimeout.
// `startTime` is reset before each callback so `shouldYield()` measures the
// block length of *this* chunk (Scheduler.js:504-507).
let queue: Array<() => void> = []
let channel: MessageChannel | undefined

function flush() {
  // Swap in a fresh queue so callbacks scheduled during this flush (the next
  // chunk) run in the next task, not this one.
  const pending = queue
  queue = []
  for (let i = 0; i < pending.length; i++) {
    // Non-null: `pending` is a dense array we own, only ever grown by `push`.
    const callback = pending[i]!
    needsPaint = false
    startTime = getCurrentTime()
    callback()
  }
}

/**
 * Runs the first chunk of a pass in the *current* task instead of a scheduled
 * one, with the same bookkeeping {@linkcode flush} does per callback. Without
 * resetting `startTime` here, `shouldYield()` would compare against whenever
 * the last scheduled chunk ran — usually long ago — and report "yield" after a
 * single iteration, deferring nearly the whole pass.
 */
export function runSyncSlice(callback: () => void): void {
  needsPaint = false
  startTime = getCurrentTime()
  callback()
}

export function scheduleCallback(callback: () => void): void {
  queue.push(callback)
  if (queue.length > 1) return

  if (typeof MessageChannel !== 'undefined') {
    if (!channel) {
      channel = new MessageChannel()
      channel.port1.onmessage = flush
    }
    channel.port2.postMessage(null)
  } else {
    setTimeout(flush, 0)
  }
}
