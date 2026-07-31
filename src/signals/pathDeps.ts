// Fine (per-path) subscriber index — the precise tier behind the coarse
// segment index.
//
// The coarse index answers "which hooks could this dispatch have affected?"
// from top-level segments alone. This one answers it exactly, keyed by the
// full path keys a selector actually read: a change at
// `rows.{id:7}.price` yields the one hook that read that price, so a dispatch
// costs O(changed paths) instead of O(subscribers).
//
// It exists because the signal library's own effect propagation can't be
// deferred: an effect only re-runs by re-reading its dependencies, and
// re-reading a computed re-evaluates the selector on the spot — synchronously,
// inside `dispatch`. Owning the inverted index lets the provider decide *when*
// each affected hook re-evaluates, so a huge dispatch can be time-sliced
// instead of blocking the frame. The path keys are the same ones the library
// would have keyed on, so no precision is lost.

import type { HookSub, PathKey } from './types'

/**
 * Inverted index mapping a path key to the subscribers that read it.
 *
 * Unlike the coarse `SegmentIndex`, edges change on every evaluation (a
 * selector's dependencies shift as state and props change), so the index owns
 * the incremental diffing — see `replace`.
 */
export class DepIndex {
  private readonly byPath = new Map<PathKey, Set<HookSub>>()

  /**
   * Point `sub.deps` at `next`, touching only the edges that actually differ.
   * O(|next| + |sub.deps|) — the same order as the evaluation that produced
   * `next`, so maintaining the index never dominates re-evaluating.
   * @param sub - The subscriber whose dependencies were just re-captured
   * @param next - The path keys its latest evaluation read
   * @returns void
   */
  replace(sub: HookSub, next: Set<PathKey>): void {
    const prev = sub.deps
    for (const path of next) {
      if (!prev.has(path)) this.addEdge(path, sub)
    }
    for (const path of prev) {
      if (!next.has(path)) this.removeEdge(path, sub)
    }
    sub.deps = next
  }

  /**
   * Drop every edge for `sub` and empty its dependency set. Called when a
   * hook unsubscribes.
   * @param sub - The subscriber to remove
   * @returns void
   */
  remove(sub: HookSub): void {
    for (const path of sub.deps) this.removeEdge(path, sub)
    sub.deps.clear()
  }

  /**
   * Add every subscriber of any changed path into `out`.
   * @param changedPaths - Path keys whose signal fired this dispatch
   * @param out - Set to accumulate affected subscribers into
   * @returns void
   */
  collect(changedPaths: Iterable<PathKey>, out: Set<HookSub>): void {
    for (const path of changedPaths) {
      const subs = this.byPath.get(path)
      if (subs !== undefined) {
        for (const sub of subs) out.add(sub)
      }
    }
  }

  /**
   * Number of indexed paths (for tests/diagnostics).
   * @returns How many distinct path keys currently have subscribers
   */
  pathCount(): number {
    return this.byPath.size
  }

  private addEdge(path: PathKey, sub: HookSub): void {
    let subs = this.byPath.get(path)
    if (subs === undefined) {
      subs = new Set()
      this.byPath.set(path, subs)
    }
    subs.add(sub)
  }

  private removeEdge(path: PathKey, sub: HookSub): void {
    const subs = this.byPath.get(path)
    if (subs === undefined) return
    subs.delete(sub)
    if (subs.size === 0) this.byPath.delete(path)
  }
}
