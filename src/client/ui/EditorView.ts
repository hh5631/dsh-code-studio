/** 原生文件编辑、保存与 Git 差异的共用界面。 */
import React from 'react'
import { createPortal } from 'react-dom'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { editorName, loadEditorEngine } from '../codemirror/engine.js'
import type { DocumentEditor, EditorEngine, EditorModel } from '../editorTypes.js'
import { MAX_EDIT_TEXT_BYTES, minimalWorkspace } from '../state/minimalWorkspace.js'
import { workspaceScopeOf } from '../state/scopeStore.js'
import { normalizeTabs, tabPathOf, remapPathOf } from '../tabActions.js'
import { getMaxOpenEditors } from '../editorLimit.js'
import { CACHE_KEY } from '../paths.js'
import { addReloadGuard } from '../pageReload.js'
import { bindPanelCommand } from '../panelCommands.js'
import { setActiveEditorPath } from '../activePathStore.js'
import { deferToOfficial } from '../officialSidebar.js'
import { tryNativeOpen, inNativePath } from '../nativeOpenStore.js'
import { GitPanel } from '../sidebar/panels/GitPanel.js'
import { IconFolderOpenOutline16, IconBranchOutline16 } from './icons.js'
import { QuickOpen } from './QuickOpen.js'
import { CommandPalette } from './CommandPalette.js'
import { GitDiffView } from './GitDiffView.js'
import { promptName } from './PromptDialog.js'
import { revealInExplorer } from '../fileReveal.js'
import { onUiStateReady } from '../state/uiStatePersist.js'
import { copyText } from '../copyText.js'
import { rpc } from '../rpc.js'
import { LargeTextView } from './LargeTextView.js'
import { afterPaint } from '../afterPaint.js'

export interface Props {
  sessionId?: string; sessions?: any; visible?: boolean; ownerId?: string
  sidebarPanels?: any; fileMenuItems?: any; officialMenus?: any; forge?: any; addToConversation?: any
  [key: string]: any
}
type Tabs = Array<{ path: string; pinned?: boolean }>
function restoreTabs(scope: string, cwd: string | null): { tabs: Tabs; active: string | null } {
  try {
    const raw = localStorage.getItem(CACHE_KEY.editor + scope) ?? localStorage.getItem(CACHE_KEY.editorLegacy + scope)
    const saved = raw ? JSON.parse(raw) : null
    const tabs = normalizeTabs(saved?.tabs, cwd).filter((tab: any) => !deferToOfficial(tab.path))
    const active = typeof saved?.active === 'string' ? tabPathOf(saved.active, cwd) : null
    return { tabs, active: tabs.some((tab: any) => tab.path === active) ? active : tabs[0]?.path ?? null }
  } catch { return { tabs: [], active: null } }
}

export function EditorView(props: Props): React.ReactElement {
  const list = props.sessions?.list
  const cwd: string | null = React.useSyncExternalStore(
    React.useCallback(callback => list?.subscribe?.(callback) ?? (() => {}), [list]),
    () => list?.getSnapshot?.()?.byId?.[props.sessionId ?? '']?.cwd ?? null, () => null,
  )
  const scope = workspaceScopeOf(cwd, props.sessionId)
  return React.createElement(WorkspaceEditor, { ...props, cwd, scope, key: scope })
}

