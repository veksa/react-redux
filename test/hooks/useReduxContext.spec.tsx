import {
  createReduxContextHook,
  useReduxContext,
} from '@internal/hooks/useReduxContext'
import { renderHook } from '@testing-library/react-hooks'
import { createContext } from 'react'
import type { ReactReduxContextValue } from 'react-redux'

describe('React', () => {
  describe('hooks', () => {
    describe('useReduxContext', () => {
      it('throws if component is not wrapped in provider', () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

        const { result } = renderHook(() => useReduxContext())

        expect(result.error?.message).toMatch(
          /could not find react-redux context value/,
        )

        spy.mockRestore()
      })
    })
    describe('createReduxContextHook', () => {
      it('throws if component is not wrapped in provider', () => {
        const customContext = createContext<ReactReduxContextValue | null>(null)
        const useCustomReduxContext = createReduxContextHook(customContext)
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

        const { result } = renderHook(() => useCustomReduxContext())

        expect(result.error?.message).toMatch(
          /could not find react-redux context value/,
        )

        spy.mockRestore()
      })
    })
  })
})
