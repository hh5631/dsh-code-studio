/**
 * dsh-code-studio client — 侧边栏面板契约（类型 + 上下文）。
 * 面板 = 活动栏一项 + 面板区一处渲染；新增面板只需注册一条 SidebarPanelDef。
 * 作者 ddj 2026-08-26
 */
import type { OutlineSourceRegistry } from '../outline/types.js'
import type { AddToConversation } from '../addToConversation.js'
import type { TreeMenuRegistry } from './contextMenu.js'

/** 面板可用的共享上下文（由 SidebarView 从 EditorView 注入，面板不直碰其内部）。 */
export interface SidebarCtx {
  sessionId?: string
  visible?: boolean
  /** 当前会话工作区 cwd（来自 sessions 快照；规则面板项目 Tab 自动匹配用）。 */
  cwd?: string | null
  /** 状态作用域键（工作区优先，无 cwd 回退会话；面板持久化统一走它，scopeStore 产出）。 */
  scope?: string
  openFile: (path: string) => void
  /** 打开文件并跳转到指定行/列（搜索面板命中跳转；缺省仅打开）。 */
  openFileAt?: (path: string, line?: number, column?: number) => void
  activePath: string | null
  /** 查看 Git 仓库文件的修改差异。 */
  openGitDiff?: (path: string, staged: boolean, repositoryRoot?: string) => void
  /** 移动/删除前先保存打开的相关文件，失败则取消文件操作。 */
  prepareFileOperation?: (path: string) => Promise<boolean>
  /** 取当前 Monaco 编辑器实例（可能为 null；大纲面板读 model/跳转用）。 */
  editor?: () => unknown | null
  /** 大纲源注册表（公开 provide 为 edrvOutlineSources；大纲面板解析符号用）。 */
  outlineSources?: OutlineSourceRegistry
  /** 文件右键菜单项注册表（公开 provide 为 edrvFileContextMenuItems；文件管理面板构建菜单用）。 */
  fileMenuItems?: TreeMenuRegistry
  officialMenus?: import('../contextMenusOfficial.js').OfficialMenuBridge
  forge?: import('../forgeBridge.js').ForgeBridge
  /** 「添加到对话」动作集（文件/文件夹引用注入对话输入框；缺省时菜单项降级提示）。 */
  addToConversation?: AddToConversation
  /** 确认对话框（破坏性动作守卫；缺省走 window.confirm，测试可注入）。 */
  confirm?: (message: string) => boolean
  /** 面板动作反馈（如右键菜单操作结果 → 编辑区路径栏状态）。 */
  notify?: (message: string) => void
  /** 名称输入弹窗（资源管理器右键的新建/重命名；取消/空输入返回 null，缺省时相关项降级提示）。 */
  prompt?: (title: string, initial: string) => Promise<string | null>
  /** 「打开方式…」：在已注册打开器间选择并打开（缺省时该项隐藏）。 */
  openWith?: (path: string) => void
  /** 「在文件夹中查找…」：限定目录并跳到搜索面板（缺省时该项隐藏）。 */
  searchInFolder?: (dir: string) => void
}

/** 单个侧边栏面板定义。 */
export interface SidebarPanelDef {
  id: string
  title: string
  /** 活动栏图标：官方图标组件（跟随官方主题）或文本/emoji（回落），横向居中显示。 */
  icon: string | ((props: { size?: number }) => unknown)
  order?: number
  /** 活动栏徽标：返回数字/null；缺省不显示。 */
  badge?: (ctx: SidebarCtx) => number | null
  /**
   * 面板可用性守卫：返回 false 时活动栏图标与面板区都不出现（每次渲染求值）。
   * 用于能力相关面板（如「SVN 变更」仅在受 SVN 管理时出现）；缺省恒可见。
   */
  visible?: (ctx: SidebarCtx) => boolean
  /** 面板区渲染（ctx 每次渲染注入最新快照）。 */
  render: (ctx: SidebarCtx) => unknown
}
