/**
 * The sliced notification pass.
 *
 * Notification is driven by the fine path index, not by signal-library
 * effects: reconcile records which paths fired, the index turns those into the
 * hooks that must re-evaluate, and the provider decides *when* each one does.
 * That buys two things a library-driven flush can't have together:
 *
 * - O(changed): a dispatch runs only the selectors whose own paths changed —
 *   the work-reduction the deep graph was built for.
 * - Interruptibility: a burst above `sliceThreshold` re-evaluates across
 *   macrotasks instead of blocking the frame inside `dispatch`.
 *
 * The price is that `currentResult` is no longer guaranteed fresh at dispatch
 * time, so tear-freedom rests entirely on `getSnapshot` recomputing from the
 * latest committed state. These tests pin that down for BUILT hooks (the
 * coarse tier's own deferred window is covered in coarseTearing.spec.tsx).
 */
import { describe, expect, it, vi } from 'vitest'
import * as rtl from '@testing-library/react'
import React from 'react'
import { flushSync } from 'react-dom'
import {
  configureStore,
  createSlice,
  type PayloadAction,
} from '@reduxjs/toolkit'
import { SignalProvider, useSignalSelector } from '../../src/signals'
import { alienEngine } from '../../src/signals/engine'

const N = 80 // above the default sliceThreshold (64), so a full-list change slices

function makeStore() {
  const slice = createSlice({
    name: 's',
    initialState: {
      list: Array.from({ length: N }, (_, i) => ({ id: i, v: 0 })),
      other: 0,
    },
    reducers: {
      setAll: (state, action: PayloadAction<number>) => {
        state.list = state.list.map((row) => ({ ...row, v: action.payload }))
      },
      setOne: (
        state,
        action: PayloadAction<{ index: number; v: number }>,
      ) => {
        state.list[action.payload.index].v = action.payload.v
      },
      bumpOther: (state) => void state.other++,
    },
  })
  const store = configureStore({ reducer: slice.reducer })
  return { store, ...slice.actions }
}

type RootState = ReturnType<ReturnType<typeof makeStore>['store']['getState']>

const flushMacrotasks = () =>
  rtl.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

describe('fine tier — O(changed) selectivity', () => {
  const setup = () => {
    const { store, setOne, setAll, bumpOther } = makeStore()
    const runs = new Array<number>(N).fill(0)

    // Stable (hoisted) selectors: an inline selector is a new function every
    // render, and the hook's render-phase swap would re-run it anyway —
    // masking exactly the selectivity under test.
    const selectors = Array.from({ length: N }, (_, i) => (s: RootState) => {
      runs[i]++
      return s.list[i].v
    })

    function Leaf({ i }: { i: number }) {
      const v = useSignalSelector(selectors[i])
      return <span data-testid={`leaf-${i}`}>{v}</span>
    }

    rtl.render(
      <SignalProvider store={store}>
        {Array.from({ length: N }, (_, i) => (
          <Leaf key={i} i={i} />
        ))}
      </SignalProvider>,
    )

    return { store, setOne, setAll, bumpOther, runs }
  }

  const warmUp = async (
    store: ReturnType<typeof makeStore>['store'],
    setAll: ReturnType<typeof makeStore>['setAll'],
  ) => {
    // One full-list change + drain flush builds every hook's deep graph, so
    // all N are driven by the fine index from here on.
    rtl.act(() => {
      store.dispatch(setAll(0))
    })
    await flushMacrotasks()
  }

  it('changing one row re-runs exactly one selector', async () => {
    const { store, setOne, setAll, runs } = setup()
    await warmUp(store, setAll)

    runs.fill(0)
    rtl.act(() => {
      store.dispatch(setOne({ index: 3, v: 42 }))
    })
    // Flush the drain too, so a selector that got queued rather than skipped
    // still shows up in the counts — otherwise over-collecting would look
    // identical to being selective.
    await flushMacrotasks()

    expect(runs[3]).toBeGreaterThan(0)
    const others = runs.filter((_, i) => i !== 3)
    expect(others.every((n) => n === 0)).toBe(true)
    expect(rtl.screen.getByTestId('leaf-3').textContent).toBe('42')
    expect(rtl.screen.getByTestId('leaf-4').textContent).toBe('0')
  })

  it('changing an unread segment re-runs nothing at all', async () => {
    const { store, setAll, bumpOther, runs } = setup()
    await warmUp(store, setAll)

    runs.fill(0)
    rtl.act(() => {
      store.dispatch(bumpOther())
    })
    await flushMacrotasks()

    expect(runs.every((n) => n === 0)).toBe(true)
  })
})

