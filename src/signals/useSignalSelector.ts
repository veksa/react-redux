import type { Context } from 'react'
import { React } from '../utils/react'
import type {
  DevModeChecks,
  UseSelectorOptions,
} from '../hooks/useSelector'
import type { ReactReduxContextValue } from '../components/Context'
import type { EqualityFn } from '../types'
import type { HookSub, PathKey } from './types'
import type { SignalContextValue } from './context'
import {
  createSignalContextHook,
  ReactReduxContext,
  useSignalContext,
} from './context'
import {
  createTrackingProxy,
  getProxyPath,
  type LeafObjectTracker,
} from './trackingProxy'
import { untrackResult } from './untrack'
import { recordSegments } from './coarseSegments'

const { useRef, useMemo, useEffect, useSyncExternalStore, useDebugValue } =
  React

const refEquality: EqualityFn<any> = Object.is

// Returned by an evaluation whose selector threw. A unique sentinel, never a
// real result, so a caller that forgets to check `pendingError` fails loudly
// instead of quietly adopting a plausible-looking value.
const SELECTOR_THREW = Symbol('selector threw') as unknown


/**
 * A React hook that selects state from a Redux store using signal-based
 * dependency tracking. Only re-renders when the selected value actually
 * changes, with O(k) selectivity where k = number of affected selectors.
 *
 * Must be used within a <SignalProvider>.
 * @param selector - Function that extracts a value from the store state
 * @param equalityFnOrOptions - Equality function, or an options object
 *   with `equalityFn` and `devModeChecks` (same shape as stock
 *   `useSelector`)
 * @param useBoundSignalContext - Internal: the context hook to read the
 *   signal context from. Bound by `createSignalSelectorHook`.
 * @returns The selected value
 */
