/**
 * dsh-code-studio client — 命令栏筛选与排序（纯函数，可单测）。
 * 匹配语义：查询与索引文本统一小写，空格分词，全部 token 需在 label/id/category
 * 任一字段中命中（连续子串或模糊子序列，不必相邻）；中文子串匹配天然成立。
 * 评分语义（分数越大越相关）：
 *   ① 连续匹配 > 词首匹配 > 子序列匹配；
 *   ② 匹配位置越靠前分数越高；
 *   ③ 完整前缀匹配 > 完整子串匹配；
 *   ④ 同档位、同位置时 label > id > category（沿用既有字段优先口径）。
 * 排序语义：查询为空按目录序（order 缺省 100）+ 注册序；查询非空按评分降序，
 * 同分再按目录序 + 注册序（保证同一查询下结果稳定、越相关的越靠前）。
 * 最近使用（MRU）加权见 rankCommands：仅在「有查询词」时把最近用过的命令置顶，
 * 空查询保持目录序（避免每次打开命令栏都是一串历史命令）。
 * 作者 ddj 2026年09月10号 / 2026年11月
 */
import type { CommandDef } from './ui/commandCatalog.js'

/** 排序用基础序（未声明 order 的命令排在已声明之后）。 */
const DEFAULT_ORDER = 100

/** 命中字段优先级（数值越小越优先）：label 优于 id 优于 category。 */
const FIELD_WEIGHT: Record<string, number> = { label: 0, id: 1, category: 2 }

/** 参与匹配与评分的字段顺序（同分时的字段优先序）。 */
const FIELDS = ['label', 'id', 'category'] as const

/** 可检索字段集合（fuzzyScore 的入参；值按小写比较）。 */
export interface SearchFields {
  /** 命令展示名。 */
  label: string
  /** 命令 id。 */
  id: string
  /** 命令分组名。 */
  category: string
}

/** 命令栏候选行（命令定义 + 命中权重 + 模糊评分）。 */
export interface CommandHit {
  command: CommandDef
  /** 命中字段权重（label 0 < id 1 < category 2；保留既有口径）。 */
  weight: number
  /** 模糊评分（越大越相关）。 */
  score: number
}

/** 评分档位：完整前缀匹配（最高档）。 */
const TIER_PREFIX = 100

/** 评分档位：连续子串匹配。 */
const TIER_CONTIGUOUS = 80

/** 评分档位：词首起头的子序列匹配。 */
const TIER_WORD_START = 40

/** 评分档位：泛子序列匹配（最低档）。 */
const TIER_SUBSEQUENCE = 20

/** 位置加分上限（匹配起点越靠前加分越高）。 */
const POSITION_MAX = 9

/** 整串加分：查询整体为字段前缀（小幅加分，不跨越评分档位）。 */
const WHOLE_PREFIX_BONUS = 3

/** 整串加分：查询整体为字段子串（小幅加分，不跨越评分档位）。 */
const WHOLE_SUBSTRING_BONUS = 1

/** 词边界分隔符（其后的字符视为词首）。 */
const WORD_SEPARATORS = new Set([
  ' ', '\t', '\n', '\r', '-', '_', '.', '/', '\\', ':', ';', ',', '(', ')', '[', ']', '{', '}',
  '（', '）', '【', '】', '，', '。', '、', '：', '；', '·', '>', '<', '|', '@', '#', '*', '?', '!',
])

/** 小写化（非字符串按空串处理，容错外部脏数据）。 */
function lower(text: unknown): string {
  return typeof text === 'string' ? text.toLocaleLowerCase('en-US') : ''
}

/** 是否中日韩字符（汉字逐字成词，每个字都视为词首）。 */
function isCjk(char: string): boolean {
  const code = char.charCodeAt(0)
  return (code >= 0x4e00 && code <= 0x9fff)
    || (code >= 0x3400 && code <= 0x4dbf)
    || (code >= 0xf900 && code <= 0xfaff)
}

/**
 * 某位置是否为词首（串首 / 分隔符之后 / camelCase 边界 / 汉字处）。
 * @author ddj 2026年11月10号
 * @param text 索引文本
 * @param index 位置
 * @returns 是否词首
 */
