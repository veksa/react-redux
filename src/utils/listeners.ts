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

export function createListenerCollection() {
  const date = new Date()

  let first: Listener | null = null
  let last: Listener | null = null

  return {
    clear() {
      first = null
      last = null
    },

    notify() {
      let current: Listener | null = null

      const scheduleNextChunk = () => {
        batch(() => {
          const finishTime = date.getTime() + 5

          if (!current) {
            current = first
          }

          while (current && date.getTime() < finishTime) {
            current.callback()
            current = current.next
          }

          if (current) {
            scheduleNextChunk()
          }
        })
      }

      scheduleNextChunk()
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
