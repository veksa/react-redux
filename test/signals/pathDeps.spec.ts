import { describe, expect, it } from 'vitest'
import { DepIndex } from '../../src/signals/pathDeps'
import { alienEngine } from '../../src/signals/engine'
import { createPathSignalRegistry } from '../../src/signals/pathSignalRegistry'
import type { HookSub } from '../../src/signals/types'

const sub = (): HookSub => ({
  segments: new Set(),
  deps: new Set(),
  notify() {},
})

describe('DepIndex', () => {
  it('collects the subscribers of changed paths (union, deduped)', () => {
    const index = new DepIndex()
    const a = sub()
    const b = sub()
    index.replace(a, new Set(['x.1', 'x.2']))
    index.replace(b, new Set(['x.2']))

    const out = new Set<HookSub>()
    index.collect(['x.2'], out)
    expect(out).toEqual(new Set([a, b]))

    out.clear()
    index.collect(['x.1'], out)
    expect(out).toEqual(new Set([a]))

    out.clear()
    index.collect(['x.3'], out)
    expect(out.size).toBe(0)
  })

  it('replace only touches the edges that differ, and prunes empty paths', () => {
    const index = new DepIndex()
    const a = sub()
    index.replace(a, new Set(['keep', 'drop']))
    expect(index.pathCount()).toBe(2)

    // 'keep' survives, 'drop' goes, 'add' arrives.
    index.replace(a, new Set(['keep', 'add']))
    expect(a.deps).toEqual(new Set(['keep', 'add']))
    expect(index.pathCount()).toBe(2)

    const out = new Set<HookSub>()
    index.collect(['drop'], out)
    expect(out.size).toBe(0)
    index.collect(['keep', 'add'], out)
    expect(out).toEqual(new Set([a]))
  })

  it('remove drops every edge and empties the dep set', () => {
    const index = new DepIndex()
    const a = sub()
    const b = sub()
    index.replace(a, new Set(['shared', 'mine']))
    index.replace(b, new Set(['shared']))

    index.remove(a)
    expect(a.deps.size).toBe(0)
    // 'mine' had only `a`, so it's gone; 'shared' still has `b`.
    expect(index.pathCount()).toBe(1)

    const out = new Set<HookSub>()
    index.collect(['shared', 'mine'], out)
    expect(out).toEqual(new Set([b]))
  })
})

describe('registry dependency capture', () => {
  it('captures the path key of every kind of dependency read', () => {
    const registry = createPathSignalRegistry(alienEngine)

    const deps = new Set<string>()
    expect(registry.captureDeps(deps)).toBeNull()

    registry.getOrCreate('a.b', 1).get()
    registry.getOrCreate('a.@@keys', ['b']).get()
    registry.trackColumn('rows', 'price').get()
    registry.trackStructure('rows', 'append').get()

    expect(registry.captureDeps(null)).toBe(deps)
    expect(deps).toEqual(
      new Set(['a.b', 'a.@@keys', 'rows.{*}.price', 'rows.@@append']),
    )

    // Capture is off again — reads no longer land anywhere.
    registry.getOrCreate('a.c', 2).get()
    expect(deps.has('a.c')).toBe(false)
  })

  it('restores the previous collector, so nested captures cannot leak', () => {
    const registry = createPathSignalRegistry(alienEngine)
    const outer = new Set<string>()
    const inner = new Set<string>()

    registry.captureDeps(outer)
    registry.getOrCreate('outer.path', 1)
    const previous = registry.captureDeps(inner)
    registry.getOrCreate('inner.path', 1)
    registry.captureDeps(previous)
    registry.getOrCreate('outer.again', 1)

    expect(outer).toEqual(new Set(['outer.path', 'outer.again']))
    expect(inner).toEqual(new Set(['inner.path']))
  })
})

describe('registry changed-path recording', () => {
  it('records a leaf update', () => {
    const registry = createPathSignalRegistry(alienEngine)
    registry.getOrCreate('a.b', 1)

    registry.update('a.b', 2)
    expect(registry.changedPaths).toEqual(new Set(['a.b']))
  })

  it('ignores updates to paths nothing tracks', () => {
    const registry = createPathSignalRegistry(alienEngine)
    registry.update('never.read', 2)
    expect(registry.changedPaths.size).toBe(0)
  })

  it('records EVERY descendant of a pruned subtree, not just its root', () => {
    // A hook can depend on a leaf deep inside a removed entity; if prune only
    // reported its root the fine index would never reach that hook.
    const registry = createPathSignalRegistry(alienEngine)
    registry.getOrCreate('items.{id:2}', {})
    registry.getOrCreate('items.{id:2}.name', 'two')
    // Intermediate objects are prefix-only, as the tracking proxy registers
    // them while traversing — they carry no signal, only the child link.
    registry.ensurePrefix('items.{id:2}.meta')
    registry.getOrCreate('items.{id:2}.meta.tag', 'x')
    registry.getOrCreate('items.{id:1}.name', 'one')

    registry.prune('items.{id:2}')

    expect(registry.changedPaths).toEqual(
      new Set([
        'items.{id:2}',
        'items.{id:2}.name',
        'items.{id:2}.meta.tag',
      ]),
    )
  })

  it('records column and structural bumps under their own path keys', () => {
    const registry = createPathSignalRegistry(alienEngine)
    registry.trackColumn('rows', 'price')
    registry.trackStructure('rows', 'remove')

    registry.bumpColumn('rows', 'price')
    registry.bumpStructure('rows', 'remove')
    // Untracked column/structure — no signal, so nothing to record.
    registry.bumpColumn('rows', 'volume')
    registry.bumpStructure('rows', 'append')

    expect(registry.changedPaths).toEqual(
      new Set(['rows.{*}.price', 'rows.@@remove']),
    )
  })

  it('records the same path keys the dependency capture produces', () => {
    // The two halves of the fine tier have to agree on spelling: a captured
    // dep that reconcile records under a different key would silently never
    // fire. Both sides route through the same path builders — this pins it.
    const registry = createPathSignalRegistry(alienEngine)
    const deps = new Set<string>()
    registry.captureDeps(deps)
    registry.trackColumn('rows', 'price').get()
    registry.trackStructure('rows', 'append').get()
    registry.getOrCreate('rows.{id:7}.price', 1).get()
    registry.captureDeps(null)

    registry.bumpColumn('rows', 'price')
    registry.bumpStructure('rows', 'append')
    registry.update('rows.{id:7}.price', 2)

    expect(registry.changedPaths).toEqual(deps)
  })
})
