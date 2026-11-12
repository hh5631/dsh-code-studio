/** 在原生导航容器中切换文件、Git 与搜索，沿用原生宽度、拖拽和窄屏行为。 */
import React from 'react'
import { createPortal } from 'react-dom'
import { GitPanel } from '../sidebar/panels/GitPanel.js'
import { SearchPanel } from '../sidebar/panels/SearchPanel.js'
import { gitDecorations, absolutePath, repositoryDirectory } from '../state/gitPaths.js'
import { useGitStore } from '../state/gitStore.js'
import { CACHE_KEY } from '../paths.js'
import { StudioIcon } from './StudioIcon.js'
import { IconSearchOutline16 } from './icons.js'
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
  nativeContent?: HTMLElement | null
  workspaceContent?: HTMLElement | null
  openFilesOnEntry?: boolean
  onOpen(address: string): void
  onOpenPath(path: string, line?: number, column?: number): void
  editorActions: React.MutableRefObject<EditorPanelActions | null>
  actions: React.MutableRefObject<WorkspacePanelActions | null>
  beforeNavigate: React.MutableRefObject<(() => Promise<boolean>) | null>
}
const modes = new Map<string, WorkspaceView>()
const treeScroll = new Map<string, number>()
const treeOwners = new WeakMap<HTMLElement, object>()
const layoutOwners = new WeakMap<HTMLElement, object>()
type TreeSide = 'left' | 'right'
const sideListeners = new Set<() => void>()
let treeSide: TreeSide | undefined

function readTreeSide(): TreeSide {
  if (treeSide) return treeSide
  try { return localStorage.getItem(CACHE_KEY.fileTreeSide) === 'left' ? 'left' : 'right' }
  catch { return 'right' }
}

function subscribeTreeSide(listener: () => void): () => void {
  sideListeners.add(listener)
  return () => { sideListeners.delete(listener) }
}

function writeTreeSide(side: TreeSide): void {
  treeSide = side
  try { localStorage.setItem(CACHE_KEY.fileTreeSide, side) } catch { /* Keep the preference for this page. */ }
  for (const listener of sideListeners) listener()
}

