export type PathKey = string // dot-joined: "todos.0.text", "counters.counter1.value"

/**
 * A subscriber — one per `useSignalSelector` hook — that the provider's two
 * tiers index and notify.
 *
 * The same object is registered in the coarse segment index while its deep
 * dependency graph is unbuilt, and in the fine path index once built. One
 * object for both tiers means the provider's notification queue is
 * homogeneous and dedupes by identity across them: a hook can't be queued
 * twice, whichever tier collected it.
 */
export interface HookSub {
  /** Top-level state segments the selector reads — the coarse tier's key. */
  segments: Set<string>
  /**
   * Path keys the selector read on its last tracked evaluation — the fine
   * tier's key. Owned by `DepIndex` once registered; subscribers hand a fresh
   * set to `replace()` rather than mutating this one.
   */
  deps: Set<PathKey>
  /**
   * Re-evaluate the selector against the latest committed state and notify
   * React if the result changed, building the deep dependency graph first if
   * this is the hook's first touch.
   *
   * Self-guarding: a subscriber that unsubscribed while queued in a deferred
   * drain does nothing.
   */
  notify(): void
}

export interface ReactiveSignal<T> {
  get(): T
  set(value: T): void
}

export interface ReactiveComputed<T> {
  get(): T
}

export interface SignalEngine {
  signal<T>(value: T): ReactiveSignal<T>
  computed<T>(fn: () => T): ReactiveComputed<T>
  /** Create an effect. Returns a dispose function that stops it. */
  effect(fn: () => void): () => void
  batch(fn: () => void): void
  createScope(): SignalScope
}

export interface SignalScope {
  run<T>(fn: () => T): T
  stop(): void
}
