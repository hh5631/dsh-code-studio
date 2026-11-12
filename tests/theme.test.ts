import { afterEach, describe, expect, it, vi } from 'vitest'
import { editorFont, observeScheme, readCssVar, schemeOfSnapshot } from '../src/client/editorTheme.js'

afterEach(() => vi.unstubAllGlobals())
describe('editor host font', () => {
  it.each([['14px', 14, 21], ['16px', 16, 24], ['18px', 18, 27], [' 14.5px ', 14.5, 22], ['', 16, 24], ['0px', 16, 24], ['-2px', 16, 24], ['Infinitypx', 16, 24], ['14rem', 16, 24], ['14pxjunk', 16, 24]])('parses %s safely', (raw, fontSize, lineHeight) => {
    vi.stubGlobal('document', { body: {}, documentElement: {} })
    vi.stubGlobal('window', { getComputedStyle: () => ({ getPropertyValue: (name: string) => name === '--dsh-content-font-size' ? raw : '' }) })
    expect(editorFont()).toMatchObject({ fontSize, lineHeight })
  })
  it('uses readable defaults without DOM', () => {
    expect(editorFont()).toMatchObject({ fontSize: 16, lineHeight: 24 })
  })
})

describe('schemeOfSnapshot', () => {
  it('读 active.colorScheme 与顶层 colorScheme', () => {
    expect(schemeOfSnapshot({ active: { colorScheme: 'dark' } })).toBe('dark')
    expect(schemeOfSnapshot({ colorScheme: 'light' })).toBe('light')
  })
  it('缺失/未知取值返回 undefined', () => {
    expect(schemeOfSnapshot(undefined)).toBeUndefined()
    expect(schemeOfSnapshot({})).toBeUndefined()
    expect(schemeOfSnapshot({ active: { colorScheme: 'system' } })).toBeUndefined()
  })
})

describe('readCssVar / observeScheme（非浏览器环境安全降级）', () => {
  it('readCssVar 无 document 时返回 undefined 且不抛错', () => {
    expect(readCssVar('--dsw-alias-label-primary')).toBeUndefined()
  })
  it('observeScheme 返回可调用的停止函数', () => {
    const stop = observeScheme(() => {})
    expect(typeof stop).toBe('function')
    expect(() => stop()).not.toThrow()
  })
})
