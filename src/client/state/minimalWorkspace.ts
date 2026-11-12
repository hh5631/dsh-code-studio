/** 工作区模型与保存队列；输入时不复制整篇内容，不进行差异审查。 */
import { createDocStore, type SaveResult } from './documentStore.js'
import { modelsForScope, rememberModel, retainModels } from './modelCache.js'
import { rpc } from '../rpc.js'
import { addReloadGuard } from '../pageReload.js'
import type { CreateEditorModel, EditorModel } from '../editorTypes.js'

export const MAX_EDIT_TEXT_BYTES = 2 * 1024 * 1024

export interface OpenDocument { model: EditorModel; silent: boolean; subscription: { dispose(): void } }
const workspaces = new Map<string, MinimalWorkspace>()
export function minimalWorkspace(scope: string, sessionId?: string): MinimalWorkspace {
  let state = workspaces.get(scope)
  if (!state) { state = new MinimalWorkspace(scope); workspaces.set(scope, state) }
  state.sessionId = sessionId
  return state
}
/** 原生页签关闭后模型仍归工作区持有，刷新保护不能依赖编辑组件是否挂载。 */
export function unsavedWorkspaceReason(): string | null {
  for (const workspace of workspaces.values()) {
    if (!workspace.saves.unsafe()) continue
    const path = [...workspace.documents.keys()].find(path => {
      const state = workspace.saves.state(path)
      return state.dirty || state.saving
    })
    return path ? `文件“${path}”尚未保存，请重新打开处理` : '仍有未保存的文件，请先处理后刷新'
  }
  return null
}
export function installWorkspaceGuards(): () => void {
  const dispose = addReloadGuard({ check: unsavedWorkspaceReason, prepare() {} })
  const unload = (event: BeforeUnloadEvent) => {
    if (unsavedWorkspaceReason()) { event.preventDefault(); event.returnValue = '' }
  }
  window.addEventListener('beforeunload', unload)
  return () => { dispose(); window.removeEventListener('beforeunload', unload) }
}

