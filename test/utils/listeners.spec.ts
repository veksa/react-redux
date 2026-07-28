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
