import { scheduleCallback } from './scheduler'

// Public `batch` (re-exported from ../exports) now defers to the shared host
// scheduler, so it uses the same single MessageChannel transport as the
// time-sliced notification pass.
export function defaultNoopBatch(callback: () => void) {
  scheduleCallback(callback)
}
