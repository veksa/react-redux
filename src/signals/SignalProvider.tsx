import type { Context } from 'react'
import { React } from '../utils/react'
import type { Action, UnknownAction } from 'redux'
import type { ReactReduxContextValue } from '../components/Context'
import { ReactReduxContext } from '../components/Context'
import type { ProviderProps } from '../components/Provider'
import { createSubscription } from '../utils/Subscription'
import { useIsomorphicLayoutEffect } from '../utils/useIsomorphicLayoutEffect'
import type { SignalContextValue } from './context'
import { createPathSignalRegistry } from './pathSignalRegistry'
import { reconcileState } from './diff'
import { changedSegments } from './coarseSegments'
import { scheduleCallback, shouldYield } from './scheduler'

import { alienEngine } from './engine'
import type { HookSub, SignalEngine } from './types'

// Default for SignalProvider's `sliceThreshold`: above this many affected
// hooks in a single dispatch, the notification pass is time-sliced
// (responsive, but updates stagger); below it, it runs inline (atomic — every
// hook in one synchronous pass). Override via the prop.
const DEFAULT_SLICE_THRESHOLD = 64

export interface SignalProviderProps<
  A extends Action<string> = UnknownAction,
  S = unknown,
> extends ProviderProps<A, S> {
  engine?: SignalEngine
  /**
   * Number of hooks a single dispatch may notify before the pass is
   * time-sliced across macrotasks (keeps a huge burst from blocking a frame,
   * at the cost of updates staggering during it). Below it the pass runs
   * inline in one synchronous, atomic step. Default `64`. Set to `Infinity` to
   * always run inline (atomic, may block on a large burst); set to `0` to
   * always slice.
   *
   * Slicing never risks a stale render: a hook React renders reads the latest
   * committed state through `getSnapshot` whether or not the drain has reached
   * it yet. What it defers is only the re-render a changed value triggers.
   */
  sliceThreshold?: number
}

export function SignalProvider<
  S extends object,
  A extends Action = UnknownAction,
>(providerProps: SignalProviderProps<A, S>) {
  const {
    children,
    context,
    serverState,
    store,
    engine = alienEngine,
    sliceThreshold = DEFAULT_SLICE_THRESHOLD,
  } = providerProps

  // Create signal registry once (lazy init via ref)
  const registryRef = React.useRef(createPathSignalRegistry(engine))
  const registry = registryRef.current

  // Track previous state for signal diffing
  const prevStateRef = React.useRef<S>(store.getState())

  // Build context value: standard ReactReduxContextValue + signal fields
  const contextValue = React.useMemo(() => {
    const subscription = createSubscription(store)

    const baseContextValue: SignalContextValue<S, A> = {
      store,
      subscription,
      getServerState: serverState ? () => serverState : undefined,
      registry,
      engine,
    }

    if (process.env.NODE_ENV === 'production') {
      return baseContextValue
    } else {
      const { identityFunctionCheck = 'once', stabilityCheck = 'once' } =
        providerProps

      return Object.assign(baseContextValue, {
        stabilityCheck,
        identityFunctionCheck,
      })
    }
  }, [store, serverState, registry, engine])

  const previousState = React.useMemo(() => store.getState(), [store])

  // Standard Provider subscription logic (from components/Provider.tsx)
  // + signal diff on each dispatch
  useIsomorphicLayoutEffect(() => {
    const { subscription } = contextValue

    // Gated, time-sliced drain of the hooks a dispatch affected. A large burst
    // (every hook reading the one slice that just changed, a dense update
    // across a big list) is chunked across macrotasks so it never blocks a
    // frame; a small one runs inline. Deferring a hook only delays its
    // re-render — the value is read fresh from committed state whenever it
    // runs, and `getSnapshot` keeps a hook rendered before then consistent.
    let pending: HookSub[] = []
    const pendingSet = new Set<HookSub>()
    let draining = false
    let disposed = false

    const drainChunk = (): void => {
      if (disposed) return
      let sub = pending.pop()
      while (sub !== undefined) {
        pendingSet.delete(sub)
        sub.notify()
        if (pending.length > 0 && shouldYield()) break
        sub = pending.pop()
      }
      if (pending.length > 0) {
        scheduleCallback(drainChunk)
      } else {
        draining = false
      }
    }

    const notifyAffected = (affected: Set<HookSub>): void => {
      if (!draining && affected.size < sliceThreshold) {
        for (const sub of affected) sub.notify()
        return
      }
      for (const sub of affected) {
        if (!pendingSet.has(sub)) {
          pendingSet.add(sub)
          pending.push(sub)
          // Drop an unbuilt sub from the segment index as soon as it's queued,
          // so a dispatch arriving mid-drain doesn't re-collect the whole
          // backlog of already-queued subs (O(unbuilt) per tick during a large
          // first-touch drain). Safe: the queued notify reads the latest
          // committed state when it runs, so any further change to this sub's
          // segments while it waits is still picked up. A no-op for built subs
          // — they left the coarse index on their first touch.
          registry.segmentIndex.unregister(sub)
        }
      }
      if (!draining) {
        draining = true
        scheduleCallback(drainChunk)
      }
    }

    subscription.onStateChange = () => {
      // Run signal diff BEFORE notifying nested subs, so computed values
      // are up-to-date when useSelector/useSignalSelector read them
      const prev = prevStateRef.current
      const next = store.getState()
      prevStateRef.current = next

      // Pure change DETECTION: walks only the tracked parts of the tree,
      // comparing references and recording which paths fired. It runs no
      // selector — nothing subscribes to the path signals, so there is no
      // propagation to flush.
      reconcileState(prev, next, registry, engine)

      const affected = new Set<HookSub>()

      // Fine tier: the built hooks that read a path this dispatch changed.
      // O(changed paths × subscribers per path), still no evaluation. Drain
      // the recorded paths before running anything — a notification can
      // dispatch, and that reconcile needs a clean set.
      registry.depIndex.collect(registry.changedPaths, affected)
      registry.changedPaths.clear()

      // Coarse tier: hooks whose deep graph isn't built yet and whose
      // top-level segment changed. Built hooks are covered by the fine index
      // above and have dropped out of this one, so this only ever adds the
      // lazy ones.
      const changed = changedSegments(
        prev as Record<string, unknown>,
        next as Record<string, unknown>,
      )
      if (changed.length > 0) {
        registry.segmentIndex.collect(changed, affected)
      }

      if (affected.size > 0) notifyAffected(affected)

      subscription.notifyNestedSubs()
    }
    subscription.trySubscribe()

    if (previousState !== store.getState()) {
      subscription.notifyNestedSubs()
    }
    return () => {
      disposed = true
      pending = []
      pendingSet.clear()
      subscription.tryUnsubscribe()
      subscription.onStateChange = undefined
    }
  }, [contextValue, previousState, sliceThreshold])

  const Context = (context || ReactReduxContext) as Context<
    ReactReduxContextValue<S, A> | null
  >

  return (
    <Context.Provider value={contextValue as ReactReduxContextValue<S, A>}>
      {children}
    </Context.Provider>
  )
}
