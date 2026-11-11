import { beforeEach, describe, expect, it, vi } from 'vitest'
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('../src/client/rpc.js', () => ({ rpc }))
import { GitStore, gitStoreFor } from '../src/client/state/gitStore.js'
beforeEach(() => rpc.mockReset())
const data = (path = 'a.ts') => ({ ok: true, root: '/repo', changes: [{ path, status: 'M', staged: false }] })

describe('共享 Git 状态', () => {
  it('并发面板读取合并请求，短期切回不再查询', async () => {
    rpc.mockImplementation(async method => method === 'git.status' ? data() : { ok: true, branch: 'main' })
    const store = new GitStore('/repo'), initial = store.snapshot()
    expect(store.snapshot()).toBe(initial)
    await Promise.all([store.refresh(), store.refresh()])
    const snapshot = store.snapshot()
    expect(snapshot.branch).toBe('main')
    expect(snapshot.data?.changes[0].path).toBe('a.ts')
    await store.refresh()
    expect(store.snapshot()).toBe(snapshot)
    expect(rpc).toHaveBeenCalledTimes(2)
  })
  it('读取期间再次保存时，完成后刷新到最新状态', async () => {
    let finish!: (result: unknown) => void
    let reads = 0
    rpc.mockImplementation(method => {
      if (method === 'git.branch') return Promise.resolve({ ok: true, branch: 'main' })
      return ++reads === 1 ? new Promise(resolve => { finish = resolve }) : Promise.resolve(data('new.ts'))
    })
    const store = new GitStore('/repo')
    const first = store.refresh()
    void store.refresh(true)
    finish(data('old.ts'))
    await first
    await store.refresh()
    expect(reads).toBe(2)
    expect(store.snapshot().data?.changes[0].path).toBe('new.ts')
  })
  it('不同目录独立识别，避免嵌套仓库混入父仓库状态', () => {
    expect(gitStoreFor('/repo/child')).not.toBe(gitStoreFor('/repo'))
    expect(gitStoreFor('/repo/child/')).toBe(gitStoreFor('/repo/child'))
  })
  it('非仓库时清空颜色来源，手动刷新后可恢复', async () => {
    const store = new GitStore('/repo')
    rpc.mockResolvedValue({ ok: false, error: '当前目录不是 Git 仓库' })
    await store.refresh()
    expect(store.snapshot().data).toBeNull()
    rpc.mockImplementation(async method => method === 'git.status' ? data() : { ok: true, branch: 'main' })
    await store.refresh(true)
    expect(store.snapshot().phase).toBe('ready')
  })
})
