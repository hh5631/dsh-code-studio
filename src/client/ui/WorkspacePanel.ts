/** 在原生导航容器中切换文件、Git 与搜索，沿用原生宽度、拖拽和窄屏行为。 */
import React from 'react'
import { createPortal } from 'react-dom'
import { GitPanel } from '../sidebar/panels/GitPanel.js'
import { SearchPanel } from '../sidebar/panels/SearchPanel.js'
import { gitDecorations, absolutePath, repositoryDirectory } from '../state/gitPaths.js'
import { useGitStore } from '../state/gitStore.js'
import { StudioIcon } from './StudioIcon.js'
import '../styles/workspace.css'

export type WorkspaceView = 'files' | 'git' | 'search'
export interface EditorPanelActions {
  openGitDiff(path: string, staged: boolean, root?: string): void
  closeGitDiff(): void
  notify(message: string): void
  refreshFile(): void
}
export interface WorkspacePanelActions { show(view: WorkspaceView): void }
interface Props {
  paneKey: string; sessionId?: string; cwd: string | null; scope: string; path: string; visible: boolean
  useTabInfo?: () => any
  factory?: (name: string, props: any) => React.ReactNode
  toolbarTarget: HTMLElement | null
  onOpen(address: string): void
  onOpenPath(path: string, line?: number, column?: number): void
  editorActions: React.MutableRefObject<EditorPanelActions | null>
  actions: React.MutableRefObject<WorkspacePanelActions | null>
  beforeNavigate: React.MutableRefObject<(() => Promise<boolean>) | null>
}
const modes = new Map<string, WorkspaceView>()
const treeScroll = new Map<string, number>()

