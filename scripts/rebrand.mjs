#!/usr/bin/env node
/**
 * rebrand.mjs — dsh-vscode-mode → dsh-code-studio 身份换血。
 *
 * 换血原则（保守优先）：
 * 1. 「身份标识」必须换：loader entry name、插件目录名、设置命名空间、
 *    locale ns、侧栏 Tab id、命令行工具名、日志前缀、RPC 路由与方法前缀。
 * 2. 「用户数据」必须保留：旧插件留下的 sidecar / 缓存 / 迁移标记，
 *    换名后仍需能识别与清理，否则主人的历史数据就"失联"了。
 * 3. 「CSS 类名」不换：4723 处 edrv-* 前缀牵动整个 DOM 契约，
 *    换名的收益远小于回归风险（且可读性无损）。
 *
 * 用法：node scripts/rebrand.mjs [--check]
 */
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { resolve, join, relative } from 'node:path'

const OLD = 'dsh-vscode-mode'
const NEW = 'dsh-code-studio'
/** 路由与方法前缀：edrv → cstudio（纯标识符，无用户数据语义）。 */
const OLD_PREFIX = 'edrv'
const NEW_PREFIX = 'cstudio'
const ROOT = resolve(import.meta.dirname, '..')
const CHECK_ONLY = process.argv.includes('--check')

/**
 * 精确替换（带上下文锚点，逐条校验命中，避免误伤）。
 * @type {{file: string, from: string, to: string, note: string}[]}
 */
const EDITS = [
  // ── 宿主半：loader entry id ────────────────────────────────
  { file: 'src/index.ts', from: "export const name = 'dsh-vscode-mode'", to: `export const name = '${NEW}'`, note: 'loader entry id' },

  // ── 宿主半：数据目录 ───────────────────────────────────────
  { file: 'src/paths.ts', from: "export const PLUGIN_ID = 'dsh-vscode-mode'", to: `export const PLUGIN_ID = '${NEW}'`, note: '插件数据目录名' },

  // ── 宿主半：设置命名空间 ───────────────────────────────────
  { file: 'src/fileOpenSettings.ts', from: "export const FILE_OPEN_SETTINGS_NS = 'dsh-vscode-mode'", to: `export const FILE_OPEN_SETTINGS_NS = '${NEW}'`, note: '设置命名空间' },

  // ── 宿主半：规则 section ───────────────────────────────────
  { file: 'src/rules.ts', from: "const SECTION_NAME = 'dsh-vscode-mode:rules'", to: `const SECTION_NAME = '${NEW}:rules'`, note: '规则 section 名' },

  // ── 宿主半：兼容报告里的插件名 ─────────────────────────────
  { file: 'src/compat.ts', from: "export const PLUGIN_NAME = 'dsh-vscode-mode'", to: `export const PLUGIN_NAME = '${NEW}'`, note: '兼容报告插件名' },

  // ── 宿主半：open-inbox 目录 ────────────────────────────────
  { file: 'src/openInbox.ts', from: "join(profile, 'dsh-vscode-mode', 'open-inbox')", to: `join(profile, '${NEW}', 'open-inbox')`, note: 'open-inbox 目录' },

  // ── 宿主半：perf patch 标记 ────────────────────────────────
  { file: 'src/perfPatch.ts', from: "'# dsh-vscode-mode perf tuning (start)'", to: `'# ${NEW} perf tuning (start)'`, note: 'perf patch 起始标记' },
  { file: 'src/perfPatch.ts', from: "'# dsh-vscode-mode perf tuning (end)'", to: `'# ${NEW} perf tuning (end)'`, note: 'perf patch 结束标记' },

  // ── 宿主半：日志前缀 ───────────────────────────────────────
  { file: 'src/shared/logger.ts', from: "export const LOG_PREFIX = '[dsh-vscode-mode]'", to: `export const LOG_PREFIX = '[${NEW}]'`, note: '日志前缀' },

  // ── 客户端半 ───────────────────────────────────────────────
  { file: 'src/client/compat.ts', from: "export const PLUGIN_NAME = 'dsh-vscode-mode'", to: `export const PLUGIN_NAME = '${NEW}'`, note: '客户端插件名' },
  { file: 'src/client/localeClient.ts', from: "export const LOCALE_NS = 'dsh-vscode-mode'", to: `export const LOCALE_NS = '${NEW}'`, note: 'locale 命名空间' },
  { file: 'src/client/officialSidebar.ts', from: "export const OFFICIAL_TAB_ID = 'dsh-vscode-mode'", to: `export const OFFICIAL_TAB_ID = '${NEW}'`, note: '侧栏 Tab id' },
  { file: 'src/client/officialSidebar.ts', from: "export const OFFICIAL_FILE_TAB_ID = 'dsh-vscode-mode/file'", to: `export const OFFICIAL_FILE_TAB_ID = '${NEW}/file'`, note: '侧栏文件 Tab id' },
  { file: 'src/client/ui/PluginDetailSection.ts', from: "export const SELF_ID = 'dsh-vscode-mode'", to: `export const SELF_ID = '${NEW}'`, note: '设置页自身 id' },
  { file: 'src/client/fileOpeners.ts', from: "export const VSCODE_OPEN_TOOL = 'dsh-vscode-mode'", to: `export const VSCODE_OPEN_TOOL = '${NEW}'`, note: '文件打开工具名' },
  { file: 'src/client/planBridge.ts', from: "const CLAIM_ID = 'dsh-vscode-mode/plan'", to: `const CLAIM_ID = '${NEW}/plan'`, note: '计划声明 id' },
  { file: 'src/client/shortcutsOfficial.ts', from: "const MIGRATION_KEY = 'dsh-vscode-mode.shortcuts-migrated.v1.'", to: `const MIGRATION_KEY = '${NEW}.shortcuts-migrated.v1.'`, note: '快捷键迁移标记' },
  { file: 'src/client/svnStore.ts', from: "plugin: 'dsh-vscode-mode'", to: `plugin: '${NEW}'`, note: 'SVN 事件流来源标记' },
  { file: 'src/client/dap/trace.ts', from: "plugin: 'dsh-vscode-mode'", to: `plugin: '${NEW}'`, note: 'DAP 事件流来源标记' },
]

