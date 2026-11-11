/**
 * 命令面板匹配与排序增强测试（纯函数 + localStorage 桩）。
 * 覆盖：fuzzyScore 模糊评分（连续 > 词首 > 子序列、位置加权、前缀 > 子串、多 token AND）、
 * filterCommands 行为契约（签名/空查询/命中集合/稳定排序不变）、
 * rankCommands 最近使用加权（仅查询非空时置顶）、groupCommands 分组、
 * commandRecents 记录/读取/清空/容量上限/存档往返。
 * 作者 ddj 2026-11-10
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { filterCommands, fuzzyScore, groupCommands, rankCommands } from '../src/client/commandSearch.js'
import {
  cleanRecentEntries, clearRecentCommands, parseRecentCommands, recentCommandIds,
  recordCommandUse, RECENT_COMMANDS_CAP, serializeRecentCommands,
} from '../src/client/commandRecents.js'
import { CACHE_KEY } from '../src/client/paths.js'
import type { CommandDef } from '../src/client/ui/commandCatalog.js'

/** 造一条测试命令。 */
function cmd(id: string, label: string, category: string, order = 10): CommandDef {
  return { id, label, category, order, run: () => {} }
}

/** 内存 localStorage 替身（node 环境无 DOM）。 */
class MemoryStorage {
  private map = new Map<string, string>()
  get length(): number {
    return this.map.size
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
  clear(): void {
    this.map.clear()
  }
}

const holder = globalThis as { localStorage?: unknown }

beforeEach(() => {
  holder.localStorage = new MemoryStorage()
  clearRecentCommands()
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete holder.localStorage
})

describe('fuzzyScore 模糊评分', () => {
  const fields = { label: 'Save File', id: 'cstudio.save', category: 'File' }

  it('空查询返回 0（中性分，不构成命中约束）', () => {
    expect(fuzzyScore(fields, '')).toBe(0)
    expect(fuzzyScore(fields, '   ')).toBe(0)
  })

  it('未命中返回 null', () => {
    expect(fuzzyScore(fields, 'zzzzz')).toBeNull()
  })

  it('连续匹配 > 子序列匹配', () => {
    const continuous = fuzzyScore(fields, 'save') ?? 0
    const scattered = fuzzyScore(fields, 'sf') ?? 0
    expect(continuous).toBeGreaterThan(scattered)
  })

  it('完整前缀匹配 > 完整子串匹配', () => {
    const prefix = fuzzyScore(fields, 'sav') ?? 0
    const substring = fuzzyScore(fields, 'ave') ?? 0
    expect(prefix).toBeGreaterThan(substring)
  })

  it('匹配位置越靠前分数越高', () => {
    const early = fuzzyScore({ label: 'abcdef', id: '', category: '' }, 'ab') ?? 0
    const late = fuzzyScore({ label: 'xxabcdef', id: '', category: '' }, 'ab') ?? 0
    expect(early).toBeGreaterThan(late)
  })

  it('词首匹配 > 泛子序列匹配', () => {
    const wordStart = fuzzyScore({ label: 'save file', id: '', category: '' }, 'sf') ?? 0
    const generic = fuzzyScore({ label: 'sxxfile', id: '', category: '' }, 'sf') ?? 0
    expect(wordStart).toBeGreaterThan(generic)
  })

  it('子序列命中（不必连续）', () => {
    expect(fuzzyScore({ label: 'Go To Definition', id: '', category: '' }, 'gtd')).not.toBeNull()
    expect(fuzzyScore({ label: 'Go To Definition', id: '', category: '' }, 'gdx')).toBeNull()
  })

  it('三个字段都可命中（label / id / category）', () => {
    expect(fuzzyScore({ label: 'a', id: 'b', category: 'c' }, 'a')).not.toBeNull()
    expect(fuzzyScore({ label: 'a', id: 'b', category: 'c' }, 'b')).not.toBeNull()
    expect(fuzzyScore({ label: 'a', id: 'b', category: 'c' }, 'c')).not.toBeNull()
  })

  it('多 token 必须全部命中（AND 语义）', () => {
    expect(fuzzyScore(fields, 'save file')).not.toBeNull()
    expect(fuzzyScore(fields, 'save zzz')).toBeNull()
  })

  it('大小写不敏感', () => {
    expect(fuzzyScore(fields, 'SAVE')).toBe(fuzzyScore(fields, 'save'))
  })
})

describe('filterCommands 行为契约（既有单测依赖，不得破坏）', () => {
  const list = [
    cmd('x.save', '保存文件', '文件', 10),
    cmd('x.goToDefinition', '转到定义', '语言智能', 10),
    cmd('x.searchInFiles', '在工作区中搜索', '视图', 20),
  ]

  it('签名与返回类型不变（CommandDef[]）', () => {
    const out: CommandDef[] = filterCommands(list, '保存')
    expect(Array.isArray(out)).toBe(true)
    expect(out[0]).toBe(list[0])
  })

  it('空查询返回全部（按目录序稳定）', () => {
    expect(filterCommands(list, '').map((item) => item.id))
      .toEqual(['x.save', 'x.goToDefinition', 'x.searchInFiles'])
  })

  it('中文子串与大小写不敏感', () => {
    expect(filterCommands(list, '保存').map((item) => item.id)).toEqual(['x.save'])
    expect(filterCommands(list, 'GOTODEF').map((item) => item.id)).toEqual(['x.goToDefinition'])
    expect(filterCommands(list, 'x.save').map((item) => item.id)).toEqual(['x.save'])
  })

  it('分类名可命中', () => {
    expect(filterCommands(list, '视图').map((item) => item.id)).toEqual(['x.searchInFiles'])
  })

  it('多 token 需全部命中（AND 语义）', () => {
    expect(filterCommands(list, '搜索 工作区').map((item) => item.id)).toEqual(['x.searchInFiles'])
    expect(filterCommands(list, '搜索 保存')).toEqual([])
  })

  it('label 命中优先于 id/category 命中', () => {
    const mixed = [
      cmd('x.alpha', '无关命令', '保存组', 1),
      cmd('x.beta', '保存文件', '无关组', 50),
    ]
    expect(filterCommands(mixed, '保存').map((item) => item.id)).toEqual(['x.beta', 'x.alpha'])
  })

  it('同权重按 order 再按注册序', () => {
    const same = [cmd('x.b', '同名', '组', 20), cmd('x.a', '同名', '组', 10)]
    expect(filterCommands(same, '同名').map((item) => item.id)).toEqual(['x.a', 'x.b'])
  })

  it('无匹配返回空数组', () => {
    expect(filterCommands(list, '不存在的命令')).toEqual([])
  })

  it('新增：模糊子序列可命中（原先只做子串）', () => {
    const fuzzy = [cmd('x.goto', 'Go To Definition', '语言智能', 10)]
    expect(filterCommands(fuzzy, 'gtd').map((item) => item.id)).toEqual(['x.goto'])
  })
})

describe('rankCommands 最近使用加权', () => {
  const list = [
    cmd('x.a', 'Alpha', '组一', 10),
    cmd('x.b', 'Beta', '组二', 10),
    cmd('x.c', 'Gamma', '组一', 10),
  ]

  it('空查询保持目录序（最近使用不提升）', () => {
    expect(rankCommands(list, '', ['x.c']).map((item) => item.id)).toEqual(['x.a', 'x.b', 'x.c'])
  })

  it('有查询词时最近使用过的命令置顶', () => {
    const ranked = rankCommands(list, 'a', ['x.c']).map((item) => item.id)
    expect(ranked[0]).toBe('x.c')
  })

  it('最近使用之间按最近先后排序', () => {
    const ranked = rankCommands(list, 'a', ['x.b', 'x.c']).map((item) => item.id)
    expect(ranked[0]).toBe('x.b')
    expect(ranked[1]).toBe('x.c')
  })

  it('未进入最近列表的命令仍按评分排序', () => {
    // 'a' 在 "Alpha"（index 0）> "Gamma"（index 1）> "Beta"（index 3）：位置越靠前分越高
    const ranked = rankCommands(list, 'a', ['x.zzz']).map((item) => item.id)
    expect(ranked).toEqual(['x.a', 'x.c', 'x.b'])
  })
})

describe('groupCommands 分组', () => {
  const list = [
    cmd('x.a', 'Alpha', '组一', 10),
    cmd('x.b', 'Beta', '组二', 10),
    cmd('x.c', 'Gamma', '组一', 20),
  ]

  it('按 category 分组，组内保持排序', () => {
    const groups = groupCommands(list, '')
    expect(groups.map((group) => group.category)).toEqual(['组一', '组二'])
    expect(groups[0].commands.map((item) => item.id)).toEqual(['x.a', 'x.c'])
    expect(groups[1].commands.map((item) => item.id)).toEqual(['x.b'])
  })

  it('有查询词时同样分组（组序 = 组内最佳命中项的排序）', () => {
    const groups = groupCommands(list, 'gamma')
    expect(groups.length).toBe(1)
    expect(groups[0].category).toBe('组一')
    expect(groups[0].commands.map((item) => item.id)).toEqual(['x.c'])
  })

  it('分组不改变命中集合（与 filterCommands 一致）', () => {
    const groups = groupCommands(list, 'a')
    const flat = groups.flatMap((group) => group.commands.map((item) => item.id))
    expect(flat.sort()).toEqual(filterCommands(list, 'a').map((item) => item.id).sort())
  })
})

describe('commandRecents 最近使用记录', () => {
  it('记录后按最近在前返回', () => {
    recordCommandUse('x.a')
    recordCommandUse('x.b')
    expect(recentCommandIds()).toEqual(['x.b', 'x.a'])
  })

  it('重复使用同一命令会置顶且不重复', () => {
    recordCommandUse('x.a')
    recordCommandUse('x.b')
    recordCommandUse('x.a')
    expect(recentCommandIds()).toEqual(['x.a', 'x.b'])
  })

  it('容量上限 30 条（超出逐出最旧）', () => {
    for (let index = 0; index < RECENT_COMMANDS_CAP + 5; index += 1) recordCommandUse('x.' + index)
    const ids = recentCommandIds()
    expect(ids.length).toBe(RECENT_COMMANDS_CAP)
    expect(ids[0]).toBe('x.' + (RECENT_COMMANDS_CAP + 4))
    expect(ids.includes('x.0')).toBe(false)
  })

  it('清空后为空', () => {
    recordCommandUse('x.a')
    clearRecentCommands()
    expect(recentCommandIds()).toEqual([])
  })

  it('空 id 忽略', () => {
    recordCommandUse('')
    expect(recentCommandIds()).toEqual([])
  })

  it('存储不可用时静默降级（不抛错）', () => {
    delete holder.localStorage
    expect(() => recordCommandUse('x.a')).not.toThrow()
    expect(() => recentCommandIds()).not.toThrow()
    expect(() => clearRecentCommands()).not.toThrow()
  })

  it('持久化到 localStorage（键取自 paths.CACHE_KEY）', () => {
    recordCommandUse('x.a')
    const raw = (holder.localStorage as MemoryStorage).getItem(CACHE_KEY.commandRecents)
    expect(raw).toBeTruthy()
    expect(raw).toContain('x.a')
  })
})

describe('commandRecents 存档纯函数', () => {
  it('serialize / parse 往返', () => {
    const text = serializeRecentCommands([{ id: 'x.a', ts: 10 }, { id: 'x.b', ts: 20 }])
    expect(parseRecentCommands(text)).toEqual([{ id: 'x.b', ts: 20 }, { id: 'x.a', ts: 10 }])
  })

  it('空表序列化为空串（调用方据此删键）', () => {
    expect(serializeRecentCommands([])).toBe('')
  })

  it('损坏文本 / 版本不符 → null', () => {
    expect(parseRecentCommands('{oops')).toBeNull()
    expect(parseRecentCommands(JSON.stringify({ v: 999, entries: [] }))).toBeNull()
    expect(parseRecentCommands(null)).toBeNull()
  })

  it('归一化：丢弃无 id 项、去重（保留最新一条）、按时间倒序、截断到上限', () => {
    const cleaned = cleanRecentEntries([
      { id: 'x.a', ts: 1 },
      { id: '', ts: 2 },
      { id: 'x.a', ts: 9 },
      { id: 'x.b', ts: 5 },
      null,
      'nope',
    ])
    expect(cleaned).toEqual([{ id: 'x.a', ts: 9 }, { id: 'x.b', ts: 5 }])
    expect(cleanRecentEntries('not-array')).toEqual([])
  })
})

describe('CommandPalette 浮层契约（渲染形态）', () => {
  const source = readFileSync(new URL('../src/client/ui/CommandPalette.ts', import.meta.url), 'utf8')

  it('按 category 分组渲染（新增 edrv-palette-group / edrv-palette-group-title 类名）', () => {
    expect(source).toContain("'edrv-palette-group'")
    expect(source).toContain("'edrv-palette-group-title'")
  })

  it('既有类名全部保留（不得重命名）', () => {
    for (const className of [
      'edrv-palette-row', 'edrv-palette-sel', 'edrv-palette-label', 'edrv-palette-cat',
      'edrv-palette-key', 'edrv-palette-empty', 'edrv-palette-list', 'edrv-palette-input',
      'edrv-palette', 'edrv-palette-mask', 'edrv-palette-notice',
    ]) {
      expect(source, className).toContain(className)
    }
  })

  it('执行命令时登记最近使用', () => {
    expect(source).toContain('recordCommandUse(')
    expect(source).toMatch(/const execute = \(row: PaletteRow \| undefined\): void => \{[\s\S]*?recordCommandUse\(row\.command\.id\)/)
  })

  it('最近使用仅在有查询词时参与排序（空查询保持目录序）', () => {
    expect(source).toMatch(/query\.trim\(\) \? recentCommandIds\(\) : \[\]/)
  })

  it('使用 React.createElement（项目不用 JSX）', () => {
    expect(source).toContain('React.createElement')
    // 用 TS AST 精确判定有无 JSX 节点（正则会误伤泛型写法，如 React.KeyboardEvent<HTMLDivElement>）
    const file = ts.createSourceFile('CommandPalette.tsx', source, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TSX)
    let jsxCount = 0
    const visit = (node: ts.Node): void => {
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) jsxCount += 1
      ts.forEachChild(node, visit)
    }
    visit(file)
    expect(jsxCount).toBe(0)
  })
})
