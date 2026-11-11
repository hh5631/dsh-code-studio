import React from 'react'
import { createPortal } from 'react-dom'
import { DOCUMENT_EDITOR_ID } from '../documentRenderer.js'
import { buildFileAddress, type SidebarRightServiceLike } from '../officialSidebar.js'
import { workspaceScopeOf } from '../state/scopeStore.js'
import { minimalWorkspace } from '../state/minimalWorkspace.js'
import { normalizedPath } from '../state/gitPaths.js'
import { tabPathOf } from '../tabActions.js'
import { GitDiffView } from './GitDiffView.js'
import { WorkspacePanel, type EditorPanelActions, type WorkspacePanelActions } from './WorkspacePanel.js'

/** 官方文档动作扩展：即使从编辑器切换到原生预览，仍可使用 Git 和搜索。 */
export function NativePreviewTools({ absolutePath, sessionId, sessions, service }: {
  absolutePath: string; sessionId?: string; sessions?: any; service?: SidebarRightServiceLike
}): React.ReactElement {
  const anchor = React.useRef<HTMLSpanElement>(null)
  const [body, setBody] = React.useState<HTMLElement | null>(null)
  const [diff, setDiff] = React.useState<{ path: string; cwd: string; staged: boolean } | null>(null)
  const [message, setMessage] = React.useState('')
  const actions = React.useRef<WorkspacePanelActions | null>(null)
  const editorActions = React.useRef<EditorPanelActions | null>(null)
  const beforeNavigate = React.useRef<(() => Promise<boolean>) | null>(null)
  const list = sessions?.list
  const cwd: string | null = React.useSyncExternalStore(
    React.useCallback(listener => list?.subscribe?.(listener) ?? (() => {}), [list]),
    () => list?.getSnapshot?.()?.byId?.[sessionId ?? '']?.cwd ?? null, () => null)
  const scope = workspaceScopeOf(cwd, sessionId)

  React.useLayoutEffect(() => {
    const preview = anchor.current?.closest('[data-textpreview-state]')
    const content = preview?.querySelector('[data-textpreview-content]')
    if (!preview || !content) return
    const sync = () => {
      const editing = preview.getAttribute('data-document-preview') === DOCUMENT_EDITOR_ID
      setBody(editing ? null : content.querySelector<HTMLElement>(':scope > [data-textpreview-body]'))
    }
    const observer = new MutationObserver(sync)
    observer.observe(preview, { attributes: true, attributeFilter: ['data-document-preview'] })
    observer.observe(content, { childList: true })
    sync()
    return () => observer.disconnect()
  }, [])

  React.useEffect(() => { setDiff(null); setMessage('') }, [absolutePath, body])
  const toolbar = anchor.current?.parentElement ?? null
  const pane = anchor.current?.closest<HTMLElement>('[data-dockkit-pane], [data-dockkit-float]')
  const paneId = pane?.dataset.dockkitPane ?? pane?.dataset.dockkitFloat
  const prepare = async () => {
    const workspace = minimalWorkspace(scope, sessionId)
    const path = tabPathOf(absolutePath, cwd)
    const saved = await workspace.saves.flush(path)
    if (saved.every(result => result.ok) && !workspace.saves.state(path).dirty) return true
    setMessage('文件尚未保存，请回到编辑器处理')
    return false
  }
  beforeNavigate.current = prepare
  editorActions.current = {
    openGitDiff: (path, staged, root) => { if (root) setDiff({ path, staged, cwd: root }) },
    closeGitDiff: () => setDiff(null),
    notify: setMessage,
    refreshFile: () => toolbar?.querySelector<HTMLButtonElement>('[data-textpreview-tool="reload"]')?.click(),
  }
  const openPath = async (path: string, line?: number, column?: number) => {
    const marker = anchor.current
    if (!marker || !await prepare() || !marker.isConnected) return
    try {
      service?.openResource?.(buildFileAddress(path, sessionId), {
        paneId, replaceTab: marker.closest<HTMLElement>('[data-sidebar-right-tab]')?.dataset.sidebarRightTab,
        params: line === undefined ? undefined : { line, column },
      })
    } catch { setMessage('无法打开此文件') }
  }
  return React.createElement(React.Fragment, null,
    React.createElement('span', { ref: anchor, hidden: true }),
    body ? React.createElement(WorkspacePanel, {
      paneKey: `${sessionId}:${paneId}`, sessionId, cwd, scope, path: tabPathOf(absolutePath, cwd), visible: true,
      toolbarTarget: toolbar, nativeContent: body.parentElement,
      onOpen: () => {}, onOpenPath: (path, line, column) => { void openPath(path, line, column) },
      editorActions, actions, beforeNavigate,
    }) : null,
    body && (diff || message) ? createPortal(React.createElement('div', { className: 'cstudio-preview-overlay' },
      diff ? React.createElement(GitDiffView, { ...diff, sessionId, workspaceRoot: cwd, onClose: () => setDiff(null),
        onApplied: (path: string) => { if (path === normalizedPath(absolutePath)) editorActions.current?.refreshFile() } }) : null,
      message ? React.createElement('button', { type: 'button', className: 'cstudio-preview-message', onClick: () => setMessage('') }, message, ' ×') : null), body) : null)
}
