/**
 * dsh-code-studio client — 命令栏最近使用记录（localStorage 持久化）。
 *
 * 语义：对齐 VSCode 命令面板的 MRU（Most Recently Used）行为：命令被执行过一次
 * 就会进入最近列表，列表容量上限 RECENT_COMMANDS_CAP（30 条），超限时逐出最旧。
 *
 * 排序用法：**仅在有查询词时**把最近用过的命令提到前面（VSCode 行为）；空查询时
 * 不提升，保持目录序——否则每次打开命令栏都是一串历史命令，反而不好用。
 *
 * 存储：localStorage 单键（键名见 paths.CACHE_KEY.commandRecents），值为 JSON 数组
 * `[{ id, ts }]`（ts = 使用时间戳，倒序）。存储不可用（隐私模式 / 非浏览器环境）时
 * 全链路静默降级为「仅内存 + 本次会话内有效」，绝不抛错打断命令执行。
 * 作者 ddj 2026年11月10号
 */
import { CACHE_KEY } from './paths.js'

/** 最近使用记录条数上限（超出逐出最旧的一条）。 */
export const RECENT_COMMANDS_CAP = 30

/** 单条最近使用记录。 */
export interface RecentCommandEntry {
  /** 命令 id。 */
  id: string
  /** 使用时间戳（毫秒）。 */
  ts: number
}

/** 内存兜底（localStorage 不可用时本次会话内仍可用）。 */
let memoryFallback: RecentCommandEntry[] = []

/** 存档格式版本（结构不兼容时递增，旧档自动作废）。 */
const RECENTS_VERSION = 1

/**
 * 读取 localStorage（不可用时返回 null）。
 * @author ddj 2026年11月10号
 * @returns Storage 或 null
 */
function storage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage
  } catch {
    // 某些环境访问 localStorage 本身会抛（隐私模式 / 被禁用）
    return null
  }
}

/**
 * 归一化记录数组：丢弃无 id / 非法的项，重复 id 保留**最新一条**，按时间倒序，超限截断。
 * @author ddj 2026年11月10号
 * @param entries 原始记录（非数组 → 空表）
 * @returns 归一化后的记录数组（最新在前）
 */
export function cleanRecentEntries(entries: unknown): RecentCommandEntry[] {
  if (!Array.isArray(entries)) return []
  const byId = new Map<string, RecentCommandEntry>()
  for (const raw of entries) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as Partial<RecentCommandEntry>
    if (typeof entry.id !== 'string' || !entry.id) continue
    const ts = typeof entry.ts === 'number' && Number.isFinite(entry.ts) ? entry.ts : 0
    const existing = byId.get(entry.id)
    // 重复 id 保留时间戳较新的那条（存档里可能是旧副本在前）
    if (existing && existing.ts >= ts) continue
    byId.set(entry.id, { id: entry.id, ts })
  }
  const out = [...byId.values()]
  // 稳定按时间倒序；时间相同者保持原序（记录本身已是倒序写入）
  out.sort((a, b) => b.ts - a.ts)
  return out.length > RECENT_COMMANDS_CAP ? out.slice(0, RECENT_COMMANDS_CAP) : out
}

/**
 * 序列化最近使用记录（空表 → 空串，调用方据此删键）。
 * @author ddj 2026年11月10号
 * @param entries 记录数组
 * @returns 存档文本
 */
export function serializeRecentCommands(entries: readonly RecentCommandEntry[]): string {
  const clean = cleanRecentEntries(entries)
  if (!clean.length) return ''
  return JSON.stringify({ v: RECENTS_VERSION, entries: clean })
}

/**
 * 解析存档文本（空/损坏/版本不符 → null）。
 * @author ddj 2026年11月10号
 * @param text localStorage 原文
 * @returns 记录数组（最新在前）；无有效内容返回 null
 */
export function parseRecentCommands(text: string | null): RecentCommandEntry[] | null {
  if (!text) return null
  try {
    const value = JSON.parse(text) as { v?: unknown; entries?: unknown }
    if (!value || typeof value !== 'object' || value.v !== RECENTS_VERSION) return null
    const clean = cleanRecentEntries(value.entries)
    return clean.length ? clean : null
  } catch {
    return null
  }
}

/**
 * 读取全部最近使用记录（最新在前）。
 * @author ddj 2026年11月10号
 * @returns 记录数组
 */
function loadEntries(): RecentCommandEntry[] {
  const store = storage()
  if (!store) return memoryFallback
  try {
    const parsed = parseRecentCommands(store.getItem(CACHE_KEY.commandRecents))
    return parsed ?? []
  } catch {
    return []
  }
}

/**
 * 写入最近使用记录（空表删键）。
 * @author ddj 2026年11月10号
 * @param entries 记录数组
 */
function saveEntries(entries: readonly RecentCommandEntry[]): void {
  const clean = cleanRecentEntries(entries)
  memoryFallback = clean
  const store = storage()
  if (!store) return
  try {
    const text = serializeRecentCommands(clean)
    if (!text) {
      store.removeItem(CACHE_KEY.commandRecents)
      return
    }
    store.setItem(CACHE_KEY.commandRecents, text)
  } catch {
    // 配额超限等：内存兜底仍保留本次会话的行为
  }
}

/**
 * 记录一次命令使用（置顶该 id 并打时间戳；容量超限逐出最旧）。
 * @author ddj 2026年11月10号
 * @param id 命令 id（空串忽略）
 */
export function recordCommandUse(id: string): void {
  if (typeof id !== 'string' || !id) return
  const entries = loadEntries().filter((entry) => entry.id !== id)
  entries.unshift({ id, ts: Date.now() })
  saveEntries(entries)
}

/**
 * 最近使用的命令 id（最新在前；无记录返回空数组）。
 * @author ddj 2026年11月10号
 * @returns 命令 id 数组
 */
export function recentCommandIds(): string[] {
  return loadEntries().map((entry) => entry.id)
}

/**
 * 清空最近使用记录（删键 + 清内存兜底）。
 * @author ddj 2026年11月10号
 */
export function clearRecentCommands(): void {
  memoryFallback = []
  const store = storage()
  if (!store) return
  try {
    store.removeItem(CACHE_KEY.commandRecents)
  } catch {
    /* 存储不可用：内存兜底已清空 */
  }
}
