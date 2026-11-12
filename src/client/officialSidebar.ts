/**
 * dsh-code-studio client — 官方右侧 Sidebar 桥：探测 DSH 0.1.5-alpha.1+ 的
 * ctx.sidebarRightTabs / ctx.sidebarRight 服务，两段式注册「文件编辑」Tab
 * （类型定义进注册表，正文进 keyed slot sidebar.right.pane.tab）。
 * 可选依赖模式：服务缺失时调用方回退 better-sidebar / 中央页签；本模块不注册任何东西。
 * 维护约定：官方侧边栏（DSH 0.1.5+）是侧边栏编辑形态的唯一维护面；
 * dsh-better-sidebar 桥（sidebarBridge.ts）已归档，仅作旧版 DSH 回退，不再新增能力。
 * 纯逻辑（探测/导航参数解析）可单测，注册装配仅存在于 install 路径。
 * 作者 ddj 2026年09月09号
 */

import { log } from './log.js'
import { setEnsureSideEditor } from './sidebarBridge.js'
import { CACHE_KEY } from './paths.js'
import { OFFICE_EXT, BLIND_EXT, suffixOf } from '../shared/nativeOpen.js'
import { inNativePath } from './nativeOpenStore.js'

// 让位清单与 CSV/TSV 决策（可编辑性优先，同 avif 例外）已抽至双面契约 shared/nativeOpen.ts
//（host 的 Config schema 默认原生打开范围与本模块共用同一事实源）；此处 re-export 保持旧 import 路径。
export { OFFICE_EXT, BLIND_EXT }

/** 官方 Tab 类型注册表服务名（ctx.get 用；不进 inject——旧版 DSH 无此包，inject 会停等）。 */
export const OFFICIAL_TABS_SERVICE = 'sidebarRightTabs'
/** 官方导航控制器服务名（ctx.get 用）。 */
export const OFFICIAL_SERVICE = 'sidebarRight'
/** 官方 keyed slot 名（Tab 正文挂点，由官方侧边栏的 rightbar seat 声明）。 */
export const OFFICIAL_SLOT_NAME = 'sidebar.right.pane.tab'
/** 本插件 Tab 类型定义 id（官方约定用包名；正文 slot 的 key 与之相同）。 */
export const OFFICIAL_TAB_ID = 'dsh-code-studio'
/** 本插件 Tab 的类型判别符（ctx.sidebarRight.openTab 的 kind）。 */
export const OFFICIAL_TAB_KIND = 'edrvEditor'
/** Tab 标题（与 better-sidebar 形态一致）。 */
export const OFFICIAL_TAB_TITLE = '文件编辑'
/** 官方 file 资源地址前缀（0.1.5+ 聊天文件链接/文件树打开的统一地址语法）。 */
export const OFFICIAL_FILE_PREFIX = 'dsh-resource://file/'
/** file 资源类型的定义 id（正文 slot 的 key）。 */
export const OFFICIAL_FILE_TAB_ID = 'dsh-code-studio/file'
/** file 资源类型的 kind（与页类型 edrvEditor 区分：同 kind 只允许一份 extension）。 */
export const OFFICIAL_FILE_KIND = 'edrvEditorFile'
/** 接管原生 files 页类型，入口、快捷键与已有文件页签继续使用同一个 kind。 */
export const WORKSPACE_FILES_TAB_ID = 'dsh-code-studio/workspace'

