import { createListenerCollection } from '../../src/utils/listeners'
import * as batchModule from '../../src/utils/batch'

describe('listeners', () => {
  test('should notify listeners in one cycle with the same state', () => {
    vi.spyOn(global, 'Date').mockImplementation(() => {
      let count = 0

      return {
        getTime: () => {
          if (count === 0) {
            count++
            return 0
          }

          if (count === 1) {
            count++
            return 1
          }

          if (count === 2) {
            count++
            return 10
          }

          return 100
        }
      } as unknown as Date
    })

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
