/** 原生文件资源正文：一个文件页签、一份编辑内容，文件树复用 DSH Factory。 */
import React from 'react'
import * as Primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { LazyEditorView as EditorView } from './LazyEditorView.js'
import { WorkspacePanel, type EditorPanelActions, type WorkspacePanelActions, type WorkspaceView } from './WorkspacePanel.js'
import { buildPreviewFileAddress, parseOfficialFileAddress, resolveNavColumn, resolveNavLine, resolveNavOpen } from '../officialSidebar.js'
import { navigateFile, type NativePreviewResources } from '../nativeFileNavigation.js'
import { CACHE_KEY } from '../paths.js'
import { workspaceScopeOf } from '../state/scopeStore.js'

const initializedPanes = new Set<string>()
const PathLabel = (Primitives as { PathLabel?: React.ComponentType<{ path: string; className?: string }> }).PathLabel

interface RendererContent {
  kind: 'renderer'
  revision: number
  loaded(version: string): void
  failed(): void
}

export interface NativeProps {
  sessionId?: string
  useTabInfo?: () => any
  renderFactorySlot?: (name: string, props: any) => React.ReactNode
  previewResources?: NativePreviewResources
  [key: string]: any
}

export function NativeDocumentEditor(props: NativeProps & {
  resourceAddress: string; content: RendererContent; wrap: boolean
  useResource?: (address: string) => { value?: { version?: string; bytes?: number } }
}): React.ReactElement {
  const meta = props.useResource?.(props.resourceAddress)?.value
  return React.createElement(NativeFileTab, { ...props, documentVersion: meta?.version, documentSize: meta?.bytes })
}

