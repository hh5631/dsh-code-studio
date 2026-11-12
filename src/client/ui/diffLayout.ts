/**
 * Git 差异的纯布局计算：单栏 / 双栏行配对、修改段分组与块内箭头锚点。
 * 与 DOM 无关，单独抽出便于钉住「双栏左右一一对应」「连续修改块聚簇」两个契约。
 */
import type { PatchLine, PatchPart } from '../../shared/gitPatch.js'

export type DiffMode = 'unified' | 'split'
export type DiffTone = 'add' | 'remove' | undefined
export type DiffSide = 'before' | 'after'

/** 双栏的一行：左右各取一条，缺的一侧用空隙占位。 */
export interface SplitRow {
  before?: PatchLine
  after?: PatchLine
  /** 需要画空白占位的一侧（另一侧有内容）。 */
  gap?: DiffSide
  beforeTone: DiffTone
  afterTone: DiffTone
  /** 该行属于修改段而非上下文。 */
  changed: boolean
}

/** 单栏的一行。 */
export interface UnifiedRow { line: PatchLine; tone: DiffTone }

/** 差异行语义：只有 after 是新增，只有 before 是删除，两者皆有为上下文。 */
export function toneOf(line?: PatchLine): DiffTone {
  if (!line) return undefined
  return line.before === undefined ? 'add' : line.after === undefined ? 'remove' : undefined
}

/** 单栏：上下文保持原样，修改段按「先删后增」逐行铺开。 */
export function unifiedRowsOf(part: PatchPart): UnifiedRow[] {
  if (part.kind === 'context') return part.lines.map(line => ({ line, tone: undefined }))
  return [
    ...part.before.map(line => ({ line, tone: 'remove' as DiffTone })),
    ...part.after.map(line => ({ line, tone: 'add' as DiffTone })),
  ]
}

/** 双栏：上下文左右同源；修改段按行号一一配对，缺行的一侧留空隙。 */
export function splitRowsOf(part: PatchPart): SplitRow[] {
  if (part.kind === 'context') return part.lines.map(line => ({
    before: line, after: line, beforeTone: undefined, afterTone: undefined, changed: false,
  }))
  const length = Math.max(part.before.length, part.after.length)
  return Array.from({ length }, (_, i) => {
    const before = part.before[i], after = part.after[i]
    return {
      before, after, changed: true,
      beforeTone: before ? 'remove' as DiffTone : undefined,
      afterTone: after ? 'add' as DiffTone : undefined,
      gap: !before && after ? 'before' as DiffSide : before && !after ? 'after' as DiffSide : undefined,
    }
  })
}

/** 修改段摘要（VSCode 式 gutter 提示）：起始行、删除数、新增数。 */
export function changeInfoOf(part: Extract<PatchPart, { kind: 'change' }>): { line: number; removed: number; added: number } {
  return {
    line: part.after[0]?.after ?? part.before[0]?.before ?? 1,
    removed: part.before.length,
    added: part.after.length,
  }
}

/** 块内箭头锚点行下标：优先落在有内容的一侧，取中部让长块也能一眼看到。 */
export function anchorRowOf(part: Extract<PatchPart, { kind: 'change' }>): number {
  const rows = splitRowsOf(part)
  if (!rows.length) return 0
  const populated = rows.findIndex(row => row.after !== undefined)
  const index = populated >= 0 ? populated : 0
  return Math.min(rows.length - 1, Math.max(index, Math.floor(rows.length / 2)))
}

export interface PartGroup {
  kind: 'context' | 'change'
  /** 聚簇内的 part 下标（相对整个 hunk），保持原始顺序且无遗漏。 */
  indices: number[]
}

/**
 * 把「几处连在一起的修改代码块」聚成簇：两个修改段之间若只隔着 <= gap 行上下文，
 * 视为同一簇（中间的短上下文也归入簇内，渲染时保持顺序）。
 * parseGitPatch 产出的 part 严格 context/change 交替，故这里按「连续的修改段 + 短上下文
 * 间隔」扫描即可，给同簇相邻块画中央沟槽里的连接竖线，避免连续小改动被切成互不相干的碎片。
 * @param parts 一个 hunk 内的全部 part
 * @param gap 允许视为相邻的最大上下文行数
 */
export function groupParts(parts: PatchPart[], gap = 2): PartGroup[] {
  const groups: PartGroup[] = []
  let index = 0
  while (index < parts.length) {
    if (parts[index].kind === 'context') {
      const indices: number[] = []
      while (index < parts.length && parts[index].kind === 'context') { indices.push(index); index++ }
      groups.push({ kind: 'context', indices })
      continue
    }
    const indices = [index++]
    while (index < parts.length) {
      if (parts[index].kind === 'change') { indices.push(index++); continue }
      // 遇到上下文：仅当其后紧跟修改段且间隔行数很小，才把这段短上下文并入本簇。
      let contextLines = 0, ahead = index
      while (ahead < parts.length && parts[ahead].kind === 'context') {
        contextLines += (parts[ahead] as Extract<PatchPart, { kind: 'context' }>).lines.length
        ahead++
      }
      if (ahead < parts.length && parts[ahead].kind === 'change' && contextLines <= gap) {
        for (let cursor = index; cursor < ahead; cursor++) indices.push(cursor)
        index = ahead
        continue
      }
      break
    }
    groups.push({ kind: 'change', indices })
  }
  return groups
}

/** 某 part 是否属于「含多个修改段」的簇（用于 CSS 连接竖线）。 */
export function groupedPartsOf(parts: PatchPart[], gap = 2): Set<number> {
  const grouped = new Set<number>()
  for (const group of groupParts(parts, gap)) {
    if (group.kind !== 'change') continue
    if (group.indices.filter(index => parts[index].kind === 'change').length < 2) continue
    for (const index of group.indices) grouped.add(index)
  }
  return grouped
}
