/** 字体偏好：空值 / 0 跟随宿主，不下载或注入外部字体。 */
export interface Typography {
  editorFontFamily: string
  editorFontSize: number
  editorLineHeight: number
  uiFontFamily: string
  uiFontSize: number
}

export const TYPOGRAPHY_DEFAULTS: Typography = {
  editorFontFamily: '', editorFontSize: 0, editorLineHeight: 0, uiFontFamily: '', uiFontSize: 0,
}

export function fontSizeOf(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) return 0
  return Math.max(min, Math.min(max, Math.round(value)))
}

function familyOf(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 240) : ''
}

export function typographyOf(value: Partial<Record<keyof Typography, unknown>> = {}): Typography {
  return {
    editorFontFamily: familyOf(value.editorFontFamily),
    editorFontSize: fontSizeOf(value.editorFontSize, 12, 32),
    editorLineHeight: fontSizeOf(value.editorLineHeight, 12, 80),
    uiFontFamily: familyOf(value.uiFontFamily),
    uiFontSize: fontSizeOf(value.uiFontSize, 11, 24),
  }
}