export function NativeFileTab(props: NativeProps): React.ReactElement {
  const info = props.useTabInfo?.(), tab = info?.tab, panel = info?.panel
  const address = props.resourceAddress ?? tab?.navigation?.address ?? tab?.contentId
  const file = parseOfficialFileAddress(address)
  const content: RendererContent | undefined = props.content?.kind === 'renderer' ? props.content : undefined
  const nativeDocument = !!content
  const workspacePage = props.workspacePage === true
  const sessionId = file?.sessionId ?? props.sessionId
  const list = props.sessions?.list
  const cwd: string | null = React.useSyncExternalStore(
    React.useCallback(listener => list?.subscribe?.(listener) ?? (() => {}), [list]),
    () => list?.getSnapshot?.()?.byId?.[sessionId ?? '']?.cwd ?? null, () => null)
  const [panelToolbar, setPanelToolbar] = React.useState<HTMLElement | null>(null)
  const editorActions = React.useRef<EditorPanelActions | null>(null)
  const panelActions = React.useRef<WorkspacePanelActions | null>(null)
  const showWorkspacePanel = React.useCallback((view: WorkspaceView) => {
    panelActions.current?.show(view)
    return !!panelActions.current
  }, [])
  const openFilesPanel = React.useCallback(() => showWorkspacePanel('files'), [showWorkspacePanel])
  const [workspaceContent, setWorkspaceContent] = React.useState<HTMLDivElement | null>(null)
  const root = React.useRef<HTMLDivElement>(null)
  const [nativeContent, setNativeContent] = React.useState<HTMLElement | null>(null)
  const beforeNavigate = React.useRef<(() => Promise<boolean>) | null>(null)
  const previewResources = workspacePage ? props.previewResources : undefined
  const onOpen = React.useCallback((next: string, params?: object) => {
    void navigateFile(tab, next, beforeNavigate.current, params, previewResources)
  }, [tab?.actions, tab?.signal, previewResources])
  const onOpenPath = React.useCallback((path: string, line?: number, column?: number) => {
    if (sessionId) onOpen(buildPreviewFileAddress(path, sessionId, cwd), { line, column })
  }, [onOpen, sessionId, cwd])
  const factory = props.renderFactorySlot
  const paneKey = `${sessionId}:${panel?.id}`
  const previewAddress = file && sessionId ? buildPreviewFileAddress(file.path, sessionId, cwd) : null
  // 旧版自动开的编辑页签没有显式编辑标记；恢复时直接走原生查看，不挂载 编辑器。
  const migrating = !!previewAddress && !workspacePage && !nativeDocument
  const params = tab?.navigation?.params
  const line = resolveNavLine(params), column = resolveNavColumn(params)
  React.useEffect(() => {
    if (migrating && previewAddress && tab?.visible !== false) void navigateFile(tab, previewAddress, null, { line, column })
  }, [migrating, previewAddress, tab?.actions, tab?.signal, tab?.visible, line, column])

  React.useLayoutEffect(() => {
    if (!nativeDocument || !root.current) return
    const preview = root.current.closest('[data-textpreview-state]')
    setPanelToolbar(preview?.querySelector<HTMLElement>('[data-textpreview-path]')?.parentElement ?? null)
    setNativeContent(root.current.closest<HTMLElement>('[data-textpreview-content]'))
  }, [nativeDocument])

  const sourceVersion = React.useMemo(() => props.documentVersion, [address, content?.revision])
  const onDocumentLoad = React.useCallback((ok: boolean) => {
    if (!content) return
    if (ok) content.loaded(sourceVersion ?? props.documentVersion ?? '')
    else content.failed()
  }, [content, sourceVersion, props.documentVersion])

  React.useEffect(() => {
    if (tab?.visible === false || migrating) return
    if (workspacePage) {
      // 工作区入口已负责展开，进入编辑器时沿用原生开关状态。
      initializedPanes.add(paneKey)
      return
    }
    if (initializedPanes.has(paneKey) || (!factory && !nativeDocument)) return
    // 初次进入宽屏编辑时展开原生文件树。之后由原生控件保存本面板的开关选择。
    // 使用原生已声明的按钮接口，不改它的私有 store；窄屏遵循 DSH 的覆盖/收起规则。
    const frame = requestAnimationFrame(() => {
      const button = (nativeDocument ? panelToolbar : root.current)?.querySelector<HTMLButtonElement>('[data-files-navigator-toggle]')
      if (!button) return
      if (((nativeDocument ? nativeContent : root.current)?.clientWidth ?? 0) < 560 || !window.matchMedia('(min-width: 768px)').matches) return
      initializedPanes.add(paneKey)
      if (button.getAttribute('aria-expanded') !== 'true') button.click()
    })
    return () => cancelAnimationFrame(frame)
  }, [paneKey, factory, workspacePage, migrating, nativeDocument, nativeContent, panelToolbar, tab?.visible])

  if (!file && !workspacePage) return React.createElement('div', { role: 'alert' }, '文件地址不可用，请从工作区重新打开')
  if (migrating) return React.createElement('div', { role: 'status' }, '正在打开原生预览…')
  const editorAndPanel = React.createElement(React.Fragment, null,
      workspacePage ? React.createElement('div', { className: 'cstudio-editor-start' }, '从文件树选择文件') : React.createElement(EditorView, {
        ...props, sessionId, ownerId: tab?.id, visible: tab?.visible !== false,
        filePath: file?.path ?? '', fileLine: line, fileColumn: column,
        navigationRevision: tab?.navigation?.revision, onOpenPath, beforeNavigate, editorActions, showWorkspacePanel, openWorkspaceFiles: openFilesPanel,
        nativeDocument, wordWrap: nativeDocument ? props.wrap : undefined,
        documentSize: nativeDocument ? props.documentSize : undefined,
        documentRevision: content?.revision, onDocumentLoad: nativeDocument ? onDocumentLoad : undefined,
      }),
      React.createElement(WorkspacePanel, {
        paneKey, sessionId, cwd, scope: workspaceScopeOf(cwd, sessionId), path: file?.path ?? '', visible: tab?.visible !== false,
        factory, useTabInfo: props.useTabInfo, toolbarTarget: panelToolbar, nativeContent: nativeDocument ? nativeContent : undefined,
        workspaceContent, openFilesOnEntry: workspacePage,
        onOpen, onOpenPath, editorActions, actions: panelActions, beforeNavigate,
      }))
  if (nativeDocument) return React.createElement('div', { ref: root, className: 'cstudio-document-editor', 'data-code-preview': true }, editorAndPanel)
  const path = cwd ?? '工作区文件'
  return React.createElement('div', { ref: root, className: 'cstudio-native-file', 'data-edrv-view': '1' },
    React.createElement('header', { ref: setPanelToolbar, className: 'cstudio-native-header' },
      PathLabel
        ? React.createElement(PathLabel, { className: 'cstudio-native-path', path })
        : React.createElement('span', { className: 'cstudio-native-path', title: path }, path),
      React.createElement('span', { className: 'cstudio-native-panel-tools', 'data-cstudio-document-tools': true }),
      factory?.('sidebar.files.navigator.toggle', { useTabInfo: props.useTabInfo })),
    React.createElement('div', { ref: setWorkspaceContent, className: 'cstudio-native-content', 'data-textpreview-content': true }, editorAndPanel))
}

/** 旧版保存的“文件编辑”页签仅迁移一次；非当前页签不主动打开任何文件。 */
export function LegacyEditorRedirect(props: NativeProps): null {
  const tab = props.useTabInfo?.()?.tab
  const done = React.useRef(false)
  React.useEffect(() => {
    if (done.current || !tab) return
    done.current = true
    if (tab.visible !== false) {
      const request = resolveNavOpen(tab.navigation?.params)
      let path = request.path
      if (!path) {
        const cwd = props.sessions?.list?.getSnapshot?.()?.byId?.[props.sessionId ?? '']?.cwd
        try { path = JSON.parse(localStorage.getItem(CACHE_KEY.editor + workspaceScopeOf(cwd, props.sessionId)) ?? 'null')?.active ?? null } catch {}
      }
      if (path && props.sessionId) props.service?.openResource?.(buildPreviewFileAddress(path, props.sessionId), { params: { line: resolveNavLine(tab.navigation?.params) } })
      else props.service?.openTab?.('files')
    }
    tab.actions?.close?.()
  }, [tab, props.sessionId])
  return null
}
