/**
 * dsh-vscode-mode client — 编辑器指令目录（纯元数据）。
 * 「一条命令 = 一条注册数据」：命令栏、快捷键设置页与 Monaco 右键菜单
 * 全部从本表读取；新增一条能力只需在 EDITOR_COMMANDS 追加一项（默认键位见 shared/keybindings SHORTCUT_PROFILES）。
 * run 只派发 `edrv.command.*` 窗口事件，不直接触碰 React/Monaco（`edrv.command.` 前缀
 * 与既有 `edrv:` 刷新/主题事件分属不同命名空间，互不干扰）。
 * 作者 ddj 2026年09月10号
 */
import { panelAvailable, runPanelCommand } from '../panelCommands.js'
import { pageKeysAllowed } from '../pageReload.js'
import { hasEditorModel, hasOpenTabs } from '../editorModelState.js'
import { activeEditorPath } from '../activePathStore.js'
import { isMarkdownPath } from '../markdownPreview.js'

/** 一条编辑器指令（展示 + 执行 + 可用性）。 */
export interface CommandDef {
  /** 稳定命令 id（`edrv.` 前缀；第三方注册请避让该前缀）。 */
  id: string
  /** 命令栏与设置页展示名。 */
  label: string
  /** 命令栏分组名。 */
  category: string
  /** 组内排序（小者优先）。 */
  order?: number
  /** 运行体：派发窗口事件或直接执行。 */
  run: () => void
  /** 可用性判定（缺省视为始终可用；返回 false 时命令栏隐藏且 run 被拒）。 */
  available?: () => boolean
}

/**
 * 派发编辑器命令事件（`edrv.command.<action>`）。
 * 无 window 的运行环境（纯 Node 单测）静默跳过，命令本身不因此失败。
 * @author ddj 2026年09月10号
 * @param action 动作名（不含前缀）
 */
function emit(action: string): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent('edrv.command.' + action))
}

/** 编辑器命令事件名前缀（EditorView / QuickOpen / 第三方据此监听）。 */
export const COMMAND_EVENT_PREFIX = 'edrv.command.'

/** 需要活动编辑器模型才可用的命令（命令栏隐藏并拒绝执行）。 */
function needsModel(): boolean {
  return hasEditorModel()
}

/** 面板区显隐切换始终可用（未挂载编辑器时 run 为空操作）。 */
function alwaysAvailable(): boolean {
  return true
}

/**
 * 光标整行下移（编辑行导航）。
 * @author ddj 2026年09月10号
 * @returns 命令定义
 */
function nextEditorRowDef(): CommandDef {
  return {
    id: 'edrv.nextEditorRow', label: '下一编辑行（光标整行下移）', category: '导航', order: 50,
    available: needsModel,
    run: () => emit('nextEditorRow'),
  }
}

/**
 * 光标整行上移（编辑行导航）。
 * @author ddj 2026年09月10号
 * @returns 命令定义
 */
function prevEditorRowDef(): CommandDef {
  return {
    id: 'edrv.prevEditorRow', label: '上一编辑行（光标整行上移）', category: '导航', order: 60,
    available: needsModel,
    run: () => emit('prevEditorRow'),
  }
}

/**
 * 转到行（转发 Monaco 原生 gotoLine widget；补命令栏与快捷键设置页入口）。
 * @author ddj 2026年09月22号
 * @returns 命令定义
 */
function gotoLineDef(): CommandDef {
  return {
    id: 'edrv.goToLine', label: '转到行', category: '导航', order: 45,
    available: needsModel,
    run: () => emit('goToLine'),
  }
}

/**
 * 添加选中内容为引用（把当前选区追加进对话输入框；无选区则状态栏提示）。
 * 有活动编辑器模型才可用，保证对话框内按 Ctrl+U 不被本命令吞掉。
 * @author ddj 2026年09月10号
 * @returns 命令定义
 */
function addSelectionRefDef(): CommandDef {
  return {
    id: 'edrv.addSelectionRef', label: '添加选中内容为引用', category: '编辑', order: 10,
    available: needsModel,
    run: () => emit('addSelectionRef'),
  }
}

/**
 * 关闭当前页签（参考图 Ctrl+F4）。
 * 可用性按「是否已打开页签」判定而非编辑器模型：图片/PDF 页签无 Monaco 实例但可关闭；
 * 无页签时判定不可用 → 指令桥放行按键，不吞掉浏览器/系统对 Ctrl+F4 的默认行为。
 * @author ddj 2026年09月11号
 * @returns 命令定义
 */
function closeTabDef(): CommandDef {
  return {
    id: 'edrv.closeTab', label: '关闭当前页签', category: '文件', order: 40,
    available: hasOpenTabs,
    run: () => emit('closeTab'),
  }
}



/**
 * 编辑器内置指令目录（顺序 = 快捷键设置页展示顺序）。
 * 键位派发已归官方 shortcuts 机制：默认键位表在 shared/keybindings.ts 的 SHORTCUT_PROFILES，
 * 由 client/index.ts 经 shortcutsOfficial.registerOfficialShortcuts 注册，本目录只管
 * 「标签/可用性/执行」。无默认键位的命令同样注册（官方 UI/插件子页内可自定义绑定）。
 * @author ddj 2026年09月10号 / 2026年10月
 */