export function WorkspacePanel(props: Props): React.ReactElement {
  const side = React.useSyncExternalStore(subscribeTreeSide, readTreeSide, () => 'right' as const)
  const [view, setView] = React.useState<WorkspaceView>(() => modes.get(props.paneKey) ?? 'files')
  const [open, setOpen] = React.useState(false)
  const [body, setBody] = React.useState<HTMLElement | null>(null)
  const [toolsTarget, setToolsTarget] = React.useState<HTMLElement | null>(null)
  const content = props.nativeContent ?? props.workspaceContent
  const openedOnEntry = React.useRef<string | null>(null)
  const scriptedClick = React.useRef(false)
  const { store, snapshot } = useGitStore(repositoryDirectory(props.cwd, props.path), props.visible, props.scope)
  const decorations = React.useMemo(() => snapshot.data ? gitDecorations(snapshot.data.root, snapshot.data.changes) : new Map(), [snapshot.data])
  const decorationRef = React.useRef(decorations)
  decorationRef.current = decorations

  const choose = React.useCallback((next: WorkspaceView) => {
    if (view === 'files' && next !== 'files' && body) treeScroll.set(props.paneKey, body.scrollTop)
    modes.set(props.paneKey, next); setView(next)
  }, [body, props.paneKey, view])
  React.useLayoutEffect(() => {
    const saved = treeScroll.get(props.paneKey)
    if (view === 'files' && body && saved !== undefined) body.scrollTop = saved
  }, [view, body, props.paneKey])
  const nativeButton = React.useCallback(() =>
    props.toolbarTarget?.querySelector<HTMLButtonElement>('[data-files-navigator-toggle]'), [props.toolbarTarget])
  const openTree = React.useCallback((button = nativeButton()) => {
    if (!button || button.getAttribute('aria-expanded') === 'true') return
    scriptedClick.current = true
    try { button.click() } finally { scriptedClick.current = false }
  }, [nativeButton])
  const show = (next: WorkspaceView) => { choose(next); openTree() }
  React.useLayoutEffect(() => {
    // The dock outlives its file body, including the gap before preview actions mount.
    if (props.visible && props.cwd) {
      props.toolbarTarget?.closest('[data-dockkit-pane], [data-dockkit-float]')?.setAttribute('data-cstudio-dock-side', side)
    }
  }, [props.toolbarTarget, props.visible, props.cwd, side])
  React.useLayoutEffect(() => {
    if (!content || side !== 'left') return
    const ownership = {}
    layoutOwners.set(content, ownership)
    content.setAttribute('data-cstudio-tree-side', side)
    const isResizeHandle = (target: EventTarget | null) =>
      layoutOwners.get(content) === ownership
      && target instanceof Element && target.matches('[data-files-navigator] > [data-files-navigator-resize]')
      && target.parentElement?.parentElement === content
    // DSH calculates width from the right edge. Mirror the input at the moved divider
    // so the host still handles width limits, pointer capture and persistence.
    const mirrorPointer = (event: PointerEvent) => {
      if (isResizeHandle(event.target)) Object.defineProperty(event, 'clientX', { value: -event.clientX })
    }
    const mirrorArrow = (event: KeyboardEvent) => {
      if (!isResizeHandle(event.target)) return
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        Object.defineProperty(event, 'key', { value: event.key === 'ArrowLeft' ? 'ArrowRight' : 'ArrowLeft' })
      }
    }
    content.addEventListener('pointerdown', mirrorPointer, true)
    content.addEventListener('pointermove', mirrorPointer, true)
    content.addEventListener('keydown', mirrorArrow, true)
    return () => {
      if (layoutOwners.get(content) === ownership) {
        layoutOwners.delete(content)
        content.removeAttribute('data-cstudio-tree-side')
      }
      content.removeEventListener('pointerdown', mirrorPointer, true)
      content.removeEventListener('pointermove', mirrorPointer, true)
      content.removeEventListener('keydown', mirrorArrow, true)
    }
  }, [content, side])
  React.useLayoutEffect(() => { setView(modes.get(props.paneKey) ?? 'files') }, [props.paneKey])
  React.useEffect(() => {
    const handle = { show }
    props.actions.current = handle
    return () => { if (props.actions.current === handle) props.actions.current = null }
  })

  const decorate = React.useCallback((tree: HTMLElement | null) => {
    if (!tree || !props.cwd) return
    for (const row of Array.from(tree.querySelectorAll<HTMLElement>('[data-files-path]'))) {
      const path = row.getAttribute('data-files-path')
      const tone = path ? decorationRef.current.get(absolutePath(props.cwd, path)) : undefined
      if (tone) row.setAttribute('data-cstudio-git', tone)
      else row.removeAttribute('data-cstudio-git')
    }
  }, [props.cwd])
  React.useLayoutEffect(() => decorate(body), [body, decorations, decorate])
  React.useLayoutEffect(() => {
    const owner = content
    const toolbar = props.toolbarTarget
    const useNativeTree = props.nativeContent !== undefined
    if (!props.visible) openedOnEntry.current = null
    const ownership = {}
    let tree: HTMLElement | null = null
    let frame: number | undefined
    let live = true, replaying = false, navigation = 0
    const openFile = (event: MouseEvent) => {
      const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-files-entry="file"] > div > button') : null
      const prepare = props.beforeNavigate.current
      if (!button || !prepare || replaying || event.defaultPrevented) return
      event.preventDefault(); event.stopPropagation()
      const request = ++navigation
      void prepare().then(ready => {
        if (!ready || !live || request !== navigation || !tree?.contains(button)) return
        replaying = true
        try { button.click() } finally { replaying = false }
      }).catch(() => {})
    }
    const onToggle = (event: MouseEvent) => {
      if (!scriptedClick.current && event.target instanceof Element && event.target.closest('[data-files-navigator-toggle]')) {
        modes.set(props.paneKey, 'files'); setView('files')
      }
    }
    const detachTree = () => {
      if (tree && treeOwners.get(tree) === ownership) {
        tree.removeAttribute('data-cstudio-workspace-tree')
        tree.querySelectorAll('[data-cstudio-git]').forEach(row => row.removeAttribute('data-cstudio-git'))
        treeOwners.delete(tree)
      }
      tree?.removeEventListener('click', openFile, true)
      treeObserver.disconnect()
    }
    const sync = () => {
      const nextTree = owner?.querySelector<HTMLElement>('[data-files-navigator]') ?? null
      if (tree !== nextTree) {
        detachTree()
        tree = nextTree
        if (tree) {
          treeOwners.set(tree, ownership)
          tree.setAttribute('data-cstudio-workspace-tree', '')
          treeObserver.observe(tree, { childList: true, subtree: true })
          if (useNativeTree) tree.addEventListener('click', openFile, true)
        }
      }
      setBody(tree?.querySelector<HTMLElement>('[data-files-body]') ?? null)
      setToolsTarget(toolbar?.querySelector<HTMLElement>('[data-cstudio-document-tools]') ?? null)
      const button = nativeButton()
      if (props.openFilesOnEntry && props.visible && button && openedOnEntry.current !== props.paneKey) {
        openedOnEntry.current = props.paneKey
        modes.set(props.paneKey, 'files')
        setView('files')
        openTree(button)
      }
      setOpen(button?.getAttribute('aria-expanded') === 'true')
      decorate(tree)
    }
    const schedule = () => { if (frame === undefined) frame = requestAnimationFrame(() => { frame = undefined; sync() }) }
    const treeObserver = new MutationObserver(schedule)
    const ownerObserver = new MutationObserver(schedule)
    const toggleObserver = new MutationObserver(schedule)
    if (owner) ownerObserver.observe(owner, { childList: true })
    if (toolbar) {
      toolbar.addEventListener('click', onToggle, true)
      toggleObserver.observe(toolbar, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-expanded'] })
    }
    sync()
    return () => {
      live = false
      detachTree(); ownerObserver.disconnect(); toggleObserver.disconnect()
      toolbar?.removeEventListener('click', onToggle, true)
      if (frame !== undefined) cancelAnimationFrame(frame)
    }
  }, [content, props.toolbarTarget, props.nativeContent, props.paneKey, props.beforeNavigate,
    props.openFilesOnEntry, props.visible, decorate, nativeButton, openTree])

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
  const nextSide = side === 'left' ? 'right' : 'left'
  const sideLabel = nextSide === 'left' ? '将文件树移到左侧' : '将文件树移到右侧'
  const tools = props.cwd && toolsTarget ? createPortal(
    React.createElement('div', { className: 'cstudio-workspace-switches', role: 'group', 'aria-label': '工作区工具' },
      ...(['git', 'search'] as const).map(mode => {
        const label = mode === 'git' ? 'Git' : '搜索'
        const icon = mode === 'git' ? React.createElement(StudioIcon, { name: 'branch', size: 15 }) : React.createElement(IconSearchOutline16, { size: 15 })
        return React.createElement('button', { key: mode, type: 'button', title: label, 'aria-label': label,
          'aria-pressed': open && view === mode, onClick: () => show(open && view === mode ? 'files' : mode) }, icon)
      }),
      React.createElement('button', {
        type: 'button', title: sideLabel, 'aria-label': sideLabel,
        onClick: () => {
          writeTreeSide(nextSide)
          if (!open) show('files')
        },
      }, React.createElement(StudioIcon, { name: 'swapTreeSide', size: 15 }))),
    toolsTarget) : null
  return React.createElement(React.Fragment, null,
    tools,
    props.nativeContent === undefined
      ? props.factory?.('sidebar.files.navigator', { useTabInfo: props.useTabInfo, page: false, onOpen: props.onOpen }) : null,
    body && view !== 'files' ? createPortal(React.createElement('section', { className: 'cstudio-side-panel', role: 'region', 'aria-label': view === 'git' ? 'Git 面板' : '搜索面板' },
      view === 'git' ? React.createElement(GitPanel, { ctx }) : React.createElement(SearchPanel, { ctx, key: props.scope })), body) : null)
}