function isWordStart(text: string, index: number): boolean {
  if (index <= 0) return true
  const prev = text[index - 1]
  if (WORD_SEPARATORS.has(prev)) return true
  const current = text[index]
  if (isCjk(current)) return true
  // camelCase：前一字母为小写、当前字母为大写
  return prev >= 'a' && prev <= 'z' && current >= 'A' && current <= 'Z'
}

/** 一次子序列对齐的结果。 */
interface Alignment {
  /** 落在词首的匹配字符个数（越多越像「缩写式」命中）。 */
  wordStarts: number
  /** 匹配起点（用于位置加分）。 */
  start: number
}

/**
 * 对齐比较：词首命中多者更优；词首命中数相同时起点更靠前者更优。
 * @author ddj 2026年11月10号
 * @param a 候选对齐
 * @param b 对照对齐
 * @returns a 是否优于 b
 */
function betterAlignment(a: Alignment, b: Alignment): boolean {
  if (a.wordStarts !== b.wordStarts) return a.wordStarts > b.wordStarts
  return a.start < b.start
}

/**
 * 子序列最佳对齐（动态规划）。
 *
 * 目标：找出让**最多匹配字符落在词首**（串首 / 分隔符后 / camelCase 边界 / 汉字处）
 * 的对齐；词首命中数相同时取起点最靠左者。这样 `'sf'` 能命中 `save file`（s、f 都在词首，
 * 属「缩写式」高相关），而 `'sf'` 命中 `sxxfile` 只有 s 在词首（普通子序列，低一档）。
 * @author ddj 2026年11月10号
 * @param text 索引文本
 * @param token 查询 token
 * @returns 最佳对齐；无法完整匹配返回 null
 */
function bestAlignment(text: string, token: string): Alignment | null {
  const tokenLength = token.length
  if (!text || !tokenLength) return null
  // prev[p]：token[0..i-1] 匹配完、且 token[i-1] 落在位置 p 的最佳对齐
  let prev: (Alignment | null)[] = new Array(text.length).fill(null)
  for (let position = 0; position < text.length; position += 1) {
    if (text[position] !== token[0]) continue
    prev[position] = { wordStarts: isWordStart(text, position) ? 1 : 0, start: position }
  }
  for (let index = 1; index < tokenLength; index += 1) {
    const current: (Alignment | null)[] = new Array(text.length).fill(null)
    let best: Alignment | null = null
    for (let position = 0; position < text.length; position += 1) {
      if (position > 0) {
        const candidate = prev[position - 1]
        if (candidate && (!best || betterAlignment(candidate, best))) best = candidate
      }
      if (!best || text[position] !== token[index]) continue
      current[position] = {
        wordStarts: best.wordStarts + (isWordStart(text, position) ? 1 : 0),
        start: best.start,
      }
    }
    prev = current
  }
  let result: Alignment | null = null
  for (const candidate of prev) {
    if (candidate && (!result || betterAlignment(candidate, result))) result = candidate
  }
  return result
}

/**
 * 位置加分（匹配起点越靠前越高；上限 POSITION_MAX）。
 * @author ddj 2026年11月10号
 * @param index 匹配起点
 * @returns 位置加分
 */
function positionBonus(index: number): number {
  if (index <= 0) return POSITION_MAX
  return Math.max(0, POSITION_MAX - Math.min(POSITION_MAX, index))
}

/**
 * 单 token 在单个字段中的得分（不命中返回 null）。
 * 档位：完整前缀 > 连续子串 > 词首子序列 > 泛子序列；同档位按起点位置加分。
 * @author ddj 2026年11月10号
 * @param text 索引文本（小写）
 * @param token 查询 token（小写、非空）
 * @returns 该字段内的得分；未命中返回 null
 */