/** 让位判定用后缀集合（模块级构建一次；小写、无前导点）。 */
const DEFER_EXT_SET: Set<string> = new Set([...OFFICE_EXT, ...BLIND_EXT])
const NATIVE_PREVIEW_EXT = new Set(['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'avif', 'tif', 'tiff'])

/**
 * 图片、PDF、Office 与已知二进制容器只用原生查看器，不提供代码编辑。
 * 用户追加的 nativeOpenExts 由 canEditFile 另行检查。
 * @author ddj 2026年09月18号
 * @param path 文件路径（工作区相对或绝对）
 * @returns 是否让位官方
 */
export function deferToOfficial(path: unknown): boolean {
  return DEFER_EXT_SET.has(suffixOf(path)) || NATIVE_PREVIEW_EXT.has(suffixOf(path))
}

/** 官方 Tab 打开参数（官方运行时不校验的 JSON，正文经 navigation.params 读回）。 */
export interface OfficialTabParams {
  openPath?: string
  focusDiff?: boolean
  /** Open Markdown in rendered mode; explicit line navigation still selects source. */
  preview?: boolean
  /** 目标行号（行引用/工具行跳转透传；缺省仅打开文件）。 */
  line?: number
  column?: number
}

/** sidebarRightTabs 服务的最小结构面（结构性探测，不 import 官方类型）。 */
export interface SidebarRightTabsLike {
  register: (definition: unknown) => () => void
}

/** sidebarRight 服务的最小结构面（openTab 页路由 + openResource 资源路由 + 可选查询/定向打开）。 */
export interface SidebarRightServiceLike {
  openTab: (kind: string, options?: { params?: unknown }) => void
  openResource?: (address: string, options?: { params?: unknown; kind?: string; paneId?: string; replaceTab?: string }) => void
  /** 挂载会话的激活 Tab（判读编辑 Tab 是否已激活；无 seat 时 undefined）。 */
  active?: () => { kind?: string } | undefined
  /** 向指定会话的停靠面打开页类型（store 未 adopt 时 no-op）。 */
  openTabIn?: (sessionId: string, kind: string, options?: { params?: unknown }) => void
}

/** slots 服务的最小结构面（等待声明 + 注册）。 */
export interface SlotsLike {
  inject: (name: string, register: () => unknown) => unknown
  register: (spec: object, render: unknown) => unknown
}

/** 探测命中的一对官方服务。 */
export interface OfficialSidebar {
  tabs: SidebarRightTabsLike
  service: SidebarRightServiceLike
}

/**
 * 结构化探测官方右侧 Sidebar 服务（可选依赖：缺失/降级返回 undefined）。
 * 服务仅存在于 DSH 0.1.5-alpha.1+，探测命中 ≡ 版本判定成立。
 * @author ddj 2026年09月09号
 * @param ctx 客户端服务上下文
 * @returns 注册表与控制器对，或 undefined
 */
export function detectOfficial(ctx: { get: (name: string) => unknown }): OfficialSidebar | undefined {
  try {
    const tabs = ctx.get(OFFICIAL_TABS_SERVICE) as SidebarRightTabsLike | undefined
    const service = ctx.get(OFFICIAL_SERVICE) as SidebarRightServiceLike | undefined
    if (!tabs || typeof tabs.register !== 'function') return undefined
    if (!service || typeof service.openTab !== 'function') return undefined
    return { tabs, service }
  } catch {
    return undefined
  }
}

/**
 * 从官方导航参数安全解析打开请求（缺字段/坏类型一律降级为空请求，不抛错）。
 * @author ddj 2026年09月09号
 * @param params openTab 传入的 params（正文经 navigation.params 读回）
 * @returns 待打开路径与是否聚焦首个差异
 */
export function resolveNavOpen(params: unknown): { path: string | null; focusDiff: boolean } {
  const value = (params ?? {}) as OfficialTabParams
  const path = typeof value?.openPath === 'string' && value.openPath ? value.openPath : null
  return { path, focusDiff: value?.focusDiff === true }
}

/**
 * 从官方导航参数安全解析行号（缺字段/坏类型/非正数一律视为未指定）。
 * @author ddj 2026年09月10号
 * @param params openTab/openResource 传入的 params（正文经 navigation.params 读回）
 * @returns 正整数行号，或 undefined
 */
export function resolveNavLine(params: unknown): number | undefined {
  const value = (params ?? {}) as OfficialTabParams
  const line = value?.line
  if (typeof line !== 'number' || !Number.isFinite(line) || line < 1) return undefined
  return Math.floor(line)
}

/** @public @author ddj 2026年11月04号 @param params Plugin navigation extension. @returns Positive column only alongside a valid line; official line-only callers remain unchanged. */
export function resolveNavColumn(params: unknown): number | undefined {
  if (!resolveNavLine(params)) return undefined
  const column = (params as OfficialTabParams)?.column
  return typeof column === 'number' && Number.isFinite(column) && column >= 1 ? Math.floor(column) : undefined
}

/** 逐段 component 解码（失败返回 null，对齐官方 parseFileAddress 的容错语义）。 */
function decodeSegment(raw: string | undefined): string | null {
  if (raw === undefined) return null
  try {
    return decodeURIComponent(raw)
  } catch {
    return null
  }
}

/**
 * 解析官方 file 资源地址（镜像 dsh-util-workspace-path 的 parseFileAddress 语法，不 import 官方包）。
 * session 域：`dsh-resource://file/session/<sessionId>/<逐段编码的相对路径>`；
 * absolute 域：`dsh-resource://file/absolute/<去前导 / 的绝对路径>`（POSIX 补回前导 /，
 * Windows 盘符 `C:/` 原样，UNC 保留空首段 `//server/share`）。
 * @author ddj 2026年09月09号
 * @param address 候选地址
 * @returns 文件路径（session 域附带 sessionId）；非 file 地址/畸形/解码失败返回 null
 */
export function parseOfficialFileAddress(address: unknown): { path: string; sessionId?: string } | null {
  if (typeof address !== 'string' || !address.startsWith(OFFICIAL_FILE_PREFIX)) return null
  const [scope, ...tail] = address.split(/[?#]/, 1)[0].slice(OFFICIAL_FILE_PREFIX.length).split('/')
  const kind = decodeSegment(scope)
  if (kind === 'session') {
    const sessionId = decodeSegment(tail[0])
    const segments = tail.slice(1).map(decodeSegment)
    if (!sessionId || segments.length === 0 || segments.some((s) => s === null)) return null
    const path = (segments as string[]).join('/')
    return path ? { path, sessionId } : null
  }
  if (kind === 'absolute') {
    const unc = tail[0] === '' && tail.length > 1
    const segments = (unc ? tail.slice(1) : tail).map(decodeSegment)
    if (segments.length === 0 || (segments as string[])[0] === '' || segments.some((s) => s === null)) return null
    const list = segments as string[]
    if (unc) return { path: '//' + list.join('/') }
    if (/^[A-Za-z]:$/.test(list[0])) return { path: list.join('/') }
    return { path: '/' + list.join('/') }
  }
  return null
}

/**
 * file 地址的 Tab chip 标题：解码后的 basename（解码失败回退原始串切片）。
 * @author ddj 2026年09月09号
 * @param address file 资源地址
 * @returns 标题文本
 */
export function officialFileTitle(address: unknown): string {
  const parsed = parseOfficialFileAddress(address)
  const source = parsed?.path ?? (typeof address === 'string' ? address : '')
  const normalized = source.replace(/\\/g, '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1) || source
}

/** component 编码一段（对齐官方 encodeSegment：盘符冒号保持字面）。 */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/%3A/gi, ':')
}

/**
 * 构造官方 file 资源地址（镜像 fileAddressFor 的分派：绝对路径→absolute 域，相对→session 域）。
 * @author ddj 2026年09月09号
 * @param path 绝对或工作区相对路径（两种分隔符均可）
 * @param sessionId 会话 id（相对路径必需；绝对路径可省）
 * @returns `dsh-resource://file/…` 地址
 * @throws 路径为空，或相对路径缺 sessionId
 */
export function buildFileAddress(path: string, sessionId?: string): string {
  const posix = (typeof path === 'string' ? path : '').replace(/\\/g, '/')
  if (!posix.trim()) throw new Error('buildFileAddress：路径为空')
  const isAbsolute = posix.startsWith('/') || posix.startsWith('//') || /^[A-Za-z]:[/\\]/.test(posix)
  if (isAbsolute) {
    const unc = posix.startsWith('//')
    const body = posix.replace(/^\/+/, '')
    return OFFICIAL_FILE_PREFIX + 'absolute/' + (unc ? '/' : '') + body.split('/').map(encodeSegment).join('/')
  }
  if (!sessionId) throw new Error('buildFileAddress：相对路径需要会话 id')
  const relative = posix.replace(/^(?:\.\/)+/, '').replace(/^\/+/, '')
  return OFFICIAL_FILE_PREFIX + 'session/' + encodeSegment(sessionId) + '/' + relative.split('/').map(encodeSegment).join('/')
}

/** DSH 原生文件查看只接收 session 地址，但其路径可以是工作区相对路径或绝对路径。 */
export function buildPreviewFileAddress(path: string, sessionId?: string, cwd?: string | null): string {
  if (!sessionId) throw new Error('打开原生文件预览需要活动会话')
  const normalized = path.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
  if (!normalized.trim()) throw new Error('文件路径为空')
  const root = cwd?.replace(/\\/g, '/').replace(/\/+$/, '')
  const relative = root && normalized.startsWith(root + '/') ? normalized.slice(root.length + 1) : normalized
  return OFFICIAL_FILE_PREFIX + 'session/' + encodeSegment(sessionId) + '/' + relative.split('/').map(encodeSegment).join('/')
}

export function canEditFile(path: string): boolean {
  return !!path && !deferToOfficial(path) && !inNativePath(path)
}

// --region file 认领转发（文件分页收归编辑器自带页签栏）

/**
 * 把 file 打开请求转发进单一编辑器页签（文件分页由编辑器自带页签栏接管，
 * 官方侧栏不再按文件分裂出多套编辑器实例）。
 * @author ddj 2026年09月10号
 * @param service 官方 sidebarRight 服务（缺失/缺 openTab 返回 false）
 * @param path 目标文件路径（空值返回 false）
 * @param line 可选行号（透传给编辑器页签导航参数）
 * @param preview 可选 Markdown 渲染模式（行号导航优先源码）
 * @returns 转发是否成功（openTab 抛错返回 false，由调用方决定重试或兜底）
 */
export function forwardToEditor(
  service: SidebarRightServiceLike | undefined | null,
  path: string | null,
  line?: number,
  preview?: boolean,
  column?: number,
): boolean {
  if (!service || typeof service.openTab !== 'function' || !path) return false
  const params: OfficialTabParams = { openPath: path }
  const validLine = resolveNavLine({ line })
  if (validLine !== undefined) params.line = validLine
  const validColumn = resolveNavColumn({ line: validLine, column })
  if (validColumn !== undefined) params.column = validColumn
  if (preview !== undefined) params.preview = preview
  try {
    // 官方语义：页类型恒去重，故转发只会聚焦既有编辑器页签，不产生新实例
    service.openTab(OFFICIAL_TAB_KIND, { params })
    return true
  } catch (error) {
    log.warn('file 认领转发进编辑器页签失败（' + String(error) + '）')
    return false
  }
}
// --endregion

/**
 * 注册官方 Tab 正文（keyed slot，key=定义 id；slots.inject 等待 rightbar seat 声明）。
 * @author ddj 2026年09月09号
 * @param slots slots 服务
 * @param key 正文注册键（= 类型定义 id）
 * @param renderTab 正文组件（包装后的 OfficialSideTab）
 * @returns 注销函数；注册抛错返回 null
 */
function registerBodySlot(slots: SlotsLike, key: string, renderTab: unknown): (() => void) | null {
  try {
    const disposer = slots.inject(OFFICIAL_SLOT_NAME, () => slots.register(
      { name: OFFICIAL_SLOT_NAME, key },
      renderTab,
    ))
    return typeof disposer === 'function' ? (disposer as () => void) : null
  } catch (error) {
    log.warn('官方侧边栏正文 slot 注册失败（' + String(error) + '）')
    return null
  }
}

/** 原生工作区入口直接显示编辑器与相邻文件树；卸载后恢复原生浏览页。 */
export function registerWorkspaceFilesClaim(options: {
  tabs: SidebarRightTabsLike; slots: SlotsLike; renderTab: unknown; icon?: unknown
}): (() => void) | null {
  let dispose: (() => void) | undefined
  try {
    dispose = options.tabs.register({
      id: WORKSPACE_FILES_TAB_ID, kind: 'files', priority: 'extension', title: () => '文件',
      guide: [{ id: 'workspace', commandId: 'workspace.files', order: 10, title: () => '工作区文件',
        description: () => '浏览和编辑当前工作区的文件', icon: options.icon }],
    })
    const body = registerBodySlot(options.slots, WORKSPACE_FILES_TAB_ID, options.renderTab)
    if (!body) { dispose(); return null }
    return () => { body(); dispose?.() }
  } catch (error) {
    dispose?.()
    log.warn('工作区文件入口注册失败（' + String(error) + '）')
    return null
  }
}

/**
 * 注册官方右侧 Sidebar「文件编辑」Tab 并接管打开路由（两段式 + 路由）。
 * 调用方须把返回值挂进 ctx.effect；类型注册抛错时返回 null，由调用方回退旧形态。
 * @author ddj 2026年09月09号
 * @param options 装配参数（探测命中的一对服务 + slots + 正文组件 + guide 文案）
 * @returns 卸载器（反注册类型与正文 + 撤销路由）；类型注册失败返回 null
 */
export function installOfficial(options: {
  tabs: SidebarRightTabsLike
  service: SidebarRightServiceLike
  slots: SlotsLike
  renderTab: unknown
  guide: { title: () => string; description: () => string }
  /** Tab 标题 thunk（缺省用内置中文常量；传入后由调用方按当前语言解析）。 */
  title?: () => string
  sessionId?: () => string | undefined
  cwd?: () => string | null | undefined
}): (() => void) | null {
  const { tabs, service, slots, renderTab } = options
  const open = (path: string | null, focusDiff: boolean): boolean => {
    try {
      // 文件走原生资源地址；空请求打开原生文件区。旧 editor kind 只保留迁移入口。
      if (path && typeof service.openResource === 'function') service.openResource(buildPreviewFileAddress(path, options.sessionId?.(), options.cwd?.()))
      else service.openTab('files')
    } catch (error) {
      log.warn('原生文件区打开失败（' + String(error) + '）')
      return false
    }
    return true
  }
  let typeDisposer: (() => void) | null = null
  try {
    // extension 档（默认且最高）：与官方内置类型同 kind 时接管，卸载后官方恢复
    typeDisposer = tabs.register({
      id: OFFICIAL_TAB_ID,
      kind: OFFICIAL_TAB_KIND,
      priority: 'extension',
      // 仅用于迁移旧版已保存页签，不再提供独立的“文件编辑”入口。
      title: () => '文件',
      guide: [],
    })
  } catch (error) {
    log.warn('官方侧边栏 Tab 类型注册失败（' + String(error) + '），回退旧形态')
    return null
  }
  setEnsureSideEditor(open)
  const bodyDisposer = registerBodySlot(slots, OFFICIAL_TAB_ID, renderTab)
  return () => {
    if (typeof typeDisposer === 'function') typeDisposer()
    if (typeof bodyDisposer === 'function') bodyDisposer()
    setEnsureSideEditor(null)
  }
}

/**
 * 保留已存旧页签的迁移入口。不声明匹配规则，新文件链接交给原生查看器。
 * @author ddj 2026年09月09号 / 2026年09月18号
 * @param options 装配参数（探测命中的注册表 + slots + 正文组件）
 * @returns 卸载器（反注册类型与正文）；类型注册抛错返回 null（回落官方查看器）
 */
export function registerOfficialFileClaim(options: {
  tabs: SidebarRightTabsLike
  slots: SlotsLike
  renderTab: unknown
}): (() => void) | null {
  const { tabs, slots, renderTab } = options
  let typeDisposer: (() => void) | null = null
  try {
    typeDisposer = tabs.register({
      id: OFFICIAL_FILE_TAB_ID,
      kind: OFFICIAL_FILE_KIND,
      priority: 'extension',
      canOpen: (address: string) => {
        const parsed = parseOfficialFileAddress(address)
        return parsed !== null && canEditFile(parsed.path)
      },
      title: (address: string) => officialFileTitle(address),
    })
  } catch (error) {
    log.warn('官方 file 地址认领注册失败（' + String(error) + '），链接走官方查看器')
    return null
  }
  const bodyDisposer = registerBodySlot(slots, OFFICIAL_FILE_TAB_ID, renderTab)
  if (!bodyDisposer) { typeDisposer?.(); return null }
  return () => {
    if (typeof typeDisposer === 'function') typeDisposer()
    bodyDisposer()
  }
}

// --region 编辑 Tab 跨会话自动恢复

/** 编辑 Tab 是否处于激活态（正文挂载 = 激活；模块级，跨会话存活）。 */
let editorTabActive = false
/** 正文挂载纪元（每次挂载自增；延迟判定期间有新挂载则放弃清除）。 */
let mountEpoch = 0
/** 作用域解析器（index.ts 装配时注入；未注入则不落盘，退回纯内存标记）。 */
let tabScopeOf: (() => string) | null = null

/**
 * 注入编辑 Tab 状态的作用域解析器（index.ts 装配一次；键跟随会话/工作区切换）。
 * @author ddj 2026年09月28号
 * @param resolve 返回工作区作用域键（scopeStore.workspaceScopeOf 产物）
 */
export function setEditorTabScope(resolve: () => string): void {
  tabScopeOf = resolve
}

/**
 * 编辑 Tab 状态的作用域键（未注入/解析失败 → 空串，调用方跳过持久化）。
 * @author ddj 2026年09月28号
 * @returns localStorage 键
 */
function editorTabKey(): string {
  if (!tabScopeOf) return ''
  try {
    const scope = tabScopeOf()
    return scope ? CACHE_KEY.editorTab + scope : ''
  } catch (error) {
    return ''
  }
}

/**
 * 读回「上次退出时编辑 Tab 是否处于激活态」（供冷启动自动展开编辑 Tab）。
 * @author ddj 2026年09月28号
 * @returns 是否曾被激活（存储不可用/未注入 → false）
 */
export function readSavedTab(): boolean {
  const key = editorTabKey()
  if (!key) return false
  try {
    return localStorage.getItem(key) === '1'
  } catch (error) {
    return false
  }
}

/**
 * 持久化编辑 Tab 激活态（存储不可用静默；镜像层会把它写穿到 host 跨重启保留）。
 * @author ddj 2026年09月28号
 * @param active 是否激活
 */
export function saveTabActive(active: boolean): void {
  const key = editorTabKey()
  if (!key) return
  try {
    if (active) localStorage.setItem(key, '1')
    else localStorage.removeItem(key)
  } catch (error) { /* 存储不可用：仅内存标记生效 */ }
}

/**
 * 标记编辑 Tab 激活并推进挂载纪元（正文挂载时调用）。
 * @author ddj 2026年09月09号
 */
export function markEditorMounted(): void {
  mountEpoch += 1
  markEditorActive(true)
}

/**
 * 直接设置激活标记（正文卸载延迟判定用；测试 also 用作状态编排入口）。
 * 同时写穿到 localStorage（镜像层负责跨重启保留），供下次冷启动恢复。
 * @author ddj 2026年09月09号 / 2026年09月28号
 * @param active 是否激活
 */
export function markEditorActive(active: boolean): void {
  editorTabActive = active
  saveTabActive(active)
}

/**
 * 读编辑 Tab 激活标记（会话切换时决定是否自动恢复编辑栏）。
 * @author ddj 2026年09月09号
 * @returns 上次标记的激活状态
 */
export function isEditorTabActive(): boolean {
  return editorTabActive
}

/**
 * 读当前挂载纪元（卸载延迟判定用：纪元已推进 = 有新正文接管，不清标记）。
 * @author ddj 2026年09月09号
 * @returns 当前纪元
 */
export function editorMountEpoch(): number {
  return mountEpoch
}

/**
 * 在挂载会话恢复编辑 Tab：已激活跳过（官方幂等）；seat 未就绪抛错时有界重试。
 * openTab 官方语义「打开即展开侧栏」，一次调用同时完成展开 + 激活。
 * @author ddj 2026年09月09号
 * @param service 官方 sidebarRight 服务（缺失/未装配直接返回）
 * @param schedule 延时调度（ctx.timeout；重试节拍）
 * @param attempts 剩余尝试次数（默认 10 次 × 150ms ≈ 1.5s 窗口）
 */
export function restoreEditorTab(
  service: SidebarRightServiceLike | undefined | null,
  schedule: (fn: () => void, ms: number) => void,
  attempts = 10,
): void {
  if (!service || typeof service.openTab !== 'function' || !editorTabActive) return
  try {
    if (service.active?.()?.kind === OFFICIAL_TAB_KIND) return
    service.openTab(OFFICIAL_TAB_KIND, {})
  } catch {
    // seat 未挂载/未绑定（会话面尚未渲染）：等一拍再试，放弃后保持现状不阻塞
    if (attempts > 1) schedule(() => restoreEditorTab(service, schedule, attempts - 1), 150)
  }
}
// --endregion
