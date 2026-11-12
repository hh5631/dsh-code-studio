import { getTypography } from './typography.js'

export function detectColorScheme() {
  try {
    const official = document.body?.getAttribute?.('data-ds-dark-theme')
    if (official !== null && official !== undefined && official !== 'false') return 'dark'
    const attr = document.documentElement?.getAttribute?.('data-theme')
      ?? document.body?.getAttribute?.('data-theme')
    const value = String(attr ?? '').toLowerCase()
    if (value.includes('light') || value.includes('catppuccin-latte')) return 'light'
    if (value.includes('dark') || value.includes('frappe') || value.includes('macchiato') || value.includes('mocha')) return 'dark'
    if (typeof window.matchMedia === 'function') {
      return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
    }
  } catch (error) {
    /* 探测失败回落暗色 */
  }
  return 'dark'
}

export function editorFont(): { fontSize: number; lineHeight: number; fontFamily: string } {
  const preference = getTypography()
  const raw = readCssVar('--dsh-content-font-size') ?? ''
  const parsed = /^\d+(?:\.\d+)?px$/i.test(raw) ? Number(raw.slice(0, -2)) : NaN
  const fontSize = preference.editorFontSize || (Number.isFinite(parsed) && parsed > 0 ? parsed : 16)
  const fontFamily = preference.editorFontFamily || readCssVar('--dsh-font-family-code') || readCssVar('--dsw-font-family-code') || 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
  return { fontSize, lineHeight: preference.editorLineHeight || Math.round(fontSize * 1.5), fontFamily }
}

export function readCssVar(name: string) {
  try {
    if (typeof window?.getComputedStyle !== 'function') return undefined
    const hosts = [document?.body, document?.documentElement]
    for (const host of hosts) {
      if (!host) continue
      const raw = window.getComputedStyle(host).getPropertyValue(name)
      const value = String(raw ?? '').trim()
      if (value && !value.startsWith('var(')) return value
    }
    return undefined
  } catch (error) {
    return undefined
  }
}

export function observeScheme(onChange: () => void) {
  try {
    if (typeof MutationObserver !== 'function' || !document?.body) return () => {}
    const observer = new MutationObserver(() => onChange())
    const filter = ['data-ds-dark-theme', 'data-theme']
    observer.observe(document.body, { attributes: true, attributeFilter: filter })
    if (document.documentElement) {
      observer.observe(document.documentElement, { attributes: true, attributeFilter: filter })
    }
    return () => observer.disconnect()
  } catch (error) {
    return () => {}
  }
}

export function schemeOfSnapshot(snapshot: unknown) {
  const value = snapshot as { active?: { colorScheme?: unknown }; colorScheme?: unknown } | null | undefined
  const scheme = value?.active?.colorScheme ?? value?.colorScheme
  return scheme === 'light' || scheme === 'dark' ? scheme : undefined
}