function tokenFieldScore(text: string, token: string): number | null {
  if (!text || !token) return null
  if (text.startsWith(token)) return TIER_PREFIX + positionBonus(0)
  const at = text.indexOf(token)
  if (at >= 0) return TIER_CONTIGUOUS + positionBonus(at)
  const alignment = bestAlignment(text, token)
  if (!alignment) return null
  // 落在词首的字符越多越优（缩写式命中 > 普通子序列命中）。
  // 词首命中数 ≥ token 长度说明「每个字符都在词首」，给满档位；
  // 部分词首命中给中间档（TIER_WORD_START），完全没落在词首给最低档（TIER_SUBSEQUENCE）。
  const ratio = alignment.wordStarts / token.length
  const tier = ratio >= 1
    ? TIER_WORD_START
    : ratio > 0
      ? Math.round(TIER_SUBSEQUENCE + (TIER_WORD_START - TIER_SUBSEQUENCE) * ratio)
      : TIER_SUBSEQUENCE
  return tier + positionBonus(alignment.start)
}

/** 单 token 的最佳命中（得分 + 命中字段权重）。 */
interface TokenHit {
  score: number
  weight: number
}

/**
 * 单 token 在三个字段中的最佳命中（字段优先级仅作同档位微调）。
 * @author ddj 2026年11月10号
 * @param fields 索引文本
 * @param token 查询 token（小写、非空）
 * @returns 最佳命中；未命中返回 null
 */
function tokenBestHit(fields: SearchFields, token: string): TokenHit | null {
  let best: TokenHit | null = null
  for (const name of FIELDS) {
    const raw = tokenFieldScore(fields[name], token)
    if (raw === null) continue
    const weight = FIELD_WEIGHT[name]
    const score = raw - weight
    if (best === null || score > best.score) best = { score, weight }
  }
  return best
}

/**
 * 整串加分：整个查询（去空格）在字段中为前缀 / 子串时给小幅加分。
 * 只做同档位微调，不跨越评分档位（前缀档 > 子串档）。
 * @author ddj 2026年11月10号
 * @param fields 索引文本
 * @param joined 查询各 token 拼接串
 * @returns 加分（0 / 1 / 3）
 */
function wholeQueryBonus(fields: SearchFields, joined: string): number {
  if (!joined) return 0
  let bonus = 0
  for (const name of FIELDS) {
    const compact = fields[name].replace(/\s+/g, '')
    if (!compact) continue
    if (compact.startsWith(joined)) {
      bonus = Math.max(bonus, WHOLE_PREFIX_BONUS)
      continue
    }
    if (compact.includes(joined)) bonus = Math.max(bonus, WHOLE_SUBSTRING_BONUS)
  }
  return bonus
}

/**
 * 模糊匹配评分（纯函数）。
 *
 * 语义：查询按空格分词，**每个 token 都必须命中**（命中即可，不必连续——支持
 * 子序列模糊匹配）；全部命中返回总分，任一 token 未命中返回 null。
 * 评分规则：连续匹配 > 词首匹配 > 子序列匹配；匹配位置越靠前分数越高；
 * 完整前缀匹配 > 完整子串匹配；同档位时 label > id > category。
 *
 * 空查询返回 0（中性分：不构成命中约束，所有命令同等）。
 * @author ddj 2026年11月10号
 * @param fields 待检索字段（label/id/category）
 * @param query 用户输入
 * @returns 评分（越大越相关）；未命中返回 null
 */
export function fuzzyScore(fields: SearchFields, query: string): number | null {
  const normalized: SearchFields = {
    label: lower(fields?.label),
    id: lower(fields?.id),
    category: lower(fields?.category),
  }
  const tokens = lower(query).split(/\s+/).filter(Boolean)
  if (!tokens.length) return 0
  let total = 0
  for (const token of tokens) {
    const hit = tokenBestHit(normalized, token)
    if (hit === null) return null
    total += hit.score
  }
  return total + wholeQueryBonus(normalized, tokens.join(''))
}

/** 建立一条命令的索引文本（小写）。 */
function indexOf(command: CommandDef): SearchFields {
  return { label: lower(command.label), id: lower(command.id), category: lower(command.category) }
}

/** 目录序（order 缺省 100；非有限值同样按 100）。 */
function orderOf(command: CommandDef): number {
  const order = command.order
  return typeof order === 'number' && Number.isFinite(order) ? order : DEFAULT_ORDER
}

/** 打分后的候选（命令 + 评分 + 命中字段权重 + 原始注册序）。 */
interface ScoredCommand {
  command: CommandDef
  hit: CommandHit
  index: number
}

