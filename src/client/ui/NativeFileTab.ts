/** 原生文件资源正文：一个文件页签、一份编辑内容，文件树复用 DSH Factory。 */
import React from 'react'
import { EditorView } from './EditorView.js'
import { WorkspacePanel, type EditorPanelActions, type WorkspacePanelActions, type WorkspaceView } from './WorkspacePanel.js'
import { buildFileAddress, parseOfficialFileAddress, resolveNavColumn, resolveNavLine, resolveNavOpen } from '../officialSidebar.js'
import { navigateFile } from '../nativeFileNavigation.js'
import { CACHE_KEY } from '../paths.js'
import { workspaceScopeOf } from '../state/scopeStore.js'

const initializedPanes = new Set<string>()

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
  [key: string]: any
}

export function NativeDocumentEditor(props: NativeProps & {
  resourceAddress: string
  content: RendererContent
  wrap: boolean
  useResource?: (address: string) => { value?: { version?: string } }
}): React.ReactElement {
  const version = props.useResource?.(props.resourceAddress)?.value?.version
  return React.createElement(NativeFileTab, { ...props, documentVersion: version })
}

export function NativeFileTab(props: NativeProps): React.ReactElement {
  const info = props.useTabInfo?.(), tab = info?.tab, panel = info?.panel
  const address = props.resourceAddress ?? tab?.navigation?.address ?? tab?.contentId
  const file = parseOfficialFileAddress(address)
  const documentContent: RendererContent | undefined = props.content?.kind === 'renderer' ? props.content : undefined
  const nativeDocument = !!documentContent
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
  const [toolbarTarget, setToolbarTarget] = React.useState<HTMLDivElement | null>(null)
  const root = React.useRef<HTMLDivElement>(null)
  const [nativeContent, setNativeContent] = React.useState<HTMLElement | null>(null)
  const beforeNavigate = React.useRef<(() => Promise<boolean>) | null>(null)
  const onOpen = React.useCallback((next: string) => {
    void navigateFile(tab, next, beforeNavigate.current)
  }, [tab?.actions, tab?.signal])
  const onOpenPath = React.useCallback((path: string, line?: number, column?: number) => {
    void navigateFile(tab, buildFileAddress(path, sessionId), beforeNavigate.current, { line, column })
  }, [tab?.actions, tab?.signal, sessionId])
  const factory = props.renderFactorySlot
  const paneKey = `${props.sessionId}:${panel?.id}`
  const migrating = !workspacePage && !nativeDocument && props.useDocumentRenderer?.(address) === true
  React.useEffect(() => {
    if (migrating && tab?.visible !== false) void navigateFile(tab, address, beforeNavigate.current, tab?.navigation?.params)
  }, [migrating, address, tab?.actions, tab?.signal, tab?.visible])

  React.useLayoutEffect(() => {
    if (!nativeDocument || !root.current) return
    const preview = root.current.closest('[data-textpreview-state]')
    const header = preview?.querySelector<HTMLElement>('[data-textpreview-path]')?.parentElement
    setPanelToolbar(header ?? null)
    setNativeContent(root.current.closest<HTMLElement>('[data-textpreview-content]'))
  }, [nativeDocument])

  const sourceVersion = React.useMemo(() => props.documentVersion, [address, documentContent?.revision])
  const onDocumentLoad = React.useCallback((ok: boolean) => {
    if (!documentContent) return
    if (ok) documentContent.loaded(sourceVersion ?? props.documentVersion ?? '')
    else documentContent.failed()
  }, [documentContent, sourceVersion, props.documentVersion])

  React.useEffect(() => {
    if (migrating || (!workspacePage && initializedPanes.has(paneKey)) || (!factory && !nativeDocument)) return
    // 初次进入宽屏编辑时展开原生文件树。之后由原生控件保存本面板的开关选择。
    // 使用原生已声明的按钮接口，不改它的私有 store；窄屏遵循 DSH 的覆盖/收起规则。
    const frame = requestAnimationFrame(() => {
      const button = (nativeDocument ? panelToolbar : root.current)?.querySelector<HTMLButtonElement>('[data-files-navigator-toggle]')
      if (!button) return
      if (workspacePage) { panelActions.current?.show('files'); return }
      if (((nativeDocument ? nativeContent : root.current)?.clientWidth ?? 0) < 560 || !window.matchMedia('(min-width: 768px)').matches) return
      initializedPanes.add(paneKey)
      if (button.getAttribute('aria-expanded') !== 'true') button.click()
    })
    return () => cancelAnimationFrame(frame)
  }, [paneKey, factory, workspacePage, nativeDocument, nativeContent, panelToolbar, migrating])

  if (!file && !workspacePage) return React.createElement('div', { role: 'alert' }, '文件地址不可用，请从工作区重新打开')
  const editorAndPanel = React.createElement(React.Fragment, null,
      React.createElement(EditorView, {
        ...props, sessionId, ownerId: tab?.id, visible: tab?.visible !== false,
        filePath: file?.path ?? '', fileLine: resolveNavLine(tab?.navigation?.params), fileColumn: resolveNavColumn(tab?.navigation?.params),
        navigationRevision: tab?.navigation?.revision, toolbarTarget, onOpenPath, beforeNavigate, editorActions, showWorkspacePanel, openWorkspaceFiles: openFilesPanel,
        nativeDocument, wordWrap: nativeDocument ? props.wrap : undefined,
        documentRevision: documentContent?.revision, onDocumentLoad: nativeDocument ? onDocumentLoad : undefined,
      }),
      React.createElement(WorkspacePanel, {
        paneKey, sessionId, cwd, scope: workspaceScopeOf(cwd, sessionId), path: file?.path ?? '', visible: tab?.visible !== false,
        factory, useTabInfo: props.useTabInfo, toolbarTarget: panelToolbar, nativeContent: nativeDocument ? nativeContent : undefined,
        onOpen, onOpenPath, editorActions, actions: panelActions, beforeNavigate,
      }))
  if (nativeDocument) return React.createElement('div', { ref: root, className: 'cstudio-document-editor', 'data-code-preview': true }, editorAndPanel)
  return React.createElement('div', { ref: root, className: 'cstudio-minimal cstudio-native-file', 'data-edrv-view': '1' },
    React.createElement('header', { className: 'cstudio-native-header' },
      React.createElement('span', { className: 'cstudio-native-path', title: file?.path ?? cwd ?? '' }, file?.path ?? cwd ?? '工作区文件'),
      React.createElement('div', { ref: setToolbarTarget, className: 'cstudio-native-actions' }),
      React.createElement('div', { ref: setPanelToolbar, className: 'cstudio-native-panel-tools' })),
    React.createElement('div', { className: 'cstudio-native-content', 'data-textpreview-content': true }, editorAndPanel))
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
      if (path) props.service?.openResource?.(buildFileAddress(path, props.sessionId), { params: { line: resolveNavLine(tab.navigation?.params) } })
      else props.service?.openTab?.('files')
    }
    tab.actions?.close?.()
  }, [tab, props.sessionId])
  return null
}
