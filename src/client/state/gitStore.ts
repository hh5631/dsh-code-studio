import React from 'react'
import { rpc } from '../rpc.js'
import type { GitChange } from '../../git.js'
import { normalizedPath } from './gitPaths.js'

export interface GitSnapshot {
  phase: 'idle' | 'loading' | 'ready' | 'error'
  data: { root: string; changes: GitChange[] } | null
  branch: string | null
  error: string
  refreshing: boolean
}
export const GIT_CHANGED_EVENT = 'cstudio:git-changed'
const stores = new Map<string, GitStore>()
export class GitStore {
  private value: GitSnapshot = { phase: 'idle', data: null, branch: null, error: '', refreshing: false }
  private listeners = new Set<() => void>()
  private at = 0
  private pending: Promise<void> | null = null
  private again = false
  constructor(readonly cwd: string) {}
  canEvict = (): boolean => this.listeners.size === 0 && !this.pending
  snapshot = (): GitSnapshot => this.value
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(patch: Partial<GitSnapshot>): void {
    this.value = { ...this.value, ...patch }
    this.listeners.forEach(listener => listener())
  }
  refresh = (force = false): Promise<void> => {
    if (!this.cwd) return Promise.resolve()
    if (this.pending) { this.again ||= force; return this.pending }
    if (!force && this.at && Date.now() - this.at < 4000) return Promise.resolve()
    this.publish({ phase: this.value.data ? 'ready' : 'loading', refreshing: true, error: '' })
    this.pending = (async () => {
      try {
        const [status, branch] = await Promise.all([rpc('git.status', { cwd: this.cwd }), rpc('git.branch', { cwd: this.cwd })])
        this.at = Date.now()
        if (status.ok) this.publish({ phase: 'ready', data: status, branch: branch.ok ? branch.branch : null, error: '', refreshing: false })
        else this.publish({ phase: 'error', data: null, branch: null, error: status.error || '读取 Git 状态失败', refreshing: false })
      } catch (error) { this.publish({ phase: 'error', data: null, error: String(error), refreshing: false }) }
    })().finally(() => {
      this.pending = null
      if (this.again) { this.again = false; void this.refresh(true) }
    })
    return this.pending
  }
}

export function gitStoreFor(cwd: string): GitStore {
  const path = normalizedPath(cwd)
  // 每个实际目录独立识别，避免把子模块或嵌套仓库误当作父仓库。
  let store = stores.get(path)
  if (!store) {
    store = new GitStore(path); stores.set(path, store)
    for (const [key, cached] of stores) {
      if (stores.size <= 32) break
      if (key !== path && cached.canEvict()) stores.delete(key)
    }
  }
  return store
}

export function useGitStore(cwd: string, visible = true, scope?: string): { store: GitStore; snapshot: GitSnapshot } {
  const store = React.useMemo(() => gitStoreFor(cwd), [cwd])
  const snapshot = React.useSyncExternalStore(store.subscribe, store.snapshot)
  React.useEffect(() => {
    if (!visible) return
    void store.refresh()
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent).detail
      if (detail?.source === store || (detail?.scope && scope && detail.scope !== scope)) return
      if (detail?.root && store.snapshot().data?.root && normalizedPath(detail.root) !== normalizedPath(store.snapshot().data!.root)) return
      clearTimeout(timer); timer = setTimeout(() => { void store.refresh(true) }, 250) }
    window.addEventListener('focus', refresh)
    window.addEventListener(GIT_CHANGED_EVENT, refresh)
    window.addEventListener('edrv:file-changed', refresh)
    return () => { clearTimeout(timer); window.removeEventListener('focus', refresh); window.removeEventListener(GIT_CHANGED_EVENT, refresh); window.removeEventListener('edrv:file-changed', refresh) }
  }, [store, visible, scope])
  return { store, snapshot }
}
