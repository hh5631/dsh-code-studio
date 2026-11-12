import React from 'react'
import { afterPaint } from '../afterPaint.js'
import type { Props } from './EditorView.js'

interface EditorModule { EditorView: React.ComponentType<Props> }
type Importer = (file: string) => Promise<unknown>
let importer: Importer | undefined
let pending: Promise<EditorModule> | undefined
let ready: EditorModule | undefined
export function setEditorImport(next?: Importer): void { importer = next }
export function disposeEditorRuntime(): void { ready = undefined; pending = undefined }

function load(): Promise<EditorModule> {
  if (ready) return Promise.resolve(ready)
  if (pending) return pending
  const transport = importer
  if (!transport) return Promise.reject(new Error('当前 DSH 不支持按需加载编辑器模块'))
  const task = Promise.resolve().then(() => transport('./client.editor.js')).then(value => {
    const editor = value as EditorModule
    if (typeof editor?.EditorView !== 'function') throw new Error('编辑器模块不完整')
    if (pending === task) ready = editor
    return editor
  }).finally(() => { if (pending === task) pending = undefined })
  pending = task
  return task
}

export function LazyEditorView(props: Props): React.ReactElement | null {
  const [editor, setEditor] = React.useState(() => ready)
  const [error, setError] = React.useState('')
  const [attempt, retry] = React.useReducer(value => value + 1, 0)
  const visible = props.visible !== false
  React.useEffect(() => {
    if (editor || !visible) return
    let active = true
    const cancel = afterPaint(() => { void load().then(value => { if (active) setEditor(value) },
      cause => { if (active) setError(String(cause)) }) })
    return () => { active = false; cancel() }
  }, [editor, visible, attempt])
  if (editor) return React.createElement(editor.EditorView, props)
  if (!visible) return null
  return React.createElement('div', { className: 'cstudio-editor-start', role: error ? 'alert' : 'status' },
    error || '正在打开编辑器…', error && React.createElement('button', { type: 'button', onClick: () => { setError(''); retry() } }, '重试'))
}
