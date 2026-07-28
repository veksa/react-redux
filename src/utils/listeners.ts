import { scheduleCallback, shouldYield } from './scheduler'

export type VoidFunc = () => void

export type Listener = {
  callback: VoidFunc
  next: Listener | null
  prev: Listener | null
}

// encapsulates the subscription logic for connecting a component to the redux store, as
// well as nesting subscriptions of descendant components, so that we can ensure the
// ancestor components re-render before descendants

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
    // Notify at least one listener before consulting shouldYield(), so the pass
    // always makes progress — otherwise pending input (which yields early) could
    // reschedule forever without notifying anyone.
    if (current) {
      do {
        current.callback()
        current = current.next
      } while (current && !shouldYield())
    }

    if (current) {
      // Deadline reached mid-pass: yield to the browser, then resume from here.
      scheduleCallback(drainChunk)
      return
    }

    if (restartQueued) {
      // A notification arrived while we were draining. Re-run from the head so
      // every listener observes the latest state exactly once per pass.
      restartQueued = false
      current = first
      scheduleCallback(drainChunk)
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
      scheduleCallback(drainChunk)
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