const useSignalSelectorImpl = <S, R>(
  selector: (state: S) => R,
  equalityFnOrOptions: EqualityFn<R> | UseSelectorOptions<R> = {},
  useBoundSignalContext: <SS>() => SignalContextValue<SS> = useSignalContext,
): R => {
  const { equalityFn = refEquality as EqualityFn<R>, devModeChecks = {} } =
    typeof equalityFnOrOptions === 'function'
      ? { equalityFn: equalityFnOrOptions, devModeChecks: {} }
      : equalityFnOrOptions

  if (process.env.NODE_ENV !== 'production') {
    if (!selector) {
      throw new Error(`You must pass a selector to useSignalSelector`)
    }
    if (typeof selector !== 'function') {
      throw new Error(
        `You must pass a function as a selector to useSignalSelector`,
      )
    }
    if (typeof equalityFn !== 'function') {
      throw new Error(
        `You must pass a function as an equality function to useSignalSelector`,
      )
    }
  }

  const reduxContext = useBoundSignalContext<S>()
  const { store, registry, engine } = reduxContext

  // Track latest selector/equalityFn via refs. Updated during render
  // (idempotent ref writes, same approach as React's
  // useSyncExternalStoreWithSelector) so a selector closing over changed
  // props is applied in THIS render, not a layout effect later.
  const selectorRef = useRef(selector)
  const equalityFnRef = useRef(equalityFn)
  equalityFnRef.current = equalityFn

  // Dev-mode check settings. Per-hook `devModeChecks` overrides merge over
  // the Provider-level defaults, matching stock useSelector. Kept in refs
  // (idempotent render-phase writes) so the bridge closure always reads
  // the latest values.
  const devModeChecksRef = useRef<Partial<DevModeChecks>>(devModeChecks)
  devModeChecksRef.current = devModeChecks
  const contextRef = useRef(reduxContext)
  contextRef.current = reduxContext

  // Create the signal bridge once (stable across renders)
  const bridge = useMemo(() => {
    let currentResult: R
    let version = 0
    let notifyReact: (() => void) | null = null
    // Lazy deep-graph state: the tracked evaluation that establishes path
    // signals and registers this hook in the fine index runs on the first
    // coarse hit (a dispatch that changed one of the hook's segments), not at
    // mount — so mounting N hooks doesn't build N deep graphs up front.
    let built = false
    // Set while unsubscribed so the next evaluation reads no path signal —
    // see detach().
    let detached = false
    // The store state `currentResult` was last computed from. Lets getSnapshot
    // recompute from the latest state (only when the state ref changed, so the
    // snapshot stays referentially stable) — see getSnapshot for why this is
    // what keeps a deferred re-evaluation tear-free.
    let lastSnapshotState: unknown = null
    // Set when the selector threw during a re-evaluation (classic zombie
    // child: an entity was removed while a component selecting it is still
    // mounted). getSnapshot retries and rethrows if it persists.
    let pendingError: unknown = null

    // Create a computed that runs the selector through a tracking proxy.
    // This establishes signal dependencies on the paths the selector reads.
    //
    // Intermediate object traversals don't create signal dependencies (to avoid
    // "false sharing" where siblings cause re-runs). Only leaf primitive reads
    // create deps automatically. If the selector returns a proxy (object result),
    // we explicitly read that object's signal to establish the terminal dependency.
    // Track leaf object accesses for identity comparison support.
    // Objects read by the selector but never traversed deeper are
    // "leaf objects" — their identity matters (e.g., `a === b`).
    // Reused across evaluations (cleared at the start of each) — a
    // computed never re-enters its own evaluation, so this is safe and
    // avoids two allocations per eval.
    const leafTracker: LeafObjectTracker = {
      accessedObjects: new Map(),
      traversedPaths: new Set(),
    }

    // Bumped when the component re-renders with a different selector
    // function (e.g., an inline selector closing over changed props).
    // The computed reads it, so bumping forces a re-evaluation with the
    // new closure — otherwise the selector would keep returning the old
    // closure's result until an unrelated store change fired a signal.
    const selectorVersionSignal = engine.signal(0)

    // One subscriber object per hook, indexed by the coarse tier while the
    // deep graph is unbuilt and by the fine tier once built. `notify` is the
    // provider drain's single entry point for both.
    const sub: HookSub = {
      segments: new Set<string>(),
      deps: new Set<PathKey>(),
      notify(): void {
        if (notifyReact === null) {
          // Unsubscribed while queued in a deferred drain — don't build a
          // graph for, or notify, a dead hook.
          return
        }

        if (!built) {
          // First touch: upgrade to the fine tier. The tracked evaluation
          // below registers path signals and this hook's dep edges, and
          // comparing its result against the value we were carrying surfaces
          // this dispatch's change — so no separate non-notifying first pass
          // is needed. Now driven by the fine index; drop the coarse
          // registration so it isn't hit again.
          built = true
          registry.segmentIndex.unregister(sub)
        }

        const newValue = recomputeTracked()

        if (pendingError !== null) {
          // The evaluation threw (newValue is the SELECTOR_THREW sentinel —
          // never adopt it). Notify React so getSnapshot can retry and
          // surface or dissolve the error.
          notifyReact()
          return
        }

        // Apply user's equality function.
        if (!equalityFnRef.current(currentResult, newValue)) {
          currentResult = newValue
          version++
          notifyReact()
        }
      },
    }

    // Re-run the selector through the tracking proxy against the latest
    // committed state, re-capturing the exact path keys it reads into the fine
    // index. Bumping the version signal is what forces the re-evaluation:
    // nothing subscribes to the computed, so a plain `.get()` could hand back
    // a cached value. On a selector error the computed records pendingError
    // and yields the SELECTOR_THREW sentinel, which must never replace the
    // last good result.
    const recomputeTracked = (): R => {
      const nextDeps = new Set<PathKey>()
      const previousDeps = registry.captureDeps(nextDeps)
      try {
        selectorVersionSignal.set(selectorVersionSignal.get() + 1)
        const value = selectorComputed.get()
        if (pendingError === null) {
          // This run used the latest committed state, so getSnapshot's raw
          // recompute for the same state would be redundant.
          lastSnapshotState = store.getState()
        }
        return value
      } finally {
        registry.captureDeps(previousDeps)
        registry.depIndex.replace(sub, nextDeps)
      }
    }

    // Run the selector against raw state — no tracking proxy, no path signals,
    // no dependency edges. What a hook uses wherever it only needs the value:
    // the mount seed, and getSnapshot's latest-state recompute. Yields the
    // same result as the tracked run (`untrackResult` is a no-op on already-raw
    // state) at a fraction of the cost.
    const recomputeRaw = (): R => {
      pendingError = null
      try {
        const state = store.getState()
        const value = untrackResult(selectorRef.current(state as S))
        lastSnapshotState = state
        return value
      } catch (e) {
        pendingError = e
        return SELECTOR_THREW as R
      }
    }

    // Re-evaluate and adopt the result WITHOUT notifying React — for callers
    // already inside a render that will read getSnapshot in the same pass. A
    // built hook re-runs tracked (its dep edges must stay current); an unbuilt
    // one has no edges to maintain, so the raw run is both cheaper and what
    // its getSnapshot would do anyway.
    const recomputeInPlace = (): void => {
      const value = built ? recomputeTracked() : recomputeRaw()
      if (pendingError === null) {
        currentResult = value
      }
    }

    // Break the computed's links to the registry's path signals. Nothing
    // subscribes to the computed any more, so the signal library has no moment
    // of its own to unlink it — and a live path signal holding a link back to
    // an unmounted hook's computed would keep that hook's whole closure
    // reachable. One evaluation that reads nothing purges the dep list.
    const detach = (): void => {
      detached = true
      selectorVersionSignal.set(selectorVersionSignal.get() + 1)
      selectorComputed.get()
    }

    const setSelector = (nextSelector: (state: S) => R): void => {
      selectorRef.current = nextSelector
      // Recompute in place: this runs during render, and getSnapshot
      // picks up the fresh value in the same pass. Scheduling a
      // re-render here would loop forever for selectors that return a
      // new reference on every run.
      recomputeInPlace()
      if (pendingError !== null) {
        // The new closure threw — surface it in this render.
        throw pendingError
      }
    }

    // Dev-mode selector checks (stability / identity function), matching
    // stock useSelector. They run inside the computed because that is the
    // only place the selector executes. `firstRun` is per hook instance:
    // 'once' means literally once, on the first evaluation — a later
    // render-phase selector swap does NOT re-arm it.
    let firstRun = true
    const runDevModeChecks = (selected: R, proxy: S): void => {
      const { stabilityCheck = 'once', identityFunctionCheck = 'once' } =
        contextRef.current
      const finalChecks: DevModeChecks = {
        stabilityCheck,
        identityFunctionCheck,
        ...devModeChecksRef.current,
      }

      if (
        finalChecks.stabilityCheck === 'always' ||
        (finalChecks.stabilityCheck === 'once' && firstRun)
      ) {
        // Re-running the selector against the same proxy registers the
        // same dependencies (idempotent) and returns proxy-consistent
        // values, so === / shallowEqual comparisons behave correctly.
        const toCompare = selectorRef.current(proxy)
        if (!equalityFnRef.current(selected, toCompare)) {
          let stack: string | undefined = undefined
          try {
            throw new Error()
          } catch (e) {
            stack = (e as Error).stack
          }
          console.warn(
            'Selector ' +
              (selectorRef.current.name || 'unknown') +
              ' returned a different result when called with the same parameters. This can lead to unnecessary rerenders.' +
              '\nSelectors that return a new reference (such as an object or an array) should be memoized: https://redux.js.org/usage/deriving-data-selectors#optimizing-selectors-with-memoization',
            { selected, selected2: toCompare, stack },
          )
        }
      }

      if (
        finalChecks.identityFunctionCheck === 'always' ||
        (finalChecks.identityFunctionCheck === 'once' && firstRun)
      ) {
        if ((selected as unknown) === proxy) {
          let stack: string | undefined = undefined
          try {
            throw new Error()
          } catch (e) {
            stack = (e as Error).stack
          }
          console.warn(
            'Selector ' +
              (selectorRef.current.name || 'unknown') +
              ' returned the root state when called. With useSignalSelector this component will NEVER re-render, because signal dependencies are only created for the specific paths a selector reads — and this selector read none.' +
              '\nSelect the smallest values your component needs instead of the entire state object.',
            { stack },
          )
        }
      }

      firstRun = false
    }

    const selectorComputed = engine.computed(() => {
      selectorVersionSignal.get()
      if (detached) {
        // Unsubscribed: read no path signal, so the signal library drops every
        // link from this computed (see detach). The value is never used.
        return currentResult
      }
      // pendingError reflects the LAST evaluation: a successful re-run
      // clears an earlier error.
      pendingError = null
      try {
        const state = store.getState() as S & object

        leafTracker.accessedObjects.clear()
        leafTracker.traversedPaths.clear()

        const proxy = createTrackingProxy(
          state,
          '',
          registry,
          registry.proxyCache,
          leafTracker,
        )
        const result = selectorRef.current(proxy as S)

        if (process.env.NODE_ENV !== 'production') {
          runDevModeChecks(result, proxy as S)
        }

        // If the selector returned a tracking proxy (object), explicitly
        // read its signal to establish a reactive dependency on that path.
        const proxyPath = getProxyPath(result)
        if (proxyPath !== undefined) {
          registry.getOrCreate(proxyPath, result).get()
        }

        // Read version signals for leaf objects — objects that were accessed
        // but never had their properties read. These are used for identity
        // comparison (===) and need their ref-change signals tracked.
        for (const [objPath, rawValue] of leafTracker.accessedObjects) {
          if (!leafTracker.traversedPaths.has(objPath)) {
            // This object was read but never traversed — it's a leaf.
            // Read its version signal to track identity changes.
            // Skip root path since root changes every dispatch.
            if (objPath !== '') {
              registry.getOrCreate(objPath, rawValue).get()
            }
          }
        }

        // Strip tracking proxies before the result crosses into React.
        // Must run AFTER the dependency reads above (they need the proxies
        // in hand). Everything downstream — equalityFn, getSnapshot,
        // components, dispatch payloads — sees only raw state.
        return untrackResult(result)
      } catch (e) {
        // The selector threw — typically a zombie child whose entity was
        // removed in the same dispatch that will unmount it. The error
        // CANNOT propagate from here: this evaluation runs inside the
        // provider's notification drain, so an uncaught throw would escape
        // `dispatch` (or the drain's macrotask) and abandon every hook still
        // queued behind this one. Record it and yield the sentinel; notify()
        // tells React and getSnapshot re-evaluates — if a parent unmounts this
        // component first the error dissolves, otherwise it rethrows into the
        // render where an error boundary owns it (matching stock useSelector
        // under React's useSyncExternalStore).
        pendingError = e
        return SELECTOR_THREW as R
      }
    })

    // MOUNT OPT: seed the first-render value with a cheap UNTRACKED run of
    // the selector against raw state, instead of the eager tracked
    // `selectorComputed.get()`. Building the tracking proxy + registering
    // path signals (the expensive part) is deferred to this hook's first
    // notify(), which the provider invokes off the render-blocking path. The
    // raw run yields the same value, so the first-render snapshot is
    // unchanged; the dependency graph is established lazily. A selector that
    // throws deterministically still throws here, during render (stock parity).
    currentResult = recomputeRaw()
    if (pendingError !== null) {
      throw pendingError
    }

    if (process.env.NODE_ENV !== 'production') {
      // Dev-mode selector checks normally ride the computed's first eval,
      // which is now deferred to the first coarse hit. Run them here at mount
      // so their timing/frequency ('once' vs 'always') is unchanged. They
      // use raw state — the stability re-run and identity check don't need
      // the tracking proxy — and consume `firstRun`, so the later computed
      // eval only re-checks under 'always'.
      runDevModeChecks(currentResult, store.getState() as S)
    }

    return {
      subscribe(onStoreChange: () => void): () => void {
        notifyReact = onStoreChange
        detached = false

        // Record the coarse top-level segments this selector reads. Sound for
        // immutable state: if none of them changed by reference, the selector
        // result cannot have changed, so the hook needs no update.
        sub.segments = recordSegments(
          store.getState() as object,
          selectorRef.current as (s: object) => unknown,
        )

        if (sub.segments.size === 0) {
          // No discrete top-level segment (identity selector, key
          // enumeration, …): the coarse tier can't gate it, so nothing would
          // ever trigger the first touch. Build the deep graph eagerly
          // instead, which registers whatever fine-tier dependencies the
          // selector does have. No notify — the value we just seeded is
          // already current.
          built = true
          recomputeTracked()
        } else {
          // Defer the deep graph: register in the segment index and build on
          // the first dispatch that changes one of these segments.
          registry.segmentIndex.register(sub)
        }

        return () => {
          notifyReact = null
          registry.segmentIndex.unregister(sub)
          registry.depIndex.remove(sub)
          detach()
          built = false
        }
      },

      getSnapshot(): R {
        if (pendingError !== null) {
          // A previous evaluation threw. Retry against current state:
          // the situation may have resolved (entity restored, or this is
          // a fresh render pass after the parent re-rendered). Clear
          // first — the retry re-sets it if the selector still
          // throws. On rethrow, LEAVE pendingError set so the next
          // getSnapshot (React retries during render after a
          // subscription-phase throw) re-evaluates instead of returning
          // a stale value.
          pendingError = null
          recomputeInPlace()
          if (pendingError !== null) {
            throw pendingError
          }
        }

        // Recompute from the LATEST committed state whenever it changed (skip
        // when the state ref is unchanged, so the snapshot stays referentially
        // stable for useSyncExternalStore). Behaves exactly like stock
        // useSelector, and it is what makes deferring re-evaluation safe:
        // whatever React renders reflects the state committed NOW, whether or
        // not the drain has reached this hook yet. Without it a hook an
        // ancestor force-renders mid-drain would paint a stale value next to
        // siblings the drain already reached — the same store, two values.
        //
        // Unconditional, not just while unbuilt: once notification is
        // deferred, `currentResult` isn't guaranteed fresh for built hooks
        // either. The cost is one untracked selector run per state change per
        // hook React actually renders — hooks nobody renders pay nothing.
        const state = store.getState()
        if (state !== lastSnapshotState) {
          const fresh = recomputeRaw()
          if (pendingError !== null) {
            throw pendingError
          }
          if (!equalityFnRef.current(currentResult, fresh)) {
            currentResult = fresh
          }
        }

        return currentResult
      },

      setSelector,
    }
  }, [store, registry, engine])

  // Render-phase selector swap: if this render brought a different
  // selector function (inline selector closing over changed props),
  // re-evaluate now so getSnapshot returns the new closure's value in
  // this same render.
  if (selectorRef.current !== selector) {
    bridge.setSelector(selector)
  }

  // Cleanup scope on unmount
  useEffect(() => {
    return () => {
      // bridge.subscribe's cleanup deregisters and detaches the hook
    }
  }, [bridge])

  // getSnapshot doubles as getServerSnapshot: the mount seed already ran
  // during useMemo, so SSR renders the current selected value.
  const selectedState = useSyncExternalStore(
    bridge.subscribe,
    bridge.getSnapshot,
    bridge.getSnapshot,
  )

  useDebugValue(selectedState)

  return selectedState
}

