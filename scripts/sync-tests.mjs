#!/usr/bin/env node
/**
 * sync-tests.mjs — 以**源代码为唯一事实源**同步测试里的标识符。
 *
 * 背景：dsh-vscode-mode → dsh-code-studio 的换血涉及两类语义完全不同的标识：
 *  · RPC 方法名（传输层协议）：源码已改为 cstudio.* —— 改名无害，且体现新身份
 *  · 命令 ID / 用户数据键 / DOM 事件 / CSS 类名（协议与状态契约）：必须保持 edrv.*
 *    （官方 shortcuts 目录按 'edrv.' 前缀匹配；localStorage 键存着主人的界面状态，
 *      改名即丢状态；DOM 事件与 CSS 类名是跨文件契约。）
 *
 * 本脚本从源码**自动分类**这两类标识，再把测试同步到与源码逐字一致 ——
 * 不靠人工枚举，避免漏项与误改。
 *
 * 用法：node scripts/sync-tests.mjs [--check]
 */
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const SRC = join(ROOT, 'src')
const TESTS = join(ROOT, 'tests')
const CHECK_ONLY = process.argv.includes('--check')

/**
 * 递归收集文件。
 * @param {string} dir @param {RegExp} re @returns {Promise<string[]>}
 */
async function collect(dir, re) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await collect(full, re))
    else if (re.test(entry.name)) out.push(full)
  }
  return out
}

/** RPC 方法名所在的源文件（方法表键位置）。 */
const RPC_FILES = [
  'rpc.ts', 'reviewRpc.ts', 'pendingRpc.ts', 'svn.ts',
  'shared/rpc.ts', 'lsp/rpc.ts', 'dap/rpc.ts', 'ai/rpc.ts',
]
/** 命令 ID 所在的源文件（目录 / 快捷键表 / SVN 动作表）。 */
const CMD_FILES = ['commandCatalog.ts', 'shared/keybindings.ts', 'shared/svnActions.ts']

const srcFiles = await collect(SRC, /\.tsx?$/)

/** RPC 方法名（cstudio.*）→ 名称集合。 */
const rpcNames = new Set()
/** 命令 ID（edrv.*）→ 名称集合。 */
const cmdNames = new Set()

for (const file of srcFiles) {
  const rel = relative(SRC, file).replaceAll('\\', '/')
  const text = await readFile(file, 'utf8')
  const isRpc = RPC_FILES.some((name) => rel === name || rel.endsWith('/' + name))
  const isCmd = CMD_FILES.some((name) => rel === name || rel.endsWith('/' + name))
  if (isRpc) {
    for (const m of text.matchAll(/'cstudio\.([A-Za-z][A-Za-z0-9.]*)'/g)) rpcNames.add(m[1])
  }
  if (isCmd) {
    for (const m of text.matchAll(/'edrv\.([A-Za-z][A-Za-z0-9.]*)'/g)) cmdNames.add(m[1])
  }
}

console.log(`源码分类：RPC 方法 ${rpcNames.size} 个（cstudio.）｜命令 ID ${cmdNames.size} 个（edrv.）`)

/**
 * 判定一个标识名属于哪一类。
 * @param {string} name 标识名（不含前缀）
 * @returns {'rpc' | 'cmd' | 'other'} 类别
 */
function classify(name) {
  const isRpc = rpcNames.has(name)
  const isCmd = cmdNames.has(name)
  if (isRpc && !isCmd) return 'rpc'
  if (isCmd && !isRpc) return 'cmd'
  // 两边都有（如 'save' 同时是 RPC 方法与命令 ID）：
  // 点分多段名（a.b）只可能是 RPC 方法；单词名按 RPC 优先，
  // 但命令 ID 在测试里通常出现在 chords/目录断言语境 —— 统一按 RPC 处理，
  // 由测试自身的语义断言兜底。
  if (isRpc) return 'rpc'
  if (isCmd) return 'cmd'
  return 'other'
}

const testFiles = await collect(TESTS, /\.(ts|mjs)$/)
let changed = 0
let hits = 0

for (const file of testFiles) {
  const text = await readFile(file, 'utf8')
  let next = text
  next = next.replace(/(['"])cstudio\.([A-Za-z][A-Za-z0-9.]*)\1/g, (full, quote, name) => {
    const kind = classify(name)
    if (kind === 'rpc') return full
    if (kind === 'cmd') {
      hits += 1
      return `${quote}edrv.${name}${quote}`
    }
    return full
  })
  // 反向同步：源里是 RPC 方法名（cstudio.*），测试里若仍写 edrv.* 也要跟上。
  next = next.replace(/(['"])edrv\.([A-Za-z][A-Za-z0-9.]*)\1/g, (full, quote, name) => {
    if (classify(name) !== 'rpc') return full
    hits += 1
    return `${quote}cstudio.${name}${quote}`
  })
  if (next !== text) {
    if (!CHECK_ONLY) await writeFile(file, next, 'utf8')
    changed += 1
    console.log(`  ✓ ${relative(TESTS, file)}`)
  }
}
console.log(`\n同步完成：${changed} 个文件，${hits} 处命令 ID 前缀${CHECK_ONLY ? '（check 模式，未写入）' : ''}`)
