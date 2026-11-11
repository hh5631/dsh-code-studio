/**
 * dsh-code-studio host — 目录快速列取（edrv.listDir 数据来源，树索引 miss 时走这里）。
 * dsh-fs.listDir 对每个子项顺序 realpath+stat（2 次 open/项），在本部署被中介的
 * open（0.3–3s/次）下大目录呈分钟级；这里用原生 readdir(withFileTypes) 一次取型
 * （O(1) open），仅对 symlink/junction（Windows junction 在 dirent 中报 symlink，
 * 已实测）并行 follow-stat 判型，延迟按轮摊平而非按条目累加。
 * 结果形状与 dsh-fs 一致（name/type），由调用方 toTreeEntries 整形排序。
 * 作者 ddj 2026-08-31
 */
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { DirChildLike } from './tree.js'

// --region 常量
/** symlink 并行 stat 分块并发数（并行摊平单次 open 延迟）。 */
export const SYMLINK_CONCURRENCY = 32
/** symlink 并行 stat 总数上限：超出部分按 other（防御病态 symlink 目录）。 */
export const MAX_SYMLINK_STATS = 256
/**
 * 文件体积采集的条目数上限。
 * 背景：本部署的 open 延迟被中介放大（0.3–3s/次），对大目录逐项 stat 会让
 * 文件树卡住数秒。故只有条目数不超过该阈值时才采集 size，超出则整体省略
 * （UI 侧 size 缺省即不显示）。
 */
export const MAX_SIZE_STATS = 200
// --endregion

/** 列取失败（带稳定语义 code，调用方转文案）。 */
export class DirListError extends Error {
  constructor(
    readonly code: 'not-found' | 'not-dir' | 'permission' | 'io',
    message: string,
  ) {
    super(message)
  }
}

/** node fs 错误码 → 稳定语义错误。 */
function codeOf(err: unknown): DirListError {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOENT') return new DirListError('not-found', '目录不存在')
  if (code === 'ENOTDIR') return new DirListError('not-dir', '不是目录')
  if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY') return new DirListError('permission', '权限不足')
  return new DirListError('io', String((err as Error | undefined)?.message ?? err))
}

/** 并行 stat 一批绝对路径 → 目录/文件/other（follow symlink，失败按 other）。 */
async function statTypes(paths: string[], out: Map<string, 'directory' | 'file' | 'other'>): Promise<void> {
  const cap = Math.min(paths.length, MAX_SYMLINK_STATS)
  for (let i = 0; i < cap; i += SYMLINK_CONCURRENCY) {
    const chunk = paths.slice(i, i + SYMLINK_CONCURRENCY)
    await Promise.all(chunk.map(async (p) => {
      try {
        const info = await stat(p)
        out.set(p, info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other')
      } catch (error) {
        out.set(p, 'other')
      }
    }))
  }
}

/**
 * 快速列取目录：一次 readdir(withFileTypes) 判型；symlink 并行 follow-stat。
 * 体积采集：条目数 ≤ {@link MAX_SIZE_STATS} 时并行 stat 一次取 size（供文件树显示），
 * 超出则整体省略（避免大目录逐项 stat 的秒级延迟）。
 * @author ddj 2026年08月31号
 * @param absDir 绝对目录路径（fs.resolve 后的 targetKey）
 * @returns 子项列表（name/type/size；size 仅在小目录时给出）
 * @throws DirListError 目录不存在/不是目录/权限不足/IO 失败
 */
export async function listDirCheap(absDir: string): Promise<DirChildLike[]> {
  let dirents
  try {
    dirents = await readdir(absDir, { withFileTypes: true, encoding: 'utf8' })
  } catch (error) {
    throw codeOf(error)
  }
  const out: DirChildLike[] = []
  const syms: string[] = []
  for (const d of dirents) {
    if (d.isDirectory()) out.push({ name: d.name, type: 'directory' })
    else if (d.isFile()) out.push({ name: d.name, type: 'file' })
    else if (d.isSymbolicLink()) syms.push(d.name)
    else out.push({ name: d.name, type: 'other' })
  }
  if (syms.length) {
    const symAbs = syms.map((name) => join(absDir, name))
    const types = new Map<string, 'directory' | 'file' | 'other'>()
    await statTypes(symAbs, types)
    for (let i = 0; i < syms.length; i++) {
      out.push({ name: syms[i], type: types.get(symAbs[i]) ?? 'other' })
    }
  }
  await attachSizes(absDir, out)
  return out
}

/**
 * 并行 stat 文件条目补齐体积（小目录才调用）。
 * 失败静默：拿不到 size 只是不显示体积，不影响列取本身。
 * @author dsh-code-studio 2026-11-10
 * @param absDir 目录绝对路径
 * @param out 子项列表（就地补 size 字段）
 */
async function attachSizes(absDir: string, out: DirChildLike[]): Promise<void> {
  if (out.length === 0 || out.length > MAX_SIZE_STATS) return
  const files = out.filter((item) => item.type === 'file')
  if (!files.length) return
  await Promise.all(files.map(async (item) => {
    try {
      const info = await stat(join(absDir, item.name))
      if (info.isFile()) item.size = info.size
    } catch (error) {
      /* 体积取不到静默：仅不显示体积 */
    }
  }))
}
