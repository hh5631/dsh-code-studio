import React from 'react'
import type { SettingsBridge, SettingsScopeLike } from '../compat.js'
import { TYPOGRAPHY_DEFAULTS, typographyOf, type Typography } from '../../shared/typography.js'
import { applyTypography } from '../typography.js'
import '../styles/minimal.css'

const FONTS = ['SF Mono', 'Menlo', 'Monaco', 'JetBrains Mono', 'Fira Code', 'PingFang SC', 'Kaiti SC', 'Microsoft YaHei', 'system-ui']
const emptySnapshot: ReturnType<SettingsScopeLike['getSnapshot']> = { status: 'loading', writable: false }
/** 实时预览去抖：连打数字时只把最后一次写进 CSS 变量，避免每次按键都触发编辑器主题重配。 */
const PREVIEW_DEBOUNCE_MS = 120

function FontField({ field, label, value, scope, disabled, report, preview }: {
  field: keyof Typography; label: string; value: string | number; scope?: SettingsScopeLike
  disabled: boolean; report: (message: string) => void
  /** 输入过程中的即时预览；传 null 表示回到已保存值（清空输入/失焦失败时）。 */
  preview?: (field: keyof Typography, raw: string | null) => void
}): React.ReactElement {
  const lineHeight = field === 'editorLineHeight'
  const number = field.endsWith('Size') || lineHeight
  const min = field === 'uiFontSize' ? 11 : 12, max = lineHeight ? 80 : field === 'editorFontSize' ? 32 : 24
  const [draft, setDraft] = React.useState(value === 0 ? '' : String(value))
  const focused = React.useRef(false)
  const dirty = React.useRef(false)
  const [saving, setSaving] = React.useState(false)
  const busy = React.useRef(false)
  const id = React.useId(), fonts = React.useId()
  React.useEffect(() => {
    if (!focused.current && !dirty.current) setDraft(value === 0 ? '' : String(value))
  }, [value])
  const save = async () => {
    if (!scope || !dirty.current || busy.current) return
    const raw = number ? (draft.trim() ? Number(draft) : 0) : draft.trim()
    if (number && (typeof raw !== 'number' || !Number.isFinite(raw) || (raw !== 0 && (raw < min || raw > max || !Number.isInteger(raw))))) {
      report(`请输入 ${min}–${max} 的整数${lineHeight ? '行高，留空自动计算' : '字号，留空跟随 DSH'}`); return
    }
    busy.current = true; setSaving(true)
    try {
      await scope.set(field, raw)
      dirty.current = false
      setDraft(raw === 0 ? '' : String(raw))
      report('已保存，立即生效')
    } catch { report('保存失败，请重试'); }
    finally { busy.current = false; setSaving(false) }
  }
  return React.createElement('div', { className: 'cstudio-setting-row' },
    React.createElement('label', { htmlFor: id }, label),
    React.createElement('div', { className: 'cstudio-setting-input' },
      React.createElement('input', {
        id, type: number ? 'number' : 'text', value: draft, disabled: disabled || saving,
        ...(number ? { min, max, step: 1 } : { list: fonts, maxLength: 240 }),
        placeholder: lineHeight ? '自动（字号 × 1.5）' : number ? '跟随 DSH' : '跟随 DSH / 系统字体',
        onFocus: () => { focused.current = true },
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
          dirty.current = true; setDraft(event.target.value); report('')
          // 输入即预览：只改插件私有 CSS 变量，不写设置、不重建设置页。
          preview?.(field, event.target.value)
        },
        onBlur: () => {
          focused.current = false
          preview?.(field, null)
          void save()
        },
        onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.currentTarget.blur() },
      }),
      number ? React.createElement('span', { 'aria-hidden': true }, 'px') : React.createElement('datalist', { id: fonts }, FONTS.map(font => React.createElement('option', { key: font, value: font }))))
  )
}

