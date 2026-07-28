type Callback = () => void

// A single shared scheduler is reused for every deferred callback so that
// splitting a notification pass into chunks doesn't allocate a new
// MessageChannel (and a uuid) on every chunk.
let queue: Callback[] = []
let channel: MessageChannel | undefined

function flush() {
  // Swap in a fresh queue up front so callbacks scheduled *during* the flush
  // (re-entrant dispatches) run in the next task instead of this one.
  const pending = queue
  queue = []
  for (let i = 0; i < pending.length; i++) {
    pending[i]()
  }
}

// Defers `callback` to a macrotask, yielding to the browser between chunks.
// Prefers MessageChannel (fires sooner than setTimeout, which browsers clamp to
// ~4ms) and falls back to setTimeout where it isn't available.
export function defaultNoopBatch(callback: Callback) {
  queue.push(callback)

  // A flush for this batch is already scheduled; the callback will be picked up.
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
