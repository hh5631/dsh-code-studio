import { TYPOGRAPHY_DEFAULTS, typographyOf, type Typography } from '../shared/typography.js'

export const TYPOGRAPHY_EVENT = 'cstudio:typography'
let current = { ...TYPOGRAPHY_DEFAULTS }
export const getTypography = (): Typography => current

export function applyTypography(value: Partial<Record<keyof Typography, unknown>> = {}): void {
  const next = typographyOf(value)
  if (typeof document !== 'undefined') {
    // 仅插件选择器使用这些私有变量，不改动 DSH、聊天或其他插件字体。
    const style = document.documentElement.style
    for (const [key, setting] of Object.entries({
      '--cstudio-ui-font': next.uiFontFamily,
      '--cstudio-ui-size': next.uiFontSize ? next.uiFontSize + 'px' : '',
      '--cstudio-code-font': next.editorFontFamily,
      '--cstudio-code-size': next.editorFontSize ? next.editorFontSize + 'px' : '',
    })) {
      if (setting) style.setProperty(key, setting)
      else style.removeProperty(key)
    }
  }
  if (Object.keys(next).every(key => next[key as keyof Typography] === current[key as keyof Typography])) return
  current = next
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(TYPOGRAPHY_EVENT))
}
