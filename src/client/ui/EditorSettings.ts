import React from 'react'
import type { SettingsBridge, SettingsScopeLike } from '../compat.js'
import { TYPOGRAPHY_DEFAULTS, typographyOf, type Typography } from '../../shared/typography.js'
import '../styles/minimal.css'

const FONTS = ['SF Mono', 'Menlo', 'Monaco', 'JetBrains Mono', 'Fira Code', 'PingFang SC', 'Kaiti SC', 'Microsoft YaHei', 'system-ui']
const emptySnapshot: ReturnType<SettingsScopeLike['getSnapshot']> = { status: 'loading', writable: false }

function FontField({ field, label, value, scope, disabled, report }: {
  field: keyof Typography; label: string; value: string | number; scope?: SettingsScopeLike
  disabled: boolean; report: (message: string) => void
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
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => { dirty.current = true; setDraft(event.target.value); report('') },
        onBlur: () => { focused.current = false; void save() },
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
  const value = typographyOf(snapshot.value ?? TYPOGRAPHY_DEFAULTS)
  const disabled = !scope || snapshot.status === 'loading' || snapshot.status === 'unavailable' || snapshot.writable === false
  const section = (title: string, fields: Array<[keyof Typography, string]>) => React.createElement('fieldset', null,
    React.createElement('legend', null, title),
    fields.map(([field, label]) => React.createElement(FontField, { key: field, field, label, value: value[field], scope, disabled, report })))
  return React.createElement('section', { className: 'cstudio-settings' },
    React.createElement('h2', null, '文件编辑'),
    React.createElement('p', { className: 'cstudio-settings-intro' }, '从 DSH 工作区文件打开，编辑代码和 Markdown。'),
    section('编辑器', [['editorFontFamily', '编辑器字体'], ['editorFontSize', '编辑器字号'], ['editorLineHeight', '编辑器行高']]),
    section('插件界面', [['uiFontFamily', '界面字体'], ['uiFontSize', '界面字号']]),
    React.createElement('p', { className: 'cstudio-settings-hint' }, '修改后离开输入框即可保存。留空恢复默认；字体须已安装在当前设备。'),
    React.createElement('p', { role: 'status', className: 'cstudio-settings-result' }, disabled ? '设置服务暂不可用' : message))
}