export class MinimalWorkspace {
  sessionId?: string
  readonly documents = new Map<string, OpenDocument>()
  readonly listeners = new Set<() => void>()
  readonly models: Map<string, unknown>
  readonly saves: ReturnType<typeof createDocStore>
  private readonly loads = new Map<string, Promise<OpenDocument>>()
  private readonly checking = new Set<string>()
  private readonly checked = new Map<string, number>()
  private readonly status = new Map<string, string>()
  error = ''
  revision = 0
  constructor(readonly scope: string) {
    this.models = modelsForScope(scope)
    this.saves = createDocStore({
      save: request => rpc('edrv.save', { sessionId: this.sessionId, ...request }),
      changed: (path, state) => {
        const next = `${state.dirty}:${!!state.saving}:${state.conflict}`
        if (this.status.get(path) === next) return
        this.status.set(path, next); this.notify()
      },
      saved: (path) => {
        this.error = ''; this.notify()
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') window.dispatchEvent(new CustomEvent('cstudio:git-changed', { detail: { scope: this.scope, path } }))
      },
      failed: (_path, result) => { this.error = result.error || '保存失败，编辑内容已保留'; this.notify() },
    })
  }
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  snapshot = (): number => this.revision
  notify(): void { this.revision += 1; for (const listener of this.listeners) listener() }
  /** 并发打开只读取一次；缓存命中保留内容及撤销历史。 */
  load(path: string, createModel?: CreateEditorModel, force = false): Promise<OpenDocument> {
    let old = this.documents.get(path)
    if (old?.model.isDisposed()) {
      old.subscription.dispose(); this.documents.delete(path); this.saves.release(path); old = undefined
    }
    if (old && !force) return Promise.resolve(old)
    const pending = this.loads.get(path)
    if (pending) return pending
    const sessionId = this.sessionId, version = old?.model.getVersionId()
    const task = (async () => {
      const result = await rpc('cstudio.read', { sessionId, path, maxTextBytes: MAX_EDIT_TEXT_BYTES })
      if (!result.ok) throw Object.assign(new Error(result.error || '文件读取失败'), { code: result.code })
      if (result.size > MAX_EDIT_TEXT_BYTES || result.content.length > MAX_EDIT_TEXT_BYTES) {
        throw Object.assign(new Error('文件较大，使用分页只读预览'), { code: 'file-too-large' })
      }
      if (old && (this.saves.state(path).dirty || old.model.getVersionId() !== version)) return old
      if (old) {
        old.silent = true
        try { if (old.model.getValue() !== result.content) old.model.setValue(result.content) }
        finally { old.silent = false }
        this.saves.baseline(path, result.version, false)
        return old
      }
      if (!createModel) throw new Error('文件模型不可用')
      const model = createModel(this.scope, path, result.content)
      this.saves.bind(path, model, result.version)
      const entry: OpenDocument = { model, silent: false, subscription: model.onDidChangeContent(() => {
        if (!entry.silent) this.saves.edit(path, 900)
      }) }
      this.documents.set(path, entry); rememberModel(this.models, path, model); this.notify()
      return entry
    })().finally(() => { this.loads.delete(path) })
    this.loads.set(path, task)
    return task
  }
  /** 聚焦/切页签只校验版本，没有后台逐文件轮询；外部改动时保护未保存内容。 */
  async refresh(path: string): Promise<void> {
    const entry = this.documents.get(path)
    if (!entry || this.checking.has(path) || Date.now() - (this.checked.get(path) ?? 0) < 1500) return
    this.checking.add(path); this.checked.set(path, Date.now())
    try {
      const result = await rpc('cstudio.versions', { sessionId: this.sessionId, paths: [path] })
      if (!result.ok) return
      const disk = result.items.find(item => item.path === path), state = this.saves.state(path)
      if (!disk || state.saving || !state.rev) return
      if (disk.type === 'missing') { this.error = '文件已被删除；本地编辑内容仍保留'; this.notify(); return }
      if (disk.version === state.rev) return
      if (state.dirty) {
        this.saves.baseline(path, undefined, true)
        this.error = '文件已被外部修改；自动保存已暂停，请先处理本地编辑'; this.notify()
      } else await this.load(path, undefined, true)
    } catch { /* 校验失败不清空内容、不影响输入。 */ }
    finally { this.checking.delete(path) }
  }
  async save(path: string): Promise<SaveResult> { return this.saves.save(path, true) }
  /** 明确重新加载时才放弃旧缓冲；读取失败或期间又有编辑则保留原内容。 */
  async reload(path: string): Promise<void> {
    const entry = this.documents.get(path)
    if (!entry) return
    const state = this.saves.state(path), version = entry.model.getVersionId(), previousConflict = state.conflict
    this.saves.baseline(path, undefined, true)
    try {
      if (state.saving) await state.saving
      const result = await rpc('cstudio.read', { sessionId: this.sessionId, path })
      if (!result.ok) throw new Error(result.error || '读取失败')
      if (entry.model.getVersionId() !== version) throw new Error('读取期间文件又有编辑，本地内容已保留')
      entry.silent = true
      try { entry.model.setValue(result.content) } finally { entry.silent = false }
      state.dirty = false; this.error = ''; this.saves.baseline(path, result.version, false)
    } catch (error) { this.error = String(error); this.saves.baseline(path, undefined, previousConflict) }
    this.notify()
  }
  retain(paths: string[]): void {
    retainModels(this.models, [...paths, ...[...this.documents.keys()].filter(path => this.saves.state(path).dirty)])
    for (const [path, document] of this.documents) {
      if (paths.includes(path) || this.models.has(path) || !this.saves.release(path)) continue
      document.subscription.dispose(); this.documents.delete(path); this.status.delete(path); this.checked.delete(path)
    }
  }
}
