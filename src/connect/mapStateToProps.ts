import type { Action, Dispatch } from 'redux'
import { createInvalidArgFactory } from './invalidArgFactory'
import type { MapStateToPropsParam } from './selectorFactory'
import type { InitProxyOptions, WrappedMapToProps } from './wrapMapToProps'
import { wrapMapToPropsConstant, wrapMapToPropsFunc } from './wrapMapToProps'

export function mapStateToPropsFactory<TStateProps, TOwnProps, State>(
  mapStateToProps: MapStateToPropsParam<TStateProps, TOwnProps, State>,
): (
  dispatch: Dispatch<Action<string>>,
  options: InitProxyOptions,
) => WrappedMapToProps {
  return !mapStateToProps
    ? wrapMapToPropsConstant(() => ({}))
    : typeof mapStateToProps === 'function'
      ? // @ts-ignore
        wrapMapToPropsFunc(mapStateToProps, 'mapStateToProps')
      : createInvalidArgFactory(mapStateToProps, 'mapStateToProps')
}