describe('fine tier — the notification pass is interruptible', () => {
  let forceRerender: () => void = () => {}

  const setup = (sliceThreshold?: number) => {
    const { store, setAll } = makeStore()
    const selectors = Array.from(
      { length: N },
      (_, i) => (s: RootState) => s.list[i].v,
    )

    function Leaf({ i }: { i: number }) {
      const v = useSignalSelector(selectors[i])
      return <span data-testid={`leaf-${i}`}>{v}</span>
    }

    function Parent() {
      const [, setTick] = React.useState(0)
      forceRerender = () => setTick((t) => t + 1)
      return (
        <>
          {Array.from({ length: N }, (_, i) => (
            <Leaf key={i} i={i} />
          ))}
        </>
      )
    }

    rtl.render(
      <SignalProvider store={store} sliceThreshold={sliceThreshold}>
        <Parent />
      </SignalProvider>,
    )
    return { store, setAll }
  }

  const warmUp = async (
    store: ReturnType<typeof makeStore>['store'],
    setAll: ReturnType<typeof makeStore>['setAll'],
  ) => {
    rtl.act(() => {
      store.dispatch(setAll(0))
    })
    await flushMacrotasks()
  }

  const textOf = (i: number) =>
    rtl.screen.getByTestId(`leaf-${i}`).textContent

  it('defers a burst of built hooks instead of re-rendering inside dispatch', async () => {
    const { store, setAll } = setup()
    await warmUp(store, setAll)

    // All N hooks are built and all N paths change: above the threshold, so
    // the re-evaluation is queued rather than run inside dispatch. Nothing has
    // re-rendered yet when dispatch returns.
    rtl.act(() => {
      store.dispatch(setAll(5))
    })
    expect(textOf(0)).toBe('0')
    expect(textOf(N - 1)).toBe('0')

    // The drain still gets everyone there (liveness).
    await flushMacrotasks()
    for (let i = 0; i < N; i++) expect(textOf(i)).toBe('5')
  })

  it('a built hook force-rendered mid-drain shows the latest value, not a stale one', async () => {
    const { store, setAll } = setup()
    await warmUp(store, setAll)

    rtl.act(() => {
      store.dispatch(setAll(5))
    })

    // An ancestor re-renders synchronously, before the drain macrotask can
    // run, forcing every leaf to render WHILE its re-evaluation is still
    // queued. This is the tearing window: each leaf must read the state
    // committed now, or built hooks the drain already reached would show a
    // different store value than the ones it hasn't.
    flushSync(() => {
      forceRerender()
    })
    for (let i = 0; i < N; i++) expect(textOf(i)).toBe('5')
  })

  it('a hook queued behind one dispatch picks up a later one when it runs', async () => {
    const { store, setAll } = setup()
    await warmUp(store, setAll)

    // Two dispatches land before the drain runs. Each hook is queued once
    // (deduped by identity), and the single re-evaluation must reflect the
    // LATEST state — not the value at queue time.
    rtl.act(() => {
      store.dispatch(setAll(5))
    })
    rtl.act(() => {
      store.dispatch(setAll(7))
    })

    await flushMacrotasks()
    for (let i = 0; i < N; i++) expect(textOf(i)).toBe('7')
  })

  it('sliceThreshold=Infinity keeps the whole burst inside dispatch (atomic)', async () => {
    const { store, setAll } = setup(Infinity)
    await warmUp(store, setAll)

    rtl.act(() => {
      store.dispatch(setAll(9))
    })
    // No drain flush needed: every hook updated synchronously.
    for (let i = 0; i < N; i++) expect(textOf(i)).toBe('9')
  })

  it('a burst below the threshold still runs inline', async () => {
    const { store, setAll } = setup(N + 1)
    await warmUp(store, setAll)

    rtl.act(() => {
      store.dispatch(setAll(3))
    })
    for (let i = 0; i < N; i++) expect(textOf(i)).toBe('3')
  })
})

describe('detaching a computed on unsubscribe', () => {
  it('an evaluation that reads nothing drops the computed\'s links', () => {
    // The mechanism the hook's detach() relies on. Nothing subscribes to a
    // hook's computed any more, so the signal library never unlinks it on its
    // own — a live path signal would keep an unmounted hook's closure
    // reachable. Re-evaluating with a getter that reads no path signal is what
    // purges those links, and this pins that the library actually does it.
    const version = alienEngine.signal(0)
    const dep = alienEngine.signal(1)
    let detached = false
    let runs = 0
    const computed = alienEngine.computed(() => {
      version.get()
      runs++
      if (detached) return -1
      return dep.get()
    })

    expect(computed.get()).toBe(1)
    expect(runs).toBe(1)

    // Linked: changing the dependency dirties the computed.
    dep.set(2)
    expect(computed.get()).toBe(2)
    expect(runs).toBe(2)

    // Detach: bump the version signal to force one evaluation that reads
    // nothing else.
    detached = true
    version.set(1)
    computed.get()
    expect(runs).toBe(3)

    // The link is gone — the dependency no longer dirties the computed.
    dep.set(3)
    computed.get()
    expect(runs).toBe(3)
  })

  it('an unmounted hook is not notified again', async () => {
    const { store, setOne, setAll } = makeStore()
    let runs = 0
    const selector = (s: RootState) => {
      runs++
      return s.list[0].v
    }

    function Leaf() {
      const v = useSignalSelector(selector)
      return <span data-testid="leaf">{v}</span>
    }

    const view = rtl.render(
      <SignalProvider store={store}>
        <Leaf />
      </SignalProvider>,
    )
    rtl.act(() => {
      store.dispatch(setAll(0))
    })
    await flushMacrotasks()

    view.unmount()
    runs = 0
    rtl.act(() => {
      store.dispatch(setOne({ index: 0, v: 7 }))
    })
    await flushMacrotasks()

    expect(runs).toBe(0)
  })
})