/**
 * 保留不动的旧名（用户数据兼容 / 迁移识别 / 外部协议）。
 * - .dsh-edit-review*：工作区侧车（审查记录），换名会丢主人的历史
 * - .dsh-vscode-mode-tree.json：旧版树缓存文件名（仅用于清理）
 * - EDRV_* 常量：外部深链协议字段（Windows launcher / Unity 包 / URL 参数）
 * - edrv-* CSS 类名：DOM 契约前缀（4723 处，牵动全部样式）
 */
const KEEP = [
  '.dsh-edit-review-tree.json',
  '.dsh-vscode-mode-tree.json',
  '.dsh-edit-review.json',
  '.dsh-edit-review-archive.json',
  '.dsh-edit-review-debug.log',
  'EDRV_OPEN_FLAG / EDRV_PATHS_KEY / EDRV_LINE_KEY / EDRV_COLUMN_KEY',
  'edrv-* CSS 类名',
]

/**
 * 递归收集源文件。
 * @author rebrand @param {string} dir @returns {Promise<string[]>}
 */
async function collect(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await collect(full))
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full)
  }
  return out
}

let changed = 0

for (const edit of EDITS) {
  const path = resolve(ROOT, edit.file)
  const text = await readFile(path, 'utf8')
  if (!text.includes(edit.from)) {
    console.warn(`  ⚠ 未命中：${edit.file} ← ${edit.note}\n     期望片段：${edit.from}`)
    continue
  }
  const next = text.replace(edit.from, edit.to)
  if (next !== text) {
    if (!CHECK_ONLY) await writeFile(path, next, 'utf8')
    changed += 1
    console.log(`  ✓ ${edit.file}  ${edit.note}`)
  }
}

// ── 全仓扫描：RPC 方法名前缀 + HTTP 路由前缀 ──────────────────
// 例外：src/shared/externalOpen.ts（外部深链协议）整体跳过。
const files = await collect(resolve(ROOT, 'src'))
for (const file of files) {
  const rel = relative(ROOT, file)
  if (rel === 'src/shared/externalOpen.ts') continue
  const text = await readFile(file, 'utf8')
  // 'edrv.xxx' 形式的方法名 → 'cstudio.xxx'
  let next = text.replace(/(['"`])edrv\./g, `$1${NEW_PREFIX}.`)
  // '/edrv/...' 与 '/edrv' 形式的路由 → '/cstudio/...'
  next = next.replace(/\/edrv(?=['"`\/])/g, `/${NEW_PREFIX}`)
  if (next === text) continue
  if (!CHECK_ONLY) await writeFile(file, next, 'utf8')
  changed += 1
  console.log(`  ✓ ${rel}  路由/方法前缀`)
}

console.log(`\n换血完成：${changed} 个文件${CHECK_ONLY ? '（check 模式，未写入）' : ''}`)
console.log(`保留的用户数据/协议兼容名：\n  - ${KEEP.join('\n  - ')}`)