/** 复用 DSH 设置桥的持久化与 revision 检查。 */
export function EditorSettings({ bridge }: { bridge: SettingsBridge }): React.ReactElement {
  const [scope, setScope] = React.useState(() => bridge.scope())
  React.useEffect(() => bridge.whenReady(() => setScope(bridge.scope())), [bridge])
  // 旧设置桥会为每次 getSnapshot 创建包装对象，不能直接用于 useSyncExternalStore。
  const [snapshot, setSnapshot] = React.useState(() => scope?.getSnapshot() ?? emptySnapshot)
  React.useEffect(() => {
    const sync = () => setSnapshot(scope?.getSnapshot() ?? emptySnapshot)
    sync()
    return scope?.subscribe(sync)
  }, [scope])
  const [message, report] = React.useState('')
  const saved = typographyOf(snapshot.value ?? TYPOGRAPHY_DEFAULTS)
  const value = saved
  const disabled = !scope || snapshot.status === 'loading' || snapshot.status === 'unavailable' || snapshot.writable === false

  // 预览用最新已保存值兜底：未改动的字段始终回到磁盘值，避免把草稿残留带进真实样式。
  const savedRef = React.useRef(saved)
  savedRef.current = saved
  /** 未保存的草稿值（数字字段存 number，字体存 string）。 */
  const drafts = React.useRef<Partial<Record<keyof Typography, string | number>>>({})
  const previewTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const flushPreview = React.useCallback(() => {
    if (previewTimer.current !== null) { clearTimeout(previewTimer.current); previewTimer.current = null }
    const overrides = drafts.current
    if (!Object.keys(overrides).length) return
    // 未改动的字段沿用已保存值，避免把其它草稿的残值带进真实样式。
    applyTypography({ ...savedRef.current, ...overrides })
  }, [])
  const preview = React.useCallback((field: keyof Typography, raw: string | null) => {
    if (raw === null) delete drafts.current[field]
    else if (field.endsWith('Size') || field === 'editorLineHeight') {
      // 数字字段必须转成数字：typographyOf 会把字符串当成「跟随宿主」而丢掉预览。
      const parsed = raw.trim() ? Number(raw) : NaN
      if (!Number.isFinite(parsed) || parsed <= 0) delete drafts.current[field]
      else drafts.current[field] = parsed
    } else drafts.current[field] = raw
    if (previewTimer.current !== null) clearTimeout(previewTimer.current)
    previewTimer.current = setTimeout(() => { previewTimer.current = null; flushPreview() }, PREVIEW_DEBOUNCE_MS)
  }, [flushPreview])
  // 离开设置页时把样式还原为已保存值，防止预览值残留在其它界面上。
  React.useEffect(() => () => {
    if (previewTimer.current !== null) { clearTimeout(previewTimer.current); previewTimer.current = null }
    drafts.current = {}
    applyTypography(savedRef.current)
  }, [])

  const section = (title: string, fields: Array<[keyof Typography, string]>) => React.createElement('fieldset', null,
    React.createElement('legend', null, title),
    fields.map(([field, label]) => React.createElement(FontField, { key: field, field, label, value: value[field], scope, disabled, report, preview })))
  return React.createElement('section', { className: 'cstudio-settings' },
    React.createElement('h2', null, '文件编辑'),
    React.createElement('p', { className: 'cstudio-settings-intro' }, '从 DSH 工作区文件打开，编辑代码和 Markdown。'),
    section('编辑器', [['editorFontFamily', '编辑器字体'], ['editorFontSize', '编辑器字号'], ['editorLineHeight', '编辑器行高']]),
    section('插件界面', [['uiFontFamily', '界面字体'], ['uiFontSize', '界面字号']]),
    React.createElement('p', { className: 'cstudio-settings-hint' }, '修改后离开输入框即可保存；输入过程中会先实时预览。留空恢复默认；字体须已安装在当前设备。'),
    React.createElement('p', { role: 'status', className: 'cstudio-settings-result' }, disabled ? '设置服务暂不可用' : message))
}
