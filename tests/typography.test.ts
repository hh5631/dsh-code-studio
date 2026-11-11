import { afterEach, describe, expect, it, vi } from 'vitest'
import { typographyOf, TYPOGRAPHY_DEFAULTS } from '../src/shared/typography.js'
import { applyTypography, getTypography } from '../src/client/typography.js'
import { editorFont } from '../src/client/monaco/theme.js'

afterEach(() => { applyTypography(); vi.unstubAllGlobals() })

describe('字体设置与运行态编辑器', () => {
  it('旧配置没有字体字段时保持跟随宿主，不生成无效字号', () => {
    expect(typographyOf()).toEqual(TYPOGRAPHY_DEFAULTS)
    expect(typographyOf({ editorFontSize: NaN, uiFontSize: Infinity })).toEqual(TYPOGRAPHY_DEFAULTS)
  })
  it('配置文件直接写入极端字号时限制范围，字体名支持中文及字体回退列表', () => {
    expect(typographyOf({ editorFontSize: 1000, uiFontSize: -1, editorFontFamily: '  SF Mono, 苹方  ' })).toMatchObject({
      editorFontSize: 32, uiFontSize: 11, editorFontFamily: 'SF Mono, 苹方',
    })
  })
  it('设置更新立即改变 Monaco 选项，界面字体不会串到代码字体', () => {
    applyTypography({ editorFontSize: 20, editorFontFamily: 'Menlo', uiFontFamily: 'Kaiti SC', uiFontSize: 18 })
    expect(editorFont()).toEqual({ fontSize: 20, lineHeight: 30, fontFamily: 'Menlo' })
    applyTypography({ uiFontFamily: 'Kaiti SC', uiFontSize: 18 })
    expect(editorFont().fontSize).toBe(16)
    expect(editorFont().fontFamily).not.toContain('Kaiti SC')
  })
  it('仅写插件私有变量，清空偏好可恢复宿主样式', () => {
    const values = new Map<string, string>()
    vi.stubGlobal('document', { documentElement: { style: {
      setProperty: (key: string, value: string) => values.set(key, value),
      removeProperty: (key: string) => values.delete(key),
    } } })
    applyTypography({ uiFontFamily: 'PingFang SC', uiFontSize: 18 })
    expect(values.get('--cstudio-ui-font')).toBe('PingFang SC')
    expect(values.get('--cstudio-ui-size')).toBe('18px')
    expect([...values.keys()].every(key => key.startsWith('--cstudio-'))).toBe(true)
    applyTypography()
    expect(values.size).toBe(0)
    expect(getTypography()).toEqual(TYPOGRAPHY_DEFAULTS)
  })
  it('行高独立于字号，清空恢复自动行高，异常值受到范围限制', () => {
    applyTypography({ editorFontSize: 20, editorLineHeight: 36 })
    expect(editorFont().lineHeight).toBe(36)
    applyTypography({ editorFontSize: 20, editorLineHeight: 0 })
    expect(editorFont().lineHeight).toBe(30)
    expect(typographyOf({ editorLineHeight: NaN }).editorLineHeight).toBe(0)
    expect(typographyOf({ editorLineHeight: 1000 }).editorLineHeight).toBe(80)
    expect(typographyOf({ editorLineHeight: 1 }).editorLineHeight).toBe(12)
  })
})
