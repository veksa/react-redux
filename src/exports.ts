import { connect, legacy_connect } from './components/connect'
export type {
  Connect,
  ConnectProps,
  ConnectedProps,
} from './components/connect'

import { shallowEqual } from './utils/shallowEqual'

import { Provider } from './components/Provider'
import { batch } from './utils/batch'

export { ReactReduxContext } from './components/Context'
export type { ReactReduxContextValue } from './components/Context'

export type { ProviderProps } from './components/Provider'

export type {
  MapDispatchToProps,
  MapDispatchToPropsFactory,
  MapDispatchToPropsFunction,
  MapDispatchToPropsNonObject,
  MapDispatchToPropsParam,
  MapStateToProps,
  MapStateToPropsFactory,
  MapStateToPropsParam,
  MergeProps,
  Selector,
  SelectorFactory,
} from './connect/selectorFactory'

export { createDispatchHook, useDispatch } from './hooks/useDispatch'
export type { UseDispatch } from './hooks/useDispatch'

export { createSelectorHook, useSelector } from './hooks/useSelector'
export type { UseSelector } from './hooks/useSelector'

export { createStoreHook, useStore } from './hooks/useStore'
export type { UseStore } from './hooks/useStore'

export type { Subscription } from './utils/Subscription'

export * from './types'

export { Provider, batch, connect, legacy_connect, shallowEqual }
