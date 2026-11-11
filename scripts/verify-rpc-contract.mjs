#!/usr/bin/env node
/**
 * verify-rpc-contract.mjs — 校验「客户端 RPC 调用名」与「host 方法表」一致。
 *
 * 为什么需要：换血时 RPC 方法名从 edrv.* 迁到 cstudio.*，若客户端某处
 * 漏改，调用会静默失败（fetch 拿到 ok:false 或抛协议错误），症状是
 * 「保存没反应」「日志没了」这类难定位的问题。本脚本把这类漏改挡在构建期。
 *
 * 用法：node scripts/verify-rpc-contract.mjs
 */
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const SRC = join(ROOT, 'src')

/** host 侧方法表所在的源文件。 */
const HOST_FILES = [
  'rpc.ts', 'reviewRpc.ts', 'pendingRpc.ts', 'svn.ts',
  'shared/rpc.ts', 'lsp/rpc.ts', 'dap/rpc.ts', 'ai/rpc.ts',
]

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

const files = await collect(SRC, /\.tsx?$/)

/** host 侧真实存在的方法名（不含前缀）。 */
const hostMethods = new Set()
/** host 侧仍以 edrv. 为前缀的方法名（基线就有的少数几个，非迁移对象）。 */
const hostLegacyMethods = new Set()
for (const file of files) {
  const rel = relative(SRC, file).replaceAll('\\', '/')
  if (!HOST_FILES.some((name) => rel === name || rel.endsWith('/' + name))) continue
  const text = await readFile(file, 'utf8')
  for (const m of text.matchAll(/'cstudio\.([A-Za-z][A-Za-z0-9.]*)'/g)) hostMethods.add(m[1])
  for (const m of text.matchAll(/'edrv\.([A-Za-z][A-Za-z0-9.]*)'/g)) hostLegacyMethods.add(m[1])
}

/**
 * 客户端调用点：rpc('方法名', ...)。
 *
 * 方法名前缀有三类来源（各有来历，不可一刀切）：
 *  · cstudio.* —— 本次换血从 edrv.* 迁移过来的传输层方法
 *  · svn.* / rules.* / mcp.* / snippets.* / vscode.* / compat —— 上游原有的领域
 *    方法名，本来就不带 edrv. 前缀，**不属于迁移范围**
 *  · edrv.* —— 基线就有的少数方法（如 edrv.save），宿主表里仍然保留，不算残留
 */
const problems = []
for (const file of files) {
  const rel = relative(SRC, file).replaceAll('\\', '/')
  if (!rel.startsWith('client/')) continue
  const text = await readFile(file, 'utf8')
  for (const m of text.matchAll(/\brpc\(\s*'([^']+)'/g)) {
    const name = m[1]
    // 迁移后残留的旧前缀：宿主表里已无此方法
    if (name.startsWith('edrv.')) {
      const suffix = name.slice('edrv.'.length)
      if (!hostLegacyMethods.has(suffix)) {
        problems.push({ file: rel, name, why: '迁移后残留的 edrv. 前缀（宿主表已改用 cstudio.）' })
      }
      continue
    }
    // cstudio.* 必须命中宿主方法表
    if (name.startsWith('cstudio.')) {
      const suffix = name.slice('cstudio.'.length)
      if (!hostMethods.has(suffix)) {
        problems.push({ file: rel, name, why: 'host 方法表中不存在该方法' })
      }
    }
  }
}

if (problems.length) {
  console.error('✗ RPC 契约不一致：')
  for (const p of problems) console.error(`  ${p.file}: rpc('${p.name}') — ${p.why}`)
  process.exit(1)
}
console.log(`✓ RPC 契约一致：客户端调用全部命中 host 方法表（${hostMethods.size} 个方法）`)