/**
 * 过滤并按相关度排序命令（空查询返回全部，仅按目录序排序）。
 *
 * 行为契约（既有单测依赖，不得破坏）：签名不变；全部 token 都必须命中；
 * 命中时按「模糊评分降序 → 目录序 → 注册序」稳定排序。
 * @author ddj 2026年09月10号 / 2026年11月
 * @param commands 候选命令（调用方通常已按可用性过滤）
 * @param query 用户输入
 * @returns 命中命令数组
 */
export function filterCommands(commands: readonly CommandDef[], query: string): CommandDef[] {
  return rankCommands(commands, query)
}

/**
 * 命令排序（可带「最近使用」加权）。
 *
 * 排序键：最近使用优先（仅查询非空时生效，最近者更靠前）→ 模糊评分降序 →
 * 目录序 → 注册序。最近使用命中全部候选时按「最近使用先后」排在最前，
 * 空查询时完全保持目录序。
 * @author ddj 2026年11月10号
 * @param commands 候选命令（调用方通常已按可用性过滤）
 * @param query 用户输入
 * @param recentIds 最近使用的命令 id（按最近在前；缺省不启用加权）
 * @returns 排序后的命令数组
 */
export function rankCommands(
  commands: readonly CommandDef[],
  query: string,
  recentIds: readonly string[] = [],
): CommandDef[] {
  const tokens = lower(query).split(/\s+/).filter(Boolean)
  const scored: ScoredCommand[] = []
  const plain: { command: CommandDef; index: number }[] = []
  commands.forEach((command, index) => {
    if (!tokens.length) {
      plain.push({ command, index })
      return
    }
    const fields = indexOf(command)
    let score = 0
    let weight = Number.MAX_SAFE_INTEGER
    let missed = false
    for (const token of tokens) {
      const hit = tokenBestHit(fields, token)
      if (hit === null) {
        missed = true
        break
      }
      score += hit.score
      if (hit.weight < weight) weight = hit.weight
    }
    if (missed) return
    scored.push({ command, hit: { command, weight, score }, index })
  })
  if (!tokens.length) {
    return plain
      .sort((a, b) => orderOf(a.command) - orderOf(b.command) || a.index - b.index)
      .map((entry) => entry.command)
  }
  // 最近使用排名（数字小者更近；未命中者排最后）
  const recentRank = new Map<string, number>()
  recentIds.forEach((id, index) => {
    if (!recentRank.has(id)) recentRank.set(id, index)
  })
  const rankOf = (id: string): number => {
    const found = recentRank.get(id)
    return found === undefined ? Number.MAX_SAFE_INTEGER : found
  }
  return scored
    .sort((a, b) => rankOf(a.command.id) - rankOf(b.command.id)
      || b.hit.score - a.hit.score
      || orderOf(a.command) - orderOf(b.command)
      || a.index - b.index)
    .map((entry) => entry.command)
}

/** 命令栏分组（组标题 + 组内命令）。 */
export interface CommandGroup {
  /** 组名（命令 category；缺省归入「其它」）。 */
  category: string
  /** 组内命令（已按相关度排序）。 */
  commands: CommandDef[]
}

/**
 * 按分类分组（组序 = 组内最佳命中项的排序；无查询词时按目录首次出现序）。
 *
 * 分组只改展示，不改命中语义：命中的命令集合与 filterCommands 完全一致。
 * @author ddj 2026年11月10号
 * @param commands 候选命令（调用方通常已按可用性过滤）
 * @param query 用户输入
 * @param recentIds 最近使用的命令 id（按最近在前；缺省不启用加权）
 * @returns 分组数组
 */
export function groupCommands(
  commands: readonly CommandDef[],
  query: string,
  recentIds: readonly string[] = [],
): CommandGroup[] {
  const ranked = rankCommands(commands, query, recentIds)
  const groups: CommandGroup[] = []
  const index = new Map<string, CommandGroup>()
  for (const command of ranked) {
    const category = command.category || '其它'
    const existing = index.get(category)
    if (existing) {
      existing.commands.push(command)
      continue
    }
    const group: CommandGroup = { category, commands: [command] }
    index.set(category, group)
    groups.push(group)
  }
  return groups
}
