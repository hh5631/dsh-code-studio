/** Statusbar info probes and tab overflow arrows. @author ddj 2026年11月10号 */
import { describe, expect, it } from 'vitest'
import { byteLength, detectEncoding, detectEol, formatBytes, languageLabel } from '../src/client/statusInfo.js'
import { arrowVisibility, isMiddleClose, scrollTarget } from '../src/client/ui/tabScroll.js'

describe('detectEncoding', () => {
  it('reports plain UTF-8 for legal content', () => {
    expect(detectEncoding('hello 世界').label).toBe('UTF-8')
  })
  it('detects a UTF-8 BOM at the head', () => {
    expect(detectEncoding('\uFEFFabc').label).toBe('UTF-8 BOM')
  })
  it('reports GBK for a file that is not legal UTF-8', () => {
    expect(detectEncoding('中文\uFFFD').label).toBe('GBK')
  })
  it('reports UTF-16 when replacement characters dominate', () => {
    expect(detectEncoding('\uFFFD'.repeat(50)).label).toBe('UTF-16')
    expect(detectEncoding('\uFFFD'.repeat(50) + 'abc').label).toBe('UTF-16')
  })
  it('reports UTF-16 when NUL bytes are present', () => {
    expect(detectEncoding('a\u0000b').label).toBe('UTF-16')
  })
  it('never throws on empty or invalid input', () => {
    expect(detectEncoding('').label).toBe('UTF-8')
    expect(detectEncoding(undefined as unknown as string).label).toBe('UTF-8')
  })
})

describe('detectEol', () => {
  it.each([
    ['a\nb', 'LF'],
    ['a\r\nb', 'CRLF'],
    ['a\rb', 'CR'],
    ['', 'LF'],
    ['no newline', 'LF'],
  ])('reports %j as %s', (text, expected) => {
    expect(detectEol(text).label).toBe(expected)
  })
  it('picks the dominant terminator', () => {
    expect(detectEol('a\r\nb\r\nc\n').label).toBe('CRLF')
  })
})

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [512, '512 B'],
    [1024, '1.0 KB'],
    [12_288, '12.0 KB'],
    [1024 * 1024, '1.0 MB'],
  ])('formats %i bytes as %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected)
  })
  it('returns an empty string for invalid input', () => {
    expect(formatBytes(-1)).toBe('')
    expect(formatBytes(Number.NaN)).toBe('')
  })
})

describe('byteLength', () => {
  it('counts UTF-8 bytes rather than code units', () => {
    expect(byteLength('abc')).toBe(3)
    expect(byteLength('中')).toBe(3)
    expect(byteLength('')).toBe(0)
  })
})

describe('languageLabel', () => {
  it('maps known language ids to readable names', () => {
    expect(languageLabel('typescript')).toBe('TypeScript')
    expect(languageLabel('csharp')).toBe('C#')
  })
  it('falls back to the raw id for unknown languages', () => {
    expect(languageLabel('brainfuck')).toBe('brainfuck')
    expect(languageLabel('')).toBe('')
  })
})

describe('arrowVisibility', () => {
  it('hides both arrows when the strip does not overflow', () => {
    expect(arrowVisibility({ scrollWidth: 300, clientWidth: 300, scrollLeft: 0 })).toEqual({ left: false, right: false })
  })
  it('shows only the right arrow at the left edge of an overflowing strip', () => {
    expect(arrowVisibility({ scrollWidth: 900, clientWidth: 300, scrollLeft: 0 })).toEqual({ left: false, right: true })
  })
  it('shows only the left arrow at the right edge of an overflowing strip', () => {
    expect(arrowVisibility({ scrollWidth: 900, clientWidth: 300, scrollLeft: 600 })).toEqual({ left: true, right: false })
  })
  it('shows both arrows in the middle of an overflowing strip', () => {
    expect(arrowVisibility({ scrollWidth: 900, clientWidth: 300, scrollLeft: 300 })).toEqual({ left: true, right: true })
  })
  it('ignores a sub-pixel overflow', () => {
    expect(arrowVisibility({ scrollWidth: 300.5, clientWidth: 300, scrollLeft: 0 })).toEqual({ left: false, right: false })
  })
})

describe('scrollTarget', () => {
  it('scrolls right by the requested step', () => {
    expect(scrollTarget({ scrollWidth: 900, clientWidth: 300, scrollLeft: 100 }, 1, 160)).toBe(260)
  })
  it('scrolls left by the requested step', () => {
    expect(scrollTarget({ scrollWidth: 900, clientWidth: 300, scrollLeft: 100 }, -1, 160)).toBe(0)
  })
  it('clamps at both ends of the scroll range', () => {
    expect(scrollTarget({ scrollWidth: 900, clientWidth: 300, scrollLeft: 500 }, 1, 160)).toBe(600)
    expect(scrollTarget({ scrollWidth: 900, clientWidth: 300, scrollLeft: 10 }, -1, 160)).toBe(0)
  })
})

describe('isMiddleClose', () => {
  it('accepts a middle-button mouseup', () => {
    expect(isMiddleClose(1, 'mouseup')).toBe(true)
  })
  it('rejects primary, secondary and non-mouseup events', () => {
    expect(isMiddleClose(0, 'mouseup')).toBe(false)
    expect(isMiddleClose(2, 'mouseup')).toBe(false)
    expect(isMiddleClose(1, 'mousedown')).toBe(false)
  })
})