export function WorkspacePanel(props: Props): React.ReactElement {
  const [view, setView] = React.useState<WorkspaceView>(() => modes.get(props.paneKey) ?? 'files')
  const [open, setOpen] = React.useState(false)
  const [body, setBody] = React.useState<HTMLElement | null>(null)
  const treeHost = React.useRef<HTMLSpanElement>(null)
  const controls = React.useRef<HTMLDivElement>(null)
  const scriptedClick = React.useRef(false)
  const { store, snapshot } = useGitStore(repositoryDirectory(props.cwd, props.path), props.visible, props.scope)
  const decorations = React.useMemo(() => snapshot.data ? gitDecorations(snapshot.data.root, snapshot.data.changes) : new Map(), [snapshot.data])
  const decorationRef = React.useRef(decorations)
  decorationRef.current = decorations

  const choose = React.useCallback((next: WorkspaceView) => {
    const body = treeHost.current?.querySelector<HTMLElement>('[data-files-body]')
    if (view === 'files' && next !== 'files' && body) treeScroll.set(props.paneKey, body.scrollTop)
    modes.set(props.paneKey, next); setView(next)
  }, [props.paneKey, view])
  React.useLayoutEffect(() => {
    const saved = treeScroll.get(props.paneKey)
    if (view === 'files' && body && saved !== undefined) body.scrollTop = saved
  }, [view, body, props.paneKey])
  const nativeButton = () => controls.current?.querySelector<HTMLButtonElement>('[data-files-navigator-toggle]')
  const setShown = (shown: boolean) => {
    const button = nativeButton()
    if (!button || (button.getAttribute('aria-expanded') === 'true') === shown) return
    scriptedClick.current = true
    try { button.click() } finally { scriptedClick.current = false }
  }
  const show = (next: WorkspaceView) => { choose(next); setShown(true) }
  React.useEffect(() => { setView(modes.get(props.paneKey) ?? 'files') }, [props.paneKey])
  React.useEffect(() => {
    const handle = { show }
    props.actions.current = handle
    return () => { if (props.actions.current === handle) props.actions.current = null }
  })

  const decorate = () => {
    if (!treeHost.current || !props.cwd) return
    for (const row of Array.from(treeHost.current.querySelectorAll<HTMLElement>('[data-files-path]'))) {
      const path = row.getAttribute('data-files-path')
      const tone = path ? decorationRef.current.get(absolutePath(props.cwd, path)) : undefined
      if (tone) row.setAttribute('data-cstudio-git', tone)
      else row.removeAttribute('data-cstudio-git')
    }
  }
  React.useLayoutEffect(decorate, [decorations, props.cwd])
  React.useEffect(() => {
    let frame: number | undefined
    const sync = () => {
      const next = treeHost.current?.querySelector<HTMLElement>('[data-files-body]') ?? null
      setBody(previous => previous === next ? previous : next)
      setOpen(nativeButton()?.getAttribute('aria-expanded') === 'true')
      decorate()
    }
    const schedule = () => { if (frame === undefined) frame = requestAnimationFrame(() => { frame = undefined; sync() }) }
    const treeObserver = new MutationObserver(schedule), toggleObserver = new MutationObserver(schedule)
    if (treeHost.current) treeObserver.observe(treeHost.current, { childList: true, subtree: true })
    if (controls.current) toggleObserver.observe(controls.current, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-expanded'] })
    sync()
    return () => { treeObserver.disconnect(); toggleObserver.disconnect(); if (frame !== undefined) cancelAnimationFrame(frame) }
  }, [props.toolbarTarget, props.cwd])

  const ctx = {
    sessionId: props.sessionId, cwd: props.cwd, scope: props.scope, visible: props.visible,
    activePath: props.path, openFile: props.onOpenPath, openFileAt: props.onOpenPath, gitStore: store,
    openGitDiff: (path: string, staged: boolean, root?: string) => props.editorActions.current?.openGitDiff(path, staged, root),
    notify: (message: string) => props.editorActions.current?.notify(message),
    prepareFileOperation: async () => props.beforeNavigate.current ? props.beforeNavigate.current() : true,
    gitChanged: (method?: string) => {
      props.editorActions.current?.closeGitDiff()
      if (method === 'git.discard') props.editorActions.current?.refreshFile()
    },
  }
  const tools = React.createElement('div', { ref: controls, className: 'cstudio-workspace-switches', role: 'toolbar', 'aria-label': '右侧面板' },
    React.createElement('span', { className: 'cstudio-files-switch', 'data-active': open && view === 'files' ? '' : undefined,
      onClickCapture: (event: React.MouseEvent) => {
        if (scriptedClick.current) return
        if (view !== 'files') { choose('files'); if (open) { event.preventDefault(); event.stopPropagation() } }
      } }, props.factory?.('sidebar.files.navigator.toggle', { useTabInfo: props.useTabInfo }),
      React.createElement('span', { className: 'cstudio-folder-glyph' }, React.createElement(StudioIcon, { name: 'folder', size: 18 }))),
    ...(['git', 'search'] as const).map(mode => React.createElement('button', { key: mode, type: 'button', title: mode === 'git' ? 'Git' : '搜索', 'aria-label': mode === 'git' ? 'Git' : '搜索', 'aria-pressed': open && view === mode,
      onClick: () => { if (open && view === mode) setShown(false); else show(mode) } }, React.createElement(StudioIcon, { name: mode === 'git' ? 'branch' : 'search', size: 18 }))))
  return React.createElement(React.Fragment, null,
    props.toolbarTarget ? createPortal(tools, props.toolbarTarget) : null,
    React.createElement('span', { ref: treeHost, style: { display: 'contents' } }, props.factory?.('sidebar.files.navigator', { useTabInfo: props.useTabInfo, page: false, onOpen: props.onOpen })),
    body && view !== 'files' ? createPortal(React.createElement('section', { className: 'cstudio-side-panel', role: 'region', 'aria-label': view === 'git' ? 'Git 面板' : '搜索面板' },
      view === 'git' ? React.createElement(GitPanel, { ctx }) : React.createElement(SearchPanel, { ctx, key: props.scope })), body) : null)
}