function WorkspaceEditor(props: Props & { cwd: string | null; scope: string }): React.ReactElement {
  const { sessionId, cwd, scope } = props
  const workspace = React.useMemo(() => minimalWorkspace(scope, sessionId), [scope])
  workspace.sessionId = sessionId
  React.useSyncExternalStore(workspace.subscribe, workspace.snapshot)
  const embedded = typeof props.filePath === 'string'
  const [saved] = React.useState(() => embedded ? props.filePath ? { tabs: [{ path: tabPathOf(props.filePath, cwd) }], active: tabPathOf(props.filePath, cwd) } : { tabs: [], active: null } : restoreTabs(scope, cwd))
  const [tabs, setTabs] = React.useState<Tabs>(saved.tabs)
  const [active, setActive] = React.useState<string | null>(saved.active)
  const [engine, setEngine] = React.useState<EditorEngine | null>(null)
  const [ready, setReady] = React.useState(0)
  const [loading, setLoading] = React.useState(false)
  const [largePath, setLargePath] = React.useState<string | null>(null)
  const [presented, setPresented] = React.useState<{ path: string; model: EditorModel } | null>(null)
  const [error, setError] = React.useState('')
  const [sidebar, setSidebar] = React.useState(false)
  const [preview, setPreview] = React.useState(false)
  const [previewText, setPreviewText] = React.useState('')
  const [quick, setQuick] = React.useState(false)
  const [gitDiff, setGitDiff] = React.useState<{ cwd: string; path: string; staged: boolean } | null>(null)
  const visible = props.visible !== false
  // 原生右栏会预挂载文件页签。空工作台、后台页签和纯 Git 对比都不需要加载编辑器。
  const sizeTooLarge = typeof props.documentSize === 'number' && props.documentSize > MAX_EDIT_TEXT_BYTES
  const large = !!active && (sizeTooLarge || largePath === active)
  const needsEditor = visible && !!active && !gitDiff && !large
  const host = React.useRef<HTMLDivElement>(null), root = React.useRef<HTMLDivElement>(null)
  const editor = React.useRef<DocumentEditor | null>(null)
  const bound = React.useRef<string | null>(null)
  const lastLoad = React.useRef<{ path: string; revision?: number } | null>(null)
  const onDocumentLoad = React.useRef(props.onDocumentLoad)
  onDocumentLoad.current = props.onDocumentLoad
  const pendingLine = React.useRef<{ path: string; line: number; column: number } | null>(null)
  const latest = React.useRef({ active, tabs, visible: props.visible !== false })
  latest.current = { active, tabs, visible: props.visible !== false }
  React.useEffect(() => { setPreview(false); setGitDiff(null) }, [active])
  const openFiles = React.useCallback(() => {
    if (props.openWorkspaceFiles?.() !== true) setQuick(true)
  }, [props.openWorkspaceFiles])

  const persist = React.useCallback(() => {
    if (!embedded) try { localStorage.setItem(CACHE_KEY.editor + scope, JSON.stringify({ tabs: latest.current.tabs, active: latest.current.active })) } catch {}
    editor.current?.save()
  }, [scope, workspace, embedded])
  React.useEffect(() => {
    const timer = setTimeout(persist, 400); workspace.retain(tabs.map(tab => tab.path))
    return () => clearTimeout(timer)
  }, [tabs, active, persist, workspace])
  React.useEffect(() => () => { persist(); void workspace.saves.flush() }, [persist, workspace])
  React.useEffect(() => addReloadGuard({ check: () => workspace.saves.unsafe() ? '有尚未保存的编辑，请先保存文件' : null, prepare: persist }), [persist, workspace])
  React.useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (workspace.saves.unsafe()) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [workspace])
  React.useEffect(() => onUiStateReady(() => {
    if (embedded || latest.current.tabs.length || workspace.saves.unsafe()) return
    const next = restoreTabs(scope, cwd); setTabs(next.tabs); setActive(next.active)
  }), [scope, cwd, workspace])

  const open = React.useCallback((path: string, line?: number, column?: number) => {
    if (!path) return
    if (embedded && path !== props.filePath && typeof props.onOpenPath === 'function') {
      props.onOpenPath(path, line, column); setQuick(false); return
    }
    if (deferToOfficial(path) || inNativePath(path)) {
      setQuick(false)
      if (!tryNativeOpen(path)) setError('原生预览暂不可用，请从工作区文件面板打开')
      return
    }
    const normalized = tabPathOf(path, cwd)
    if (!normalized) return
    if (line && bound.current === normalized && editor.current) {
      editor.current.goTo(line, column || 1)
    } else if (line) pendingLine.current = { path: normalized, line, column: column || 1 }
    setTabs(previous => {
      if (embedded) return [{ path: normalized }]
      if (previous.some(tab => tab.path === normalized)) return previous
      const limit = getMaxOpenEditors() || 20
      const next = [...previous, { path: normalized }]
      if (next.length <= limit) return next
      const candidate = previous.find(tab => !tab.pinned && tab.path !== latest.current.active
        && !workspace.saves.state(tab.path).dirty && !workspace.saves.state(tab.path).saving)
      return candidate ? next.filter(tab => tab.path !== candidate.path) : next
    })
    setActive(normalized); setQuick(false); setGitDiff(null); setPreview(false); setError('')
  }, [cwd, workspace, embedded, props.filePath, props.onOpenPath])
  React.useEffect(() => { if (embedded) open(props.filePath, props.fileLine, props.fileColumn) }, [embedded, props.filePath, props.fileLine, props.fileColumn, props.navigationRevision, open])
  React.useEffect(() => {
    if (!props.beforeNavigate) return
    const prepare = async () => {
      const path = latest.current.active
      if (!path || !workspace.documents.has(path)) return true
      const results = await workspace.saves.flush(path)
      if (results.some(result => !result.ok) || workspace.saves.state(path).dirty) { setError('文件尚未保存，请先处理保存提示'); return false }
      return true
    }
    props.beforeNavigate.current = prepare
    return () => { if (props.beforeNavigate.current === prepare) props.beforeNavigate.current = null }
  }, [workspace, props.beforeNavigate])
  const close = React.useCallback(async (path: string) => {
    if (workspace.documents.has(path)) {
      const result = await workspace.saves.flush(path)
      if (result.some(item => !item.ok) || workspace.saves.state(path).dirty) { setError('文件尚未保存，页签已保留'); return }
    }
    const current = latest.current, next = current.tabs.filter(tab => tab.path !== path)
    const index = current.tabs.findIndex(tab => tab.path === path)
    setTabs(next)
    if (current.active === path) setActive(next[Math.min(index, next.length - 1)]?.path ?? null)
  }, [workspace])
  React.useEffect(() => {
    const routed = (event: Event) => {
      const detail = (event as CustomEvent).detail
      if ((detail?.sessionId && detail.sessionId !== sessionId) || (detail?.ownerId && detail.ownerId !== props.ownerId)) return
      if (detail?.path) open(detail.path, detail.line, detail.column)
    }
    window.addEventListener('edrv:open-editor', routed)
    return () => window.removeEventListener('edrv:open-editor', routed)
  }, [open, sessionId, props.ownerId])
  React.useEffect(() => {
    const matches = (path: string, parent: string) => path === parent || path.startsWith(parent + '/')
    const renamed = (event: Event) => {
      const detail = (event as CustomEvent).detail
      if (!detail?.from || !detail?.to || (detail.scope && detail.scope !== scope)) return
      const from = tabPathOf(detail.from, cwd), to = tabPathOf(detail.to, cwd)
      const current = latest.current, changed = current.tabs.filter(tab => matches(tab.path, from))
      const safe = new Set(changed.filter(tab => !workspace.saves.state(tab.path).dirty && !workspace.saves.state(tab.path).saving).map(tab => tab.path))
      for (const tab of changed) if (!safe.has(tab.path)) workspace.saves.baseline(tab.path, undefined, true)
      if (safe.size !== changed.length) { workspace.error = '文件路径已变化，未保存内容已保留，请先复制内容'; workspace.notify() }
      setTabs(current.tabs.map(tab => safe.has(tab.path) ? { ...tab, path: remapPathOf(tab.path, from, to) } : tab))
      if (current.active && safe.has(current.active)) setActive(remapPathOf(current.active, from, to))
    }
    const deleted = (event: Event) => {
      const detail = (event as CustomEvent).detail
      if (detail?.scope && detail.scope !== scope) return
      const path = tabPathOf(detail?.path || '', cwd)
      if (!path) return
      const current = latest.current, removed = new Set<string>()
      for (const tab of current.tabs.filter(tab => matches(tab.path, path))) {
        const state = workspace.saves.state(tab.path)
        workspace.saves.baseline(tab.path, undefined, true)
        if (state.dirty || state.saving) { workspace.error = '文件已被删除，未保存内容已保留，请先复制内容'; workspace.notify() }
        else removed.add(tab.path)
      }
      const next = current.tabs.filter(tab => !removed.has(tab.path)); setTabs(next)
      if (current.active && removed.has(current.active)) setActive(next[0]?.path ?? null)
    }
    window.addEventListener('edrv:path-renamed', renamed); window.addEventListener('edrv:path-deleted', deleted)
    return () => { window.removeEventListener('edrv:path-renamed', renamed); window.removeEventListener('edrv:path-deleted', deleted) }
  }, [cwd, workspace, scope])
  const openRef = React.useRef(open)
  openRef.current = open
  React.useEffect(() => {
    if (!needsEditor || engine) return
    let alive = true
    const cancel = afterPaint(() => {
      void loadEditorEngine().then(value => {
        if (alive) setEngine(value)
      }).catch((cause: unknown) => {
        if (alive) { setError(String(cause)); onDocumentLoad.current?.(false) }
      })
    })
    return () => { alive = false; cancel() }
  }, [needsEditor, engine, active])
  React.useEffect(() => { if (sizeTooLarge && visible && active) onDocumentLoad.current?.(true) },
    [sizeTooLarge, visible, active, props.documentRevision])
  React.useLayoutEffect(() => {
    if (!engine || !host.current) return
    const instance = engine.mount(host.current, {
      scope, open: (...args) => openRef.current(...args), notify: setError,
      save: () => { const path = bound.current; if (path) void workspace.save(path) },
    })
    editor.current = instance
    setReady(value => value + 1)
    return () => {
      persist(); instance.dispose(); editor.current = null; bound.current = null
    }
  }, [engine, scope, workspace, persist])
  React.useEffect(() => {
    editor.current?.setWrap(props.wordWrap === true)
  }, [props.wordWrap, ready])
  React.useEffect(() => {
    const instance = editor.current
    if (!visible || !instance || !engine || sizeTooLarge) return
    let alive = true
    instance.save(); setActiveEditorPath(active)
    if (!active) { instance.clear(); bound.current = null; return }
    const reportLoad = onDocumentLoad.current
    const cached = workspace.documents.has(active)
    const reload = props.documentRevision !== undefined && lastLoad.current?.path === active
      && lastLoad.current.revision !== props.documentRevision
    if (!cached) { instance.clear(); bound.current = null }
    setLoading(!cached); setError(''); setLargePath(null)
    void workspace.load(active, engine.createModel, reload).then(entry => {
      if (!alive) return
      lastLoad.current = { path: active, revision: props.documentRevision }
      instance.bind(active, entry.model); bound.current = active
      setPresented(previous => previous?.path === active && previous.model === entry.model ? previous : { path: active, model: entry.model })
      const jump = pendingLine.current
      if (jump?.path === active) {
        instance.goTo(jump.line, jump.column); pendingLine.current = null
      }
      setLoading(false); reportLoad?.(true); void workspace.refresh(active)
    }).catch(cause => {
      if (!alive) return
      setLoading(false)
      if (!cached || cause?.code === 'file-too-large') { instance.clear(); bound.current = null }
      if (cause?.code === 'file-too-large') { setLargePath(active); reportLoad?.(true) }
      else { setError(String(cause)); reportLoad?.(false) }
    })
    return () => { alive = false }
  }, [active, engine, ready, scope, workspace, props.documentRevision, visible, sizeTooLarge])
  React.useEffect(() => {
    const focus = () => {
      const current = latest.current
      if (document.visibilityState !== 'hidden' && current.visible && current.active) void workspace.refresh(current.active)
    }
    window.addEventListener('focus', focus); document.addEventListener('visibilitychange', focus)
    return () => { window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus) }
  }, [workspace])
  React.useEffect(() => {
    if (!visible || preview || large || gitDiff || !presented || presented.path !== active) return
    let deactivate: void | (() => void)
    const cancel = afterPaint(() => { deactivate = editor.current?.activate(presented.path, presented.model, sessionId) })
    return () => { cancel(); deactivate?.() }
  }, [active, gitDiff, large, preview, presented, sessionId, visible, ready])
  React.useEffect(() => {
    const cycle = (step: number) => {
      const current = latest.current
      if (!current.tabs.length) return
      const index = current.tabs.findIndex(tab => tab.path === current.active)
      setActive(current.tabs[(index + step + current.tabs.length) % current.tabs.length].path)
    }
    const commands: Record<string, () => void> = {
      save: () => { const path = latest.current.active; if (path && workspace.documents.has(path)) void workspace.save(path) },
      closeTab: () => { if (latest.current.active) void close(latest.current.active) },
      toggleSidebar: openFiles, goToLine: () => editor.current?.run('goToLine'),
      toggleComment: () => editor.current?.run('toggleComment'), duplicateLine: () => editor.current?.run('duplicateLine'),
      goToDefinition: () => editor.current?.run('goToDefinition'), findReferences: () => editor.current?.run('findReferences'),
      openInExplorer: () => { if (latest.current.active) void revealInExplorer(sessionId, latest.current.active) },
      nextTab: () => cycle(1), prevTab: () => cycle(-1),
      toggleMarkdownPreview: () => {
        const path = latest.current.active
        if (!path || !/\.(?:md|markdown)$/i.test(path)) return
        const model = workspace.documents.get(path)?.model
        if (!model) return
        setPreviewText(model.getValue()); setPreview(value => !value)
      },
    }
    const handlers = Object.entries(commands).map(([name, run]) => {
      const key = `edrv.command.${name}`, guarded = () => { if (latest.current.visible) run() }
      window.addEventListener(key, guarded); return () => window.removeEventListener(key, guarded)
    })
    const quickCommand = bindPanelCommand('quickOpen', { sessionId }, () => setQuick(true))
    const searchCommand = bindPanelCommand('searchInFiles', { sessionId }, () => { if (!props.showWorkspacePanel?.('search')) openFiles() })
    return () => { handlers.forEach(dispose => dispose()); quickCommand(); searchCommand() }
  }, [close, sessionId, workspace, openFiles, props.showWorkspacePanel])
  React.useEffect(() => { if (quick) root.current?.querySelector<HTMLInputElement>('input')?.focus() }, [quick])

  const context = {
    sessionId, cwd, scope, visible: props.visible !== false, activePath: active, openFile: open, openFileAt: open,
    fileMenuItems: props.fileMenuItems, officialMenus: props.officialMenus, forge: props.forge, addToConversation: props.addToConversation,
    editor: () => editor.current, notify: setError, prompt: promptName,
    openGitDiff: (path: string, staged: boolean, repositoryRoot?: string) => { setGitDiff({ cwd: repositoryRoot || cwd || '', path, staged }); setPreview(false) },
    gitChanged: () => setGitDiff(null),
    prepareFileOperation: async (target: string) => {
      const path = tabPathOf(target, cwd)
      for (const tab of latest.current.tabs.filter(tab => tab.path === path || tab.path.startsWith(path + '/'))) {
        const result = await workspace.saves.flush(tab.path)
        if (result.some(item => !item.ok) || workspace.saves.state(tab.path).dirty) { setError('相关文件尚未保存，已取消文件操作'); return false }
      }
      return true
    },
  }
  React.useEffect(() => {
    if (!props.editorActions) return
    const actions = {
      openGitDiff: (path: string, staged: boolean, repositoryRoot?: string) => { setGitDiff({ cwd: repositoryRoot || cwd || '', path, staged }); setPreview(false) },
      closeGitDiff: () => setGitDiff(null), notify: setError,
      refreshFile: () => { if (active && workspace.documents.has(active)) void workspace.load(active, undefined, true).catch(cause => setError(String(cause))) },
    }
    props.editorActions.current = actions
    return () => { if (props.editorActions.current === actions) props.editorActions.current = null }
  }, [props.editorActions, cwd, active, workspace])
  const status = active ? workspace.saves.state(active) : null
  const markdown = !!active && !large && /\.(?:md|markdown)$/i.test(active) && workspace.documents.has(active)
  const button = (label: string, text: React.ReactNode, run: () => void, pressed?: boolean) => React.createElement('button', { type: 'button', title: label, 'aria-label': label, 'aria-pressed': pressed, onClick: run }, text)
  const embeddedTools = React.createElement('div', { className: 'cstudio-minimal-tools' },
    markdown ? button(preview ? '编辑 Markdown' : '预览 Markdown', preview ? '编辑' : '预览', () => {
      setPreviewText(active ? workspace.documents.get(active)?.model.getValue() ?? '' : ''); setPreview(value => !value)
    }) : null)
  const editorActive = visible && !!active && presented?.path === active && !preview && !gitDiff && !large
  return React.createElement('div', { ref: root, className: 'edrv-view-side cstudio-minimal', 'data-edrv-view': '1', 'data-edrv-layout': 'side' },
    embedded ? (props.toolbarTarget ? createPortal(embeddedTools, props.toolbarTarget) : null) : React.createElement('div', { className: 'cstudio-minimal-bar' },
      React.createElement('div', { className: 'edrv-tabs', role: 'tablist', 'aria-label': '打开的文件' }, tabs.map(tab => React.createElement('div', {
        key: tab.path, className: 'edrv-tab' + (tab.path === active ? ' edrv-tab-active' : ''), role: 'tab', 'aria-selected': tab.path === active, tabIndex: 0, title: tab.path,
        onClick: () => { setActive(tab.path); setGitDiff(null); setPreview(false) },
        onKeyDown: (event: React.KeyboardEvent) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setActive(tab.path) } },
      }, React.createElement('span', null, tab.path.split(/[\\/]/).pop()),
      workspace.saves.state(tab.path).dirty ? React.createElement('span', { title: '未保存', 'aria-label': '未保存' }, ' •') : null,
      React.createElement('button', { type: 'button', className: 'edrv-tab-close', 'aria-label': `关闭 ${tab.path}`, onClick: (event: React.MouseEvent) => { event.stopPropagation(); void close(tab.path) } }, '×')))),
      React.createElement('div', { className: 'cstudio-minimal-tools' },
        button('工作区文件', React.createElement(IconFolderOpenOutline16, { size: 16 }), openFiles),
        button('Git 修改', React.createElement(IconBranchOutline16, { size: 16 }), () => setSidebar(value => !value), sidebar)),
      markdown ? button(preview ? '编辑 Markdown' : '预览 Markdown', preview ? '编辑' : '预览', () => {
        setPreviewText(active ? workspace.documents.get(active)?.model.getValue() ?? '' : ''); setPreview(value => !value)
      }) : null),
    quick ? React.createElement('div', { className: 'cstudio-minimal-quick' }, React.createElement(QuickOpen, { sessionId, onOpen: open }), button('关闭搜索', '×', () => setQuick(false))) : null,
    React.createElement('div', { className: 'cstudio-minimal-body' },
      sidebar && !embedded ? React.createElement('aside', { className: 'cstudio-minimal-git', 'aria-label': 'Git 修改' }, React.createElement(GitPanel, { ctx: context })) : null,
      React.createElement('div', { className: 'cstudio-minimal-document edrv-editor-row' },
        React.createElement('div', { ref: host, className: 'cstudio-minimal-editor', 'data-cstudio-engine': editorName, 'data-cstudio-editor-active': editorActive ? 'true' : undefined, style: { visibility: active && !preview && !gitDiff && !large ? 'visible' : 'hidden' } }),
        large && active && !gitDiff ? React.createElement('div', { className: 'cstudio-minimal-preview' }, React.createElement(LargeTextView, {
          sessionId: sessionId || '', path: active,
          loadPage: async args => { const result = await rpc('cstudio.textPage', args); return result.ok ? result : { ok: false, error: result.error, reason: result.reason ?? 'read-failed' } },
        })) : null,
        gitDiff ? React.createElement(GitDiffView, { ...gitDiff, sessionId, workspaceRoot: cwd, onClose: () => setGitDiff(null) }) : null,
        preview && !gitDiff ? React.createElement('div', { className: 'cstudio-minimal-preview' }, React.createElement(MarkdownText as any, { text: previewText, streaming: false, labels: { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' }, variant: 'body' })) : null,
        !active && !gitDiff ? React.createElement('div', { className: 'cstudio-minimal-empty' },
          embedded ? React.createElement('p', null, '从右侧文件树选择文件') : React.createElement(React.Fragment, null, React.createElement(IconFolderOpenOutline16, { size: 28 }),
            React.createElement('p', null, '从工作区打开文件'), button('工作区文件', '浏览文件', openFiles))) : null,
        visible && !gitDiff && (loading || (needsEditor && !engine && !error))
          ? React.createElement('div', { className: 'cstudio-minimal-loading', role: 'status' }, engine ? '正在读取文件…' : '正在打开…') : null)),
    error || workspace.error ? React.createElement('div', { className: 'cstudio-minimal-error', role: 'alert' },
      React.createElement('span', null, error || workspace.error),
      active && workspace.documents.has(active) ? button('复制本地内容', '复制内容', () => { void copyText(workspace.documents.get(active)!.model.getValue(), '内容已复制', setError) }) : null,
      active && workspace.documents.has(active) ? button('从磁盘重新加载', '重新加载', () => {
        if (workspace.saves.state(active).dirty && !window.confirm('放弃此文件尚未保存的编辑，并重新读取磁盘内容？')) return
        void workspace.reload(active).then(() => setError(''))
      }) : null,
      button('关闭提示', '×', () => { setError(''); workspace.error = ''; workspace.notify() })) : null,
    (!props.nativeDocument || large || status?.conflict || status?.saving || status?.dirty) ? React.createElement('div', { className: 'cstudio-minimal-status' }, React.createElement('span', { title: active || '' }, props.nativeDocument ? null : active || '未打开文件'), React.createElement('span', null, large ? '大文件只读预览' : status?.conflict ? '外部修改冲突' : status?.saving ? '正在保存' : status?.dirty ? '未保存' : active ? '已保存' : '')) : null,
    React.createElement(CommandPalette, { sessionId }))
}
