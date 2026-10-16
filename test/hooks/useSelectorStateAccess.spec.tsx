import * as rtl from '@testing-library/react'
import type { ReactNode } from 'react'
import React, { useContext } from 'react'
import type {
  ProviderProps,
  ReactReduxContextValue,
  StateAccessListener,
} from 'react-redux'
import { Provider, ReactReduxContext, useSelector } from 'react-redux'
import type { Action, AnyAction, Store } from 'redux'
import { createStore } from 'redux'

function ProviderMock<A extends Action<any> = AnyAction, S = unknown>(
  props: ProviderProps<A, S>,
) {
  return (
    <Provider {...props} stabilityCheck="never" identityFunctionCheck="never" />
  )
}

type State = { a: number; b: number; c: number }

const increment = () => ({ type: 'increment' })

describe('React', () => {
  describe('hooks', () => {
    describe('useSelector onStateAccess', () => {
      let store: Store<State, AnyAction>

      beforeEach(() => {
        store = createStore(
          (state: State = { a: 1, b: 1, c: 1 }, action: AnyAction): State =>
            action.type === 'increment' ? { ...state, a: state.a + 1 } : state,
        )
      })

      it('reports each top-level key once per subscriber', () => {
        const onStateAccess = vi.fn<StateAccessListener>()
        const selectSum = (state: State) => state.a + state.b

        const Comp = () => <div>{useSelector(selectSum)}</div>

        rtl.render(
          <ProviderMock store={store} onStateAccess={onStateAccess}>
            <Comp />
          </ProviderMock>,
        )

        expect(onStateAccess.mock.calls).toEqual([
          ['a', selectSum],
          ['b', selectSum],
        ])

        rtl.act(() => {
          store.dispatch(increment())
          store.dispatch(increment())
        })

        expect(onStateAccess).toHaveBeenCalledTimes(2)
      })

      it('reports a key the first time a later evaluation reads it', () => {
        const onStateAccess = vi.fn<StateAccessListener>()
        const selectConditional = (state: State) =>
          state.a > 1 ? state.c : state.a

        const Comp = () => <div>{useSelector(selectConditional)}</div>

        rtl.render(
          <ProviderMock store={store} onStateAccess={onStateAccess}>
            <Comp />
          </ProviderMock>,
        )

        expect(onStateAccess.mock.calls.map(([key]) => key)).toEqual(['a'])

        rtl.act(() => {
          store.dispatch(increment())
        })

        expect(onStateAccess.mock.calls.map(([key]) => key)).toEqual(['a', 'c'])
      })

      it('reports separately for each subscribing component', () => {
        const onStateAccess = vi.fn<StateAccessListener>()
        const selectA = (state: State) => state.a

        const Comp = () => <div>{useSelector(selectA)}</div>

        rtl.render(
          <ProviderMock store={store} onStateAccess={onStateAccess}>
            <Comp />
            <Comp />
          </ProviderMock>,
        )

        expect(onStateAccess.mock.calls).toEqual([
          ['a', selectA],
          ['a', selectA],
        ])
      })

      it('does not report symbol keys', () => {
        const onStateAccess = vi.fn<StateAccessListener>()
        const selectTag = (state: State) =>
          String((state as any)[Symbol.toStringTag]) + state.a

        const Comp = () => <div>{useSelector(selectTag)}</div>

        rtl.render(
          <ProviderMock store={store} onStateAccess={onStateAccess}>
            <Comp />
          </ProviderMock>,
        )

        expect(onStateAccess.mock.calls.map(([key]) => key)).toEqual(['a'])
      })

      it('lets a nested context override the listener for a subtree', () => {
        const outer = vi.fn<StateAccessListener>()
        const inner = vi.fn<StateAccessListener>()
        const selectA = (state: State) => state.a
        const selectB = (state: State) => state.b

        const Scope = ({ children }: { children: ReactNode }) => {
          const parent = useContext(ReactReduxContext)!
          const value = React.useMemo(
            () => ({ ...parent, onStateAccess: inner }),
            [parent],
          )
          return (
            <ReactReduxContext.Provider value={value}>
              {children}
            </ReactReduxContext.Provider>
          )
        }

        const Outside = () => <div>{useSelector(selectA)}</div>
        const Inside = () => <div>{useSelector(selectB)}</div>

        rtl.render(
          <ProviderMock store={store} onStateAccess={outer}>
            <Outside />
            <Scope>
              <Inside />
            </Scope>
          </ProviderMock>,
        )

        expect(outer.mock.calls).toEqual([['a', selectA]])
        expect(inner.mock.calls).toEqual([['b', selectB]])
      })

      it('does not re-run selectors when the listener identity changes', () => {
        const selectA = vi.fn((state: State) => state.a)
        let renders = 0

        const Comp = React.memo(() => {
          renders++
          return <div>{useSelector(selectA)}</div>
        })

        const first = vi.fn<StateAccessListener>()
        const second = vi.fn<StateAccessListener>()

        const { rerender } = rtl.render(
          <ProviderMock store={store} onStateAccess={first}>
            <Comp />
          </ProviderMock>,
        )

        const selectorCalls = selectA.mock.calls.length

        rerender(
          <ProviderMock store={store} onStateAccess={second}>
            <Comp />
          </ProviderMock>,
        )

        expect(renders).toBe(1)
        expect(selectA).toHaveBeenCalledTimes(selectorCalls)
        expect(first).toHaveBeenCalledTimes(1)
        expect(second).not.toHaveBeenCalled()
      })

      it('reports every key to a listener added after mount', () => {
        const onStateAccess = vi.fn<StateAccessListener>()
        const selectSum = (state: State) => state.a + state.b

        const Comp = () => <div>{useSelector(selectSum)}</div>

        const { rerender } = rtl.render(
          <ProviderMock store={store}>
            <Comp />
          </ProviderMock>,
        )

        rerender(
          <ProviderMock store={store} onStateAccess={onStateAccess}>
            <Comp />
          </ProviderMock>,
        )

        expect(onStateAccess.mock.calls.map(([key]) => key)).toEqual(['a', 'b'])
      })

      it('marks the context value as supporting state access tracking', () => {
        let contextValue: ReactReduxContextValue | null = null

        const Comp = () => {
          contextValue = useContext(ReactReduxContext)
          return null
        }

        rtl.render(
          <ProviderMock store={store}>
            <Comp />
          </ProviderMock>,
        )

        expect(contextValue!.stateAccessTracking).toBe(true)
        expect(contextValue!.onStateAccess).toBeUndefined()
      })
    })
  })
})
