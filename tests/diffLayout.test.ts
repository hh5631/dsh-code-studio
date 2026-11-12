/** Git 差异布局纯函数：双栏配对、相邻修改段聚簇、块内箭头锚点。 */
import { describe, expect, it } from 'vitest'
import { parseGitPatch, type PatchPart } from '../src/shared/gitPatch.js'
import {
  anchorRowOf, changeInfoOf, groupParts, groupedPartsOf, splitRowsOf, toneOf, unifiedRowsOf,
} from '../src/client/ui/diffLayout.js'

const header = 'diff --git a/a.txt b/a.txt\nindex 1111111..2222222 100644\n--- a/a.txt\n+++ b/a.txt\n'

function partsOf(patch: string): PatchPart[] {
  const parsed = parseGitPatch(header + patch)
  if (!parsed) throw new Error('bad fixture patch')
  return parsed.hunks[0].parts
}

describe('toneOf', () => {
  it('按行号区分新增 / 删除 / 上下文', () => {
    expect(toneOf({ text: 'x', after: 3, newline: true })).toBe('add')
    expect(toneOf({ text: 'x', before: 3, newline: true })).toBe('remove')
    expect(toneOf({ text: 'x', before: 3, after: 3, newline: true })).toBeUndefined()
    expect(toneOf(undefined)).toBeUndefined()
  })
})

describe('unifiedRowsOf', () => {
  it('修改段按先删后增铺开，上下文保持单列', () => {
    const parts = partsOf('@@ -1,2 +1,2 @@\n keep\n-old\n+new\n')
    expect(unifiedRowsOf(parts[0]).map(row => row.tone)).toEqual([undefined])
    expect(unifiedRowsOf(parts[1]).map(row => [row.tone, row.line.text])).toEqual([
      ['remove', 'old'], ['add', 'new'],
    ])
  })
})

describe('splitRowsOf', () => {
  it('修改段左右一一配对，缺行的一侧标为空隙', () => {
    const parts = partsOf('@@ -1,4 +1,3 @@\n-a\n-b\n-c\n+d\n+e\n keep\n')
    const change = parts[0] as Extract<PatchPart, { kind: 'change' }>
    expect(splitRowsOf(change).map(row => ({
      before: row.before?.text, after: row.after?.text, gap: row.gap,
      beforeTone: row.beforeTone, afterTone: row.afterTone,
    }))).toEqual([
      { before: 'a', after: 'd', gap: undefined, beforeTone: 'remove', afterTone: 'add' },
      { before: 'b', after: 'e', gap: undefined, beforeTone: 'remove', afterTone: 'add' },
      { before: 'c', after: undefined, gap: 'after', beforeTone: 'remove', afterTone: undefined },
    ])
  })

  it('上下文行左右同源且不带增删色', () => {
    const parts = partsOf('@@ -1,2 +1,2 @@\n keep\n-old\n+new\n')
    const rows = splitRowsOf(parts[0])
    expect(rows).toHaveLength(1)
    expect(rows[0].before).toBe(rows[0].after)
    expect(rows[0].beforeTone).toBeUndefined()
    expect(rows[0].afterTone).toBeUndefined()
    expect(rows[0].changed).toBe(false)
  })

  it('纯新增时左侧全部为空隙', () => {
    const parts = partsOf('@@ -1,1 +1,3 @@\n keep\n+one\n+two\n')
    const change = parts[1] as Extract<PatchPart, { kind: 'change' }>
    expect(splitRowsOf(change).map(row => row.gap)).toEqual(['before', 'before'])
  })
})

describe('changeInfoOf / anchorRowOf', () => {
  it('摘要取修改后起始行并统计增删行数', () => {
    const parts = partsOf('@@ -5,3 +5,1 @@\n-a\n-b\n-c\n+x\n')
    expect(changeInfoOf(parts[0] as Extract<PatchPart, { kind: 'change' }>)).toEqual({ line: 5, removed: 3, added: 1 })
  })

  it('箭头锚点落在有内容行的中部，且不越界', () => {
    const parts = partsOf('@@ -1,5 +1,5 @@\n-a\n-b\n-c\n-d\n-e\n+1\n+2\n+3\n+4\n+5\n')
    const change = parts[0] as Extract<PatchPart, { kind: 'change' }>
    const index = anchorRowOf(change)
    expect(index).toBeGreaterThanOrEqual(0)
    expect(index).toBeLessThan(splitRowsOf(change).length)
    expect(splitRowsOf(change)[index].after).toBeDefined()
  })
})

describe('groupParts', () => {
  it('只隔一两行上下文的连续修改段归为同一簇', () => {
    const parts = partsOf('@@ -1,5 +1,5 @@\n-a\n+A\n keep\n-b\n+B\n keep\n-c\n+C\n')
    const kinds = parts.map(part => part.kind)
    expect(kinds).toEqual(['change', 'context', 'change', 'context', 'change'])
    const groups = groupParts(parts, 2)
    expect(groups).toHaveLength(1)
    expect(groups[0].kind).toBe('change')
    expect(groups[0].indices).toEqual([0, 1, 2, 3, 4])
    expect([...groupedPartsOf(parts, 2)].sort()).toEqual([0, 1, 2, 3, 4])
  })

  it('间隔较远的修改段拆成不同簇', () => {
    const parts = partsOf('@@ -1,8 +1,8 @@\n-a\n+A\n k1\n k2\n k3\n k4\n k5\n k6\n-b\n+B\n')
    expect(groupParts(parts, 2).map(group => group.indices)).toEqual([[0], [1], [2]])
  })

  it('纯上下文不产生修改簇', () => {
    const parts = partsOf('@@ -1,3 +1,3 @@\n a\n b\n c\n')
    expect(groupParts(parts, 2)).toEqual([{ kind: 'context', indices: [0] }])
    expect(groupedPartsOf(parts, 2).size).toBe(0)
  })
})