describe('fine tier — edge cases under a deferred drain', () => {
  it('a hook that unmounts while queued is never re-evaluated', async () => {
    const { store, setAll } = makeStore()
    let runs = 0
    const selectors = Array.from({ length: N }, (_, i) => (s: RootState) => {
      runs++
      return s.list[i].v
    })

    function Leaf({ i }: { i: number }) {
      const v = useSignalSelector(selectors[i])
      return <span data-testid={`leaf-${i}`}>{v}</span>
    }

    function Parent({ show }: { show: boolean }) {
      if (!show) return null
      return (
        <>
          {Array.from({ length: N }, (_, i) => (
            <Leaf key={i} i={i} />
          ))}
        </>
      )
    }

    const view = rtl.render(
      <SignalProvider store={store}>
        <Parent show />
      </SignalProvider>,
    )
    rtl.act(() => {
      store.dispatch(setAll(0))
    })
    await flushMacrotasks()

    // Queue all N, then unmount them all before the drain macrotask runs.
    rtl.act(() => {
      store.dispatch(setAll(1))
    })
    runs = 0
    view.rerender(
      <SignalProvider store={store}>
        <Parent show={false} />
      </SignalProvider>,
    )
    await flushMacrotasks()

    expect(runs).toBe(0)
  })

  it('a zombie child queued in a drain does not break the rest of the pass', async () => {
    // The removed row's selector throws when the drain reaches it. That must
    // not abandon the hooks still queued behind it, and the parent
    // re-rendering must dissolve the error rather than surface it.
    const slice = createSlice({
      name: 'z',
      initialState: {
        list: Array.from({ length: N }, (_, i) => ({ id: i, v: 0 })),
      },
      reducers: {
        // Remove one row AND touch every survivor, so the whole set is queued
        // together with the zombie.
        removeAndTouch: (state) => {
          state.list = state.list
            .filter((row) => row.id !== 5)
            .map((row) => ({ ...row, v: row.v + 1 }))
        },
      },
    })
    const store = configureStore({ reducer: slice.reducer })
    type ZState = ReturnType<typeof store.getState>

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    function Row({ id }: { id: number }) {
      // Classic zombie pattern: assumes the row still exists.
      const v = useSignalSelector(
        (s: ZState) => s.list.find((row) => row.id === id)!.v,
      )
      return <span data-testid={`row-${id}`}>{v}</span>
    }

    function List() {
      const ids = useSignalSelector((s: ZState) => s.list.map((r) => r.id))
      return (
        <>
          {ids.map((id) => (
            <Row key={id} id={id} />
          ))}
        </>
      )
    }

    rtl.render(
      <SignalProvider store={store}>
        <List />
      </SignalProvider>,
    )
    rtl.act(() => {
      store.dispatch(slice.actions.removeAndTouch())
    })
    await flushMacrotasks()

    expect(rtl.screen.queryByTestId('row-5')).toBeNull()
    expect(rtl.screen.getByTestId('row-0').textContent).toBe('1')
    expect(rtl.screen.getByTestId(`row-${N - 1}`).textContent).toBe('1')
    consoleSpy.mockRestore()
  })

  it('a dispatch from inside the drain folds into the running pass', async () => {
    const { store, setAll, setOne } = makeStore()
    const selectors = Array.from(
      { length: N },
      (_, i) => (s: RootState) => s.list[i].v,
    )

    let dispatched = false

    function Leaf({ i }: { i: number }) {
      const v = useSignalSelector(selectors[i])
      // The first leaf the drain reaches dispatches again from its commit —
      // re-entering onStateChange while the drain is mid-flight.
      React.useEffect(() => {
        if (v === 5 && !dispatched) {
          dispatched = true
          store.dispatch(setOne({ index: N - 1, v: 99 }))
        }
      }, [v])
      return <span data-testid={`leaf-${i}`}>{v}</span>
    }

    rtl.render(
      <SignalProvider store={store}>
        {Array.from({ length: N }, (_, i) => (
          <Leaf key={i} i={i} />
        ))}
      </SignalProvider>,
    )
    rtl.act(() => {
      store.dispatch(setAll(0))
    })
    await flushMacrotasks()

    rtl.act(() => {
      store.dispatch(setAll(5))
    })
    await flushMacrotasks()
    await flushMacrotasks()

    expect(dispatched).toBe(true)
    // Everyone converged, including the row the re-entrant dispatch changed.
    for (let i = 0; i < N - 1; i++) {
      expect(rtl.screen.getByTestId(`leaf-${i}`).textContent).toBe('5')
    }
    expect(rtl.screen.getByTestId(`leaf-${N - 1}`).textContent).toBe('99')
  })
})