export const EDITOR_COMMANDS: readonly CommandDef[] = [
  {
    id: 'edrv.toggleComment', label: '切换行注释', category: '编辑', order: 20,
    available: needsModel,
    run: () => emit('toggleComment'),
  },
  {
    id: 'edrv.duplicateLine', label: '向下复制行（Ctrl+D，编辑器本地，不使用剪贴板）', category: '编辑', order: 30,
    available: needsModel,
    run: () => emit('duplicateLine'),
  },
  {
    id: 'edrv.reloadWindow', label: '刷新当前界面（不重启 Host）', category: '视图', order: 40,
    available: pageKeysAllowed,
    run: () => emit('reloadWindow'),
  },
  {
    id: 'edrv.save', label: '保存文件', category: '文件', order: 10,
    available: needsModel,
    run: () => emit('save'),
  },
  {
    id: 'edrv.quickOpen', label: '快速打开文件', category: '文件', order: 20,
    available: () => panelAvailable('quickOpen'),
    run: () => { runPanelCommand('quickOpen') },
  },
  {
    id: 'edrv.toggleSidebar', label: '切换侧边栏', category: '视图', order: 10,
    available: alwaysAvailable,
    run: () => emit('toggleSidebar'),
  },
  {
    id: 'edrv.searchInFiles', label: '在工作区中搜索', category: '视图', order: 20,
    available: () => panelAvailable('searchInFiles'),
    run: () => { runPanelCommand('searchInFiles') },
  },
  {
    id: 'edrv.toggleMarkdownPreview', label: '切换 Markdown 预览', category: '视图', order: 25,
    // 仅活动文件是 .md 时可用（不可用时官方派发返回 pass 不吞键，保留浏览器「无格式粘贴」语义）
    available: () => {
      const path = activeEditorPath()
      return typeof path === 'string' && isMarkdownPath(path)
    },
    run: () => emit('toggleMarkdownPreview'),
  },
  {
    id: 'edrv.showLogs', label: '查看诊断日志', category: '视图', order: 30,
    available: alwaysAvailable,
    run: () => emit('showLogs'),
  },
  {
    id: 'edrv.navigateBack', label: '后退（导航历史）', category: '导航', order: 10,
    available: needsModel,
    run: () => emit('navigateBack'),
  },
  {
    id: 'edrv.navigateForward', label: '前进（导航历史）', category: '导航', order: 20,
    available: needsModel,
    run: () => emit('navigateForward'),
  },
  {
    id: 'edrv.nextTab', label: '下一个页签', category: '导航', order: 30,
    available: needsModel,
    run: () => emit('nextTab'),
  },
  {
    id: 'edrv.prevTab', label: '上一个页签', category: '导航', order: 40,
    available: needsModel,
    run: () => emit('prevTab'),
  },
  {
    id: 'edrv.goToDefinition', label: '转到定义', category: '语言智能', order: 10,
    available: needsModel,
    run: () => emit('goToDefinition'),
  },
  {
    id: 'edrv.findReferences', label: '查找所有引用', category: '语言智能', order: 20,
    available: needsModel,
    run: () => emit('findReferences'),
  },
  {
    id: 'edrv.triggerAi', label: '触发 AI 内联补全', category: '语言智能', order: 30,
    available: needsModel,
    run: () => emit('triggerAi'),
  },
  {
    id: 'edrv.openInExplorer', label: '在文件浏览器中打开', category: '文件', order: 30,
    available: needsModel,
    run: () => emit('openInExplorer'),
  },
  {
    id: 'edrv.configureSnippets', label: '代码片段：配置代码片段', category: '代码片段', order: 10,
    available: alwaysAvailable,
    run: () => emit('configureSnippets'),
  },
  {
    id: 'edrv.insertSnippet', label: '插入代码片段', category: '代码片段', order: 20,
    available: needsModel,
    run: () => emit('insertSnippet'),
  },
]

/**
 * 非编辑器原生路径的指令（键位统一由官方 shortcuts 机制派发；历史「桥接」分组名保留）。
 * 新增「只填目录」的编辑器指令一律放这里：命令栏与官方快捷键目录自动可用。
 * @author ddj 2026年09月10号 / 2026年10月
 */
export const BRIDGE_COMMANDS: readonly CommandDef[] = [
  nextEditorRowDef(),
  prevEditorRowDef(),
  gotoLineDef(),
  addSelectionRefDef(),
  closeTabDef(),
]

/**
 * 命令栏自身的命令（避免循环依赖，由 commandBridge 注入 run 后注册）。
 * @author ddj 2026年09月10号
 * @param run 打开命令栏
 * @returns 命令定义
 */
export function showCommandsDef(run: () => void): CommandDef {
  return {
    id: 'edrv.showCommands', label: '显示所有命令', category: '视图', order: 1,
    available: alwaysAvailable, run,
  }
}