/**
 * The signal-based `useSignalSelector` hook, including the `withTypes`
 * helper for creating a pre-typed version:
 *
 * ```ts
 * export const useAppSignalSelector = useSignalSelector.withTypes<RootState>()
 * ```
 */
export interface UseSignalSelector<StateType = unknown> {
  <TState extends StateType = StateType, Selected = unknown>(
    selector: (state: TState) => Selected,
    equalityFnOrOptions?:
      | EqualityFn<NoInfer<Selected>>
      | UseSelectorOptions<NoInfer<Selected>>,
  ): Selected

  withTypes: <
    OverrideStateType extends StateType,
  >() => UseSignalSelector<OverrideStateType>
}

/**
 * Hook factory, which creates a `useSignalSelector` hook bound to a given
 * context. Mirrors stock `createSelectorHook`.
 *
 * The context must be provided by a `<SignalProvider context={...}>` —
 * the returned hook validates that the context value carries the signal
 * registry and engine.
 *
 * @param context - Context passed to your `<SignalProvider>`.
 * @returns A `useSignalSelector` hook bound to the given context.
 */
export function createSignalSelectorHook(
  context: Context<ReactReduxContextValue<
    any,
    any
  > | null> = ReactReduxContext,
): UseSignalSelector {
  const useBoundSignalContext =
    context === ReactReduxContext
      ? useSignalContext
      : createSignalContextHook(context)

  const useSignalSelectorBound = <S, R>(
    selector: (state: S) => R,
    equalityFnOrOptions: EqualityFn<R> | UseSelectorOptions<R> = {},
  ): R =>
    useSignalSelectorImpl(selector, equalityFnOrOptions, useBoundSignalContext)

  const boundHook = Object.assign(useSignalSelectorBound, {
    withTypes: () => boundHook,
  }) as UseSignalSelector

  return boundHook
}

export const useSignalSelector = /* @__PURE__ */ createSignalSelectorHook()
