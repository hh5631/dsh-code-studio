/** 极简文件工作台：复用 Monaco 与文件模型，只保留 Git 差异入口。 */
import React from 'react'
import { createPortal } from 'react-dom'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { loadMonaco } from '../monaco/loader.js'
import { applyOfficial, editorFont, registerThemes, observeScheme } from '../monaco/theme.js'
import { setupLsp, setSession } from '../monaco/lsp/index.js'
import { createViewKeeper } from '../state/editorViewState.js'
import { minimalWorkspace } from '../state/minimalWorkspace.js'
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
import { TYPOGRAPHY_EVENT } from '../typography.js'
import { QuickOpen } from './QuickOpen.js'
import { CommandPalette } from './CommandPalette.js'
import { GitDiffView } from './GitDiffView.js'
import { promptName } from './PromptDialog.js'
import { revealInExplorer } from '../fileReveal.js'
import { onUiStateReady } from '../state/uiStatePersist.js'
import { copyText } from '../copyText.js'
import { rpc } from '../rpc.js'
import { LargeTextView } from './LargeTextView.js'
import '../styles/minimal.css'

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
  const [monaco, setMonaco] = React.useState<any>(null)
  const [ready, setReady] = React.useState(0)
  const [loading, setLoading] = React.useState(false)
  const [large, setLarge] = React.useState(false)
  const [error, setError] = React.useState('')
  const [sidebar, setSidebar] = React.useState(false)
  const [preview, setPreview] = React.useState(false)
  const [previewText, setPreviewText] = React.useState('')
  const [quick, setQuick] = React.useState(false)
  const [gitDiff, setGitDiff] = React.useState<{ cwd: string; path: string; staged: boolean } | null>(null)
  const host = React.useRef<HTMLDivElement>(null), root = React.useRef<HTMLDivElement>(null)
  const editor = React.useRef<any>(null), keeper = React.useRef<any>(null)
  const bound = React.useRef<string | null>(null)
  const pendingLine = React.useRef<{ path: string; line: number; column: number } | null>(null)
  const latest = React.useRef({ active, tabs, visible: props.visible !== false })
  latest.current = { active, tabs, visible: props.visible !== false }
  React.useEffect(() => { setPreview(false); setGitDiff(null) }, [active])
  const openFiles = React.useCallback(() => {
    if (props.openWorkspaceFiles?.() !== true) setQuick(true)
  }, [props.openWorkspaceFiles])

  const persist = React.useCallback(() => {
    if (!embedded) try { localStorage.setItem(CACHE_KEY.editor + scope, JSON.stringify({ tabs: latest.current.tabs, active: latest.current.active })) } catch {}
    if (bound.current && editor.current) {
      const document = workspace.documents.get(bound.current)
      if (document) document.view = editor.current.saveViewState()
    }
    keeper.current?.save?.()
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
      editor.current.setPosition({ lineNumber: line, column: column || 1 }); editor.current.revealLineInCenter(line); editor.current.focus()
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
  React.useEffect(() => {
    let alive = true
    void loadMonaco(() => {}).then((value: any) => { if (alive) setMonaco(value) }).catch((cause: unknown) => { if (alive) setError(String(cause)) })
    return () => { alive = false }
  }, [])
  React.useLayoutEffect(() => {
    if (!monaco || !host.current) return
    registerThemes(monaco); const theme = applyOfficial(monaco)
    const instance = monaco.editor.create(host.current, {
      model: null, theme, ...editorFont(), automaticLayout: false,
      minimap: { enabled: false }, glyphMargin: false, overviewRulerLanes: 0,
      scrollBeyondLastLine: false, smoothScrolling: true, cursorSmoothCaretAnimation: 'on',
      renderLineHighlight: 'line', folding: true, wordWrap: 'off',
      stickyScroll: { enabled: false }, codeLens: false, padding: { top: 10, bottom: 10 },
    })
    editor.current = instance; keeper.current = createViewKeeper(instance); setReady(value => value + 1)
    const syncFont = () => { instance.updateOptions(editorFont()); monaco.editor.remeasureFonts?.() }
    const syncTheme = () => { applyOfficial(monaco); syncFont() }
    const stopTheme = observeScheme(syncTheme)
    window.addEventListener(TYPOGRAPHY_EVENT, syncFont)
    window.addEventListener('edrv:theme-change', syncTheme)
    let frame: number | undefined
    const measure = () => { if (frame === undefined) frame = requestAnimationFrame(() => { frame = undefined; instance.layout() }) }
    const observer = new ResizeObserver(measure); observer.observe(host.current)
    setSession(sessionId); void setupLsp(monaco)
    return () => {
      window.removeEventListener(TYPOGRAPHY_EVENT, syncFont); window.removeEventListener('edrv:theme-change', syncTheme)
      persist(); observer.disconnect(); stopTheme?.(); if (frame !== undefined) cancelAnimationFrame(frame)
      keeper.current?.dispose?.(); keeper.current = null; editor.current = null; bound.current = null
    }
  }, [monaco, workspace, persist])
  React.useEffect(() => {
    const instance = editor.current
    if (!instance || !monaco) return
    let alive = true
    if (bound.current) { const old = workspace.documents.get(bound.current); if (old) old.view = instance.saveViewState() }
    keeper.current?.save?.(); setActiveEditorPath(active)
    if (!active) { instance.setModel(null); bound.current = null; return }
    const cached = workspace.documents.has(active)
    if (!cached) { instance.setModel(null); bound.current = null }
    setLoading(!cached); setError(''); setLarge(false)
    void workspace.load(active, monaco).then(entry => {
      if (!alive) return
      keeper.current.bind(scope, active, entry.model); bound.current = active
      if (entry.view) instance.restoreViewState(entry.view)
      const jump = pendingLine.current
      if (jump?.path === active) {
        instance.setPosition({ lineNumber: jump.line, column: jump.column }); instance.revealLineInCenter(jump.line); instance.focus(); pendingLine.current = null
      }
      setLoading(false); void workspace.refresh(active, monaco)
    }).catch(cause => {
      if (!alive) return
      instance.setModel(null); bound.current = null; setLoading(false)
      if (cause?.code === 'file-too-large') setLarge(true)
      else setError(String(cause))
    })
    return () => { alive = false }
  }, [active, monaco, ready, scope, workspace])
  React.useEffect(() => {
    const focus = () => {
      const current = latest.current
      if (document.visibilityState !== 'hidden' && current.visible && current.active && monaco) void workspace.refresh(current.active, monaco)
    }
    window.addEventListener('focus', focus); document.addEventListener('visibilitychange', focus)
    return () => { window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus) }
  }, [monaco, workspace])
  React.useEffect(() => { if (props.visible !== false) setSession(sessionId) }, [sessionId, props.visible])
  React.useEffect(() => {
    const action = (name: string) => { void editor.current?.getAction(name)?.run() }
    const cycle = (step: number) => {
      const current = latest.current
      if (!current.tabs.length) return
      const index = current.tabs.findIndex(tab => tab.path === current.active)
      setActive(current.tabs[(index + step + current.tabs.length) % current.tabs.length].path)
    }
    const commands: Record<string, () => void> = {
      save: () => { const path = latest.current.active; if (path && workspace.documents.has(path)) void workspace.save(path) },
      closeTab: () => { if (latest.current.active) void close(latest.current.active) },
      toggleSidebar: openFiles, goToLine: () => action('editor.action.gotoLine'),
      toggleComment: () => action('editor.action.commentLine'), duplicateLine: () => action('editor.action.copyLinesDownAction'),
      goToDefinition: () => action('editor.action.revealDefinition'), findReferences: () => action('editor.action.referenceSearch'),
      openInExplorer: () => { if (latest.current.active) void revealInExplorer(sessionId, latest.current.active) },
      nextTab: () => cycle(1), prevTab: () => cycle(-1),
      toggleMarkdownPreview: () => {
        const path = latest.current.active
        if (!path || !/\.(?:md|markdown)$/i.test(path)) return
        setPreviewText(workspace.documents.get(path)?.model.getValue() ?? ''); setPreview(value => !value)
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
      refreshFile: () => { if (active && monaco && workspace.documents.has(active)) void workspace.load(active, monaco, true).catch(cause => setError(String(cause))) },
    }
    props.editorActions.current = actions
    return () => { if (props.editorActions.current === actions) props.editorActions.current = null }
  }, [props.editorActions, cwd, active, monaco, workspace])
  const status = active ? workspace.saves.state(active) : null
  const markdown = !!active && !large && /\.(?:md|markdown)$/i.test(active)
  const button = (label: string, text: React.ReactNode, run: () => void, pressed?: boolean) => React.createElement('button', { type: 'button', title: label, 'aria-label': label, 'aria-pressed': pressed, onClick: run }, text)
  const embeddedTools = React.createElement('div', { className: 'cstudio-minimal-tools' },
    markdown ? button(preview ? '编辑 Markdown' : '预览 Markdown', preview ? '编辑' : '预览', () => {
      setPreviewText(active ? workspace.documents.get(active)?.model.getValue() ?? '' : ''); setPreview(value => !value)
    }) : null)
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
        React.createElement('div', { ref: host, className: 'cstudio-minimal-editor', style: { visibility: active && !preview && !gitDiff && !large ? 'visible' : 'hidden' } }),
        large && active && !gitDiff ? React.createElement('div', { className: 'cstudio-minimal-preview' }, React.createElement(LargeTextView, {
          sessionId: sessionId || '', path: active,
          loadPage: async args => { const result = await rpc('cstudio.textPage', args); return result.ok ? result : { ok: false, error: result.error, reason: result.reason ?? 'read-failed' } },
        })) : null,
        gitDiff ? React.createElement(GitDiffView, { ...gitDiff, onClose: () => setGitDiff(null) }) : null,
        preview && !gitDiff ? React.createElement('div', { className: 'cstudio-minimal-preview' }, React.createElement(MarkdownText as any, { text: previewText, streaming: false, labels: { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' }, variant: 'body' })) : null,
        !active && !gitDiff ? React.createElement('div', { className: 'cstudio-minimal-empty' },
          embedded ? React.createElement('p', null, '从右侧文件树选择文件') : React.createElement(React.Fragment, null, React.createElement(IconFolderOpenOutline16, { size: 28 }),
            React.createElement('p', null, '从工作区打开文件'), button('工作区文件', '浏览文件', openFiles))) : null,
        loading ? React.createElement('div', { className: 'cstudio-minimal-loading', role: 'status' }, '正在打开…') : null)),
    error || workspace.error ? React.createElement('div', { className: 'cstudio-minimal-error', role: 'alert' },
      React.createElement('span', null, error || workspace.error),
      active && workspace.documents.has(active) ? button('复制本地内容', '复制内容', () => { void copyText(workspace.documents.get(active)!.model.getValue(), '内容已复制', setError) }) : null,
      active && workspace.documents.has(active) ? button('从磁盘重新加载', '重新加载', () => {
        if (workspace.saves.state(active).dirty && !window.confirm('放弃此文件尚未保存的编辑，并重新读取磁盘内容？')) return
        void workspace.reload(active).then(() => setError(''))
      }) : null,
      button('关闭提示', '×', () => { setError(''); workspace.error = ''; workspace.notify() })) : null,
    React.createElement('div', { className: 'cstudio-minimal-status' }, React.createElement('span', { title: active || '' }, active || '未打开文件'), React.createElement('span', null, large ? '大文件只读预览' : status?.conflict ? '外部修改冲突' : status?.saving ? '正在保存' : status?.dirty ? '未保存' : active ? '已保存' : '')),
    React.createElement(CommandPalette, { sessionId }))
}
