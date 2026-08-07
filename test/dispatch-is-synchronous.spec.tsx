import { act, render } from '@testing-library/react'
import * as React from 'react'
import { createStore } from 'redux'
import { Provider, useSelector } from '../src/index'

// `test/setup.ts` swaps the global `MessageChannel` for a synchronous stub.
// Restore the real, asynchronous one so this file exercises what a browser
// actually does — which is what the `Test Published Artifact` examples hit.
const SyncMessageChannel = globalThis.MessageChannel

beforeAll(() => {
  // @ts-expect-error - jsdom provides the real implementation
  delete globalThis.MessageChannel
})

afterAll(() => {
  globalThis.MessageChannel = SyncMessageChannel
})

test('a dispatch is reflected in the DOM within the same task', () => {
  const store = createStore((state: number = 0, action: any) =>
    action.type === 'inc' ? state + 1 : state,
  )

  const Counter = () => {
    const value = useSelector((s: number) => s)
    return <div data-testid="value">{value}</div>
  }

  const { getByTestId } = render(
    <Provider store={store}>
      <Counter />
    </Provider>,
  )

  expect(getByTestId('value').textContent).toBe('0')

  act(() => {
    store.dispatch({ type: 'inc' })
  })

  // Playwright reads the DOM with `timeout: 0` right after the click, so this
  // is the assertion the CI examples make.
  expect(getByTestId('value').textContent).toBe('1')
})
