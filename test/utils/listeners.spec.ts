import { createListenerCollection } from '../../src/utils/listeners'
import * as scheduler from '../../src/utils/scheduler'

describe('listeners', () => {
  test('should notify listeners in one cycle with the same state', () => {
    const state = { a: 0 }

    // Run each scheduled chunk synchronously, bumping the "version" of the
    // state per chunk so we can prove listeners in different chunks observe the
    // state as it was when their chunk ran.
    vi.spyOn(scheduler, 'scheduleCallback').mockImplementation((callback) => {
      state.a = state.a + 1
      callback()
    })
    // Yield after every listener → exactly one listener per chunk.
    vi.spyOn(scheduler, 'shouldYield').mockReturnValue(true)

    const listeners = createListenerCollection()

    const fn1Result = vi.fn()
    const fn2Result = vi.fn()

    const fn1 = vi.fn(() => fn1Result({ ...state }))
    const fn2 = vi.fn(() => fn2Result({ ...state }))

    listeners.subscribe(fn1)
    listeners.subscribe(fn2)

    listeners.notify()

    expect(fn1).toBeCalledTimes(1)
    expect(fn1Result).toBeCalledWith({ a: 1 })
    expect(fn2).toBeCalledTimes(1)
    expect(fn2Result).toBeCalledWith({ a: 2 })
  })
})

// Notification is time-sliced, so a `notify()` can land while a previous pass
// is still draining. These tests pin down what must happen in that window; they
// fail against a per-`notify()` cursor, which spawns a second parallel drain.
describe('listeners re-entrancy', () => {
  let scheduled: Array<() => void>

  const flushOne = () => {
    scheduled.shift()?.()
  }

  const flushAll = () => {
    let guard = 0
    while (scheduled.length) {
      if (++guard > 10_000) throw new Error('drain did not terminate')
      flushOne()
    }
  }

  beforeEach(() => {
    scheduled = []

    // Fake scheduler: capture each chunk instead of running it, so the test can
    // deterministically interleave a re-entrant notify() between chunks.
    vi.spyOn(scheduler, 'scheduleCallback').mockImplementation((callback) => {
      scheduled.push(callback)
    })
    // Yield after every listener → exactly one listener per chunk.
    vi.spyOn(scheduler, 'shouldYield').mockReturnValue(true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('does not spawn a second, parallel drain when notify() arrives mid-notification', () => {
    const collection = createListenerCollection()
    collection.subscribe(vi.fn())
    collection.subscribe(vi.fn())
    collection.subscribe(vi.fn())

    collection.notify()
    expect(scheduled).toHaveLength(1) // first chunk queued

    flushOne() // first listener notified; the drain is still in flight
    expect(scheduled).toHaveLength(1)

    // A new notification arrives while the previous pass is still draining.
    collection.notify()

    // The in-flight drain is reused — NO extra chunk is stacked on top of it.
    // A per-notify() cursor queues a second, independent traversal here, making
    // this length 2.
    expect(scheduled).toHaveLength(1)

    flushAll()
    expect(scheduled).toHaveLength(0) // terminates cleanly, no leaked chunk
  })

  test('finishes the current pass in order before re-notifying, without interleaving passes', () => {
    const collection = createListenerCollection()
    const order: string[] = []
    collection.subscribe(() => order.push('a'))
    collection.subscribe(() => order.push('b'))
    collection.subscribe(() => order.push('c'))

    collection.notify()
    flushOne() // 'a' notified in pass 1

    collection.notify() // state changed again mid-drain
    flushAll()

    // One full pass completes in subscription order, then a single restart
    // re-notifies everyone in order. A parallel drain interleaves the two passes
    // (e.g. a,b,a,c,b,c), re-notifying a first-subscribed listener for the new
    // state before the earlier pass has even reached the last one.
    expect(order).toEqual(['a', 'b', 'c', 'a', 'b', 'c'])
  })

  test('coalesces multiple mid-drain notifications into a single restart', () => {
    const collection = createListenerCollection()
    const order: string[] = []
    collection.subscribe(() => order.push('a'))
    collection.subscribe(() => order.push('b'))

    collection.notify()
    flushOne() // 'a' notified

    // A burst of notifications arrives during the same drain.
    collection.notify()
    collection.notify()
    collection.notify()

    flushAll()

    // Exactly one extra pass, not one per notification.
    expect(order).toEqual(['a', 'b', 'a', 'b'])
  })

  test('always notifies at least one listener per chunk, even when shouldYield() is immediately true', () => {
    // Pending input makes shouldYield() true from the very first check. The pass
    // must still make progress (one listener per chunk) rather than reschedule
    // forever without notifying anyone.
    const collection = createListenerCollection()
    const order: string[] = []
    collection.subscribe(() => order.push('a'))
    collection.subscribe(() => order.push('b'))

    collection.notify()
    flushAll()

    expect(order).toEqual(['a', 'b'])
  })
})
