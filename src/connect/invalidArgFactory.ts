import type { Action, Dispatch } from 'redux'

export function createInvalidArgFactory(
  arg: unknown,
  name: string,
): (
  dispatch: Dispatch<Action<string>>,
  options: { readonly wrappedComponentName: string },
) => never {
  return (
    dispatch: Dispatch<Action<string>>,
    options: { readonly wrappedComponentName: string },
  ) => {
    throw new Error(
      `Invalid value of type ${typeof arg} for ${name} argument when connecting component ${
        options.wrappedComponentName
      }.`,
    )
  }
}
