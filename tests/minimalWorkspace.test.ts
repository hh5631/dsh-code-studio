import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('../src/client/rpc.js', () => ({ rpc }))
import { MinimalWorkspace, minimalWorkspace, unsavedWorkspaceReason } from '../src/client/state/minimalWorkspace.js'

class Model {
  version = 1
  reads = 0
  disposed = false
  listeners = new Set<() => void>()
  constructor(public value: string) {}
  getValue() { this.reads++; return this.value }
  getVersionId() { return this.version }
  isDisposed() { return this.disposed }
  isAttachedToEditor() { return false }
  dispose() { this.disposed = true }
  onDidChangeContent(callback: () => void) { this.listeners.add(callback); return { dispose: () => this.listeners.delete(callback) } }
  setValue(value: string) { this.value = value; this.version++; for (const callback of this.listeners) callback() }
}
function modelFactory() {
  return (_scope: string, _path: string, value: string) => new Model(value)
}
beforeEach(() => { vi.useFakeTimers(); rpc.mockReset() })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

describe('minimal workspace model and save ownership', () => {
  it('deduplicates concurrent reads and does not reread when switching back', async () => {
    rpc.mockResolvedValue({ ok: true, content: 'original', version: 'v1' })
    const workspace = new MinimalWorkspace('deduplicated'), api = modelFactory()
    const [first, second] = await Promise.all([workspace.load('a.ts', api), workspace.load('a.ts', api)])
    expect(first.model).toBe(second.model)
    expect((await workspace.load('a.ts', api)).model).toBe(first.model)
    expect(rpc).toHaveBeenCalledTimes(1)
  })
  it('typing does not copy the entire file; one debounced save contains the latest edit', async () => {
    rpc.mockImplementation(async (method) => method === 'cstudio.read'
      ? { ok: true, content: 'original', version: 'v1' } : { ok: true, rev: 'v2' })
    const workspace = new MinimalWorkspace('typing'), entry = await workspace.load('a.ts', modelFactory())
    for (let index = 0; index < 80; index++) entry.model.setValue('edit-' + index)
    expect(entry.model.reads).toBe(0)
    await vi.advanceTimersByTimeAsync(901)
    expect(rpc.mock.calls.filter(([method]) => method === 'edrv.save')).toEqual([
      ['edrv.save', { sessionId: undefined, path: 'a.ts', content: 'edit-79', rev: 'v1' }],
    ])
    expect(workspace.saves.state('a.ts').dirty).toBe(false)
  })
  it('a slow disk response cannot overwrite edits made after its request began', async () => {
    let resolveRead!: (value: unknown) => void
    rpc.mockResolvedValueOnce({ ok: true, content: 'original', version: 'v1' })
    const workspace = new MinimalWorkspace('read-race'), api = modelFactory(), entry = await workspace.load('a.ts', api)
    rpc.mockImplementationOnce(() => new Promise(resolve => { resolveRead = resolve }))
    const request = workspace.load('a.ts', api, true)
    entry.model.setValue('local edit')
    resolveRead({ ok: true, content: 'stale response', version: 'v2' })
    await request
    expect(entry.model.value).toBe('local edit')
    expect(workspace.saves.state('a.ts').dirty).toBe(true)
  })
  it('external changes pause autosave and keep the unsaved model', async () => {
    rpc.mockResolvedValueOnce({ ok: true, content: 'original', version: 'v1' })
    const workspace = new MinimalWorkspace('external-change'), api = modelFactory(), entry = await workspace.load('a.ts', api)
    entry.model.setValue('local edit')
    rpc.mockResolvedValueOnce({ ok: true, items: [{ path: 'a.ts', version: 'external-v2', type: 'file' }] })
    await workspace.refresh('a.ts')
    await vi.advanceTimersByTimeAsync(901)
    expect(workspace.saves.state('a.ts').conflict).toBe(true)
    expect(entry.model.value).toBe('local edit')
    expect(rpc.mock.calls.some(([method]) => method === 'edrv.save')).toBe(false)
  })
  it('failed explicit reload preserves edits instead of clearing the dirty buffer', async () => {
    rpc.mockResolvedValueOnce({ ok: true, content: 'original', version: 'v1' })
    const workspace = new MinimalWorkspace('reload-failure'), entry = await workspace.load('a.ts', modelFactory())
    entry.model.setValue('local edit')
    rpc.mockResolvedValueOnce({ ok: false, error: 'read failed' })
    await workspace.reload('a.ts')
    expect(entry.model.value).toBe('local edit')
    expect(workspace.saves.state('a.ts').dirty).toBe(true)
  })
  it('keeps large-file refusal identifiable without creating a huge Monaco model', async () => {
    rpc.mockResolvedValueOnce({ ok: false, code: 'file-too-large', error: 'large file' })
    const workspace = new MinimalWorkspace('large-file')
    await expect(workspace.load('large.txt', modelFactory())).rejects.toMatchObject({ code: 'file-too-large' })
    expect(workspace.documents.size).toBe(0)
  })
  it('also bounds model creation when the transport returns a large successful read', async () => {
    rpc.mockResolvedValueOnce({ ok: true, content: 'oversized fixture', size: 3 * 1024 * 1024, version: 'v1' })
    const workspace = new MinimalWorkspace('large-file-fallback')
    await expect(workspace.load('large.txt', modelFactory())).rejects.toMatchObject({ code: 'file-too-large' })
    expect(workspace.documents.size).toBe(0)
  })
})

describe('原生文件标签关闭后的未保存缓冲', () => {
  it('无编辑组件订阅时，失败的保存仍阻止刷新；重试成功后解除', async () => {
    let fail = true
    rpc.mockImplementation(async method => method === 'cstudio.read'
      ? { ok: true, content: 'original', version: 'v1' }
      : fail ? { ok: false, error: 'disk unavailable' } : { ok: true, rev: 'v2' })
    const workspace = minimalWorkspace('closed-native-tab'), entry = await workspace.load('a.ts', modelFactory())
    const unsubscribe = workspace.subscribe(() => {})
    entry.model.setValue('local edit')
    unsubscribe()
    await workspace.saves.flush('a.ts')
    expect(workspace.listeners.size).toBe(0)
    expect(unsavedWorkspaceReason()).toContain('a.ts')
    expect(entry.model.getValue()).toBe('local edit')
    fail = false
    await workspace.saves.flush('a.ts')
    expect(unsavedWorkspaceReason()).toBeNull()
  })
})
