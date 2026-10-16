import { scheduleCallback } from './scheduler'

// Public `batch` (re-exported from ../exports) now defers to the shared host
// scheduler, so it uses the same single MessageChannel transport as the
// time-sliced notification pass.
export function defaultNoopBatch(callback: () => void): void {
  scheduleCallback(callback)
}

/**
 * @deprecated As of React 18, batching is enabled by default for ReactDOM and React Native.
 * This is now a no-op that immediately runs the callback.
 */
export const batch: typeof defaultNoopBatch = defaultNoopBatch
