import { defaultNoopBatch as batch } from './batch'

export type VoidFunc = () => void

export type Listener = {
  callback: VoidFunc
  next: Listener | null
  prev: Listener | null
}

// encapsulates the subscription logic for connecting a component to the redux store, as
// well as nesting subscriptions of descendant components, so that we can ensure the
// ancestor components re-render before descendants

// Max time (ms) a single notification chunk is allowed to run before yielding
// back to the browser. Splitting the pass keeps a large store from producing a
// long task that blocks input / hurts INP.
const CHUNK_BUDGET_MS = 5

export function createListenerCollection() {
  let first: Listener | null = null
  let last: Listener | null = null

  // Notification is time-sliced across async chunks, so a `notify()` can arrive
  // while a previous pass is still draining. These live on the collection (not
  // per `notify()` call) so we keep a single in-flight drain instead of
  // spawning a second, parallel traversal — which would notify listeners out of
  // order and more than once, breaking the ancestor-before-descendant ordering.
  let current: Listener | null = null
  let isDraining = false
  let restartQueued = false

  const drainChunk = () => {
    const finishTime = Date.now() + CHUNK_BUDGET_MS

    while (current && Date.now() < finishTime) {
      current.callback()
      current = current.next
    }

    if (current) {
      // Budget exhausted mid-pass: yield to the browser, then resume from here.
      batch(drainChunk)
      return
    }

    if (restartQueued) {
      // A notification arrived while we were draining. Re-run from the head so
      // every listener observes the latest state exactly once per pass.
      restartQueued = false
      current = first
      batch(drainChunk)
      return
    }

    isDraining = false
  }

  return {
    clear() {
      first = null
      last = null
      // Abort any in-flight drain: the listeners it was walking are gone.
      current = null
      restartQueued = false
    },

    notify() {
      if (isDraining) {
        // Fold this notification into the running drain instead of starting a
        // competing one; it will re-run from the head once the pass completes.
        restartQueued = true
        return
      }

      isDraining = true
      current = first
      batch(drainChunk)
    },

    get() {
      const listeners: Listener[] = []
      let listener = first
      while (listener) {
        listeners.push(listener)
        listener = listener.next
      }
      return listeners
    },

    subscribe(callback: () => void) {
      let isSubscribed = true

      const listener: Listener = (last = {
        callback,
        next: null,
        prev: last
      })

      if (listener.prev) {
        listener.prev.next = listener
      } else {
        first = listener
      }

      return function unsubscribe() {
        if (!isSubscribed || first === null) return
        isSubscribed = false

        if (listener.next) {
          listener.next.prev = listener.prev
        } else {
          last = listener.prev
        }
        if (listener.prev) {
          listener.prev.next = listener.next
        } else {
          first = listener.next
        }
      }
    }
  }
}
