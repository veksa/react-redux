import { createListenerCollection } from '../../src/utils/listeners'
import * as batchModule from '../../src/utils/batch'

describe('listeners', () => {
  test('should notify listeners in one cycle with the same state', () => {
    // Simulate the clock crossing the 5ms chunk budget so the second listener
    // is deferred to a second chunk: 0 (finishTime=5), 1 (<5 -> fn1 runs),
    // 10 (>=5 -> yield), 100... (second chunk runs fn2).
    const times = [0, 1, 10, 100]
    let count = 0
    vi.spyOn(Date, 'now').mockImplementation(() =>
      count < times.length ? times[count++] : 100
    )

    const listeners = createListenerCollection()

    const state = { a: 0 }

    vi.spyOn(batchModule, 'defaultNoopBatch').mockImplementation(callback => {
      state.a = state.a + 1;

      callback();
    })

    const fn1Result = vi.fn();
    const fn2Result = vi.fn();

    const fn1 = vi.fn(() => fn1Result({...state}))
    const fn2 = vi.fn(() => fn2Result({...state}))

    listeners.subscribe(fn1)
    listeners.subscribe(fn2)

    listeners.notify()

    expect(fn1).toBeCalledTimes(1)
    expect(fn1Result).toBeCalledWith({a: 1});
    expect(fn2).toBeCalledTimes(1)
    expect(fn2Result).toBeCalledWith({a: 2});
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
    vi.spyOn(batchModule, 'defaultNoopBatch').mockImplementation(callback => {
      scheduled.push(callback)
    })

    // Fake clock advancing 3ms per read, so each 5ms chunk processes exactly
    // one listener: finishTime = t+5; first read t+3 (< budget, run one), next
    // read t+6 (>= budget, yield).
    let clock = 0
    vi.spyOn(Date, 'now').mockImplementation(() => (clock += 3))
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
})
