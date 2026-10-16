import type { Context } from 'react'
import { React } from '../utils/react'
import type { Action, Store, UnknownAction } from 'redux'
import type { Subscription } from '../utils/Subscription'
import type { ProviderProps } from './Provider'

/**
 * Receives the first read of each top-level key of the store state made by a
 * `useSelector` selector. Reported once per key for each subscribing selector,
 * possibly during render, so it must not trigger React state updates.
 *
 * @param key - The top-level state key that was read.
 * @param selector - The selector passed to `useSelector` that read it.
 */
export type StateAccessListener = (key: string, selector: Function) => void

export interface ReactReduxContextValue<
  SS = any,
  A extends Action<string> = UnknownAction,
> extends Pick<ProviderProps, 'stabilityCheck' | 'identityFunctionCheck'> {
  store: Store<SS, A>
  subscription: Subscription
  getServerState?: () => SS

  /**
   * See {@linkcode StateAccessListener}. A nested
   * `ReactReduxContext.Provider` may override it for a subtree by spreading the
   * parent context value, keeping its `store` and `subscription`.
   */
  onStateAccess?: StateAccessListener

  /**
   * `true` when `useSelector` supports {@linkcode onStateAccess}, so consumers
   * can feature-detect it instead of tracking state reads themselves.
   */
  stateAccessTracking?: boolean
}

const ContextKey = /* @__PURE__ */ Symbol.for(`react-redux-context`)
const gT: {
  [ContextKey]?: Map<
    typeof React.createContext,
    Context<ReactReduxContextValue | null>
  >
} = (
  typeof globalThis !== 'undefined'
    ? globalThis
    : /* fall back to a per-module scope (pre-8.1 behaviour) if `globalThis` is not available */ {}
) as any

function getContext(): Context<ReactReduxContextValue | null> {
  if (!React.createContext) return {} as any

  const contextMap = (gT[ContextKey] ??= new Map<
    typeof React.createContext,
    Context<ReactReduxContextValue | null>
  >())
  let realContext = contextMap.get(React.createContext)
  if (!realContext) {
    realContext = React.createContext<ReactReduxContextValue | null>(
      null as any,
    )
    if (process.env.NODE_ENV !== 'production') {
      realContext.displayName = 'ReactRedux'
    }
    contextMap.set(React.createContext, realContext)
  }
  return realContext
}

export const ReactReduxContext: Context<ReactReduxContextValue<
  any,
  UnknownAction
> | null> = /*#__PURE__*/ getContext()

export type ReactReduxContextInstance = typeof ReactReduxContext
