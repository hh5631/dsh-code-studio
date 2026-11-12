import { pickedCompletion, snippet, type Completion, type CompletionSource } from '@codemirror/autocomplete'
import { Transaction, type EditorState, type Text } from '@codemirror/state'
import { EditorView, hoverTooltip, showPanel } from '@codemirror/view'
import type { EditorContext, EditorModel } from '../editorTypes.js'
import { targetOpenPath } from '../monaco/lsp/lspClient.js'
import { rpc } from '../rpc.js'
import type { LspCompletionItem, LspLocation, LspPosition } from '../../shared/lsp.js'

export function offsetAt(doc: Text, lineNumber: number, column: number): number {
  const line = doc.line(Math.max(1, Math.min(lineNumber, doc.lines)))
  return line.from + Math.max(0, Math.min(column - 1, line.length))
}

function positionAt(state: EditorState, offset: number): LspPosition {
  const line = state.doc.lineAt(offset)
  return { line: line.number - 1, character: offset - line.from }
}

function fromLsp(doc: Text, position: LspPosition): number {
  return offsetAt(doc, position.line + 1, position.character + 1)
}

function completionOf(item: LspCompletionItem): Completion {
  return {
    label: item.label,
    detail: item.detail,
    info: item.documentation,
    commitCharacters: item.commitCharacters,
    apply(view, completion, from, to) {
      const doc = view.state.doc
      const range = item.textEdit?.range ?? item.textEdit?.insert ?? item.textEdit?.replace
      const start = range ? fromLsp(doc, range.start) : from
      const end = range ? fromLsp(doc, range.end) : to
      const insert = item.textEdit?.newText ?? item.insertText ?? item.label
      if (item.insertTextFormat === 2 && !item.additionalTextEdits?.length) {
        snippet(insert)(view, completion, start, end)
        return
      }
      const changes = view.state.changes([
        { from: start, to: end, insert },
        ...(item.additionalTextEdits ?? []).map(edit => ({
          from: fromLsp(doc, edit.range.start), to: fromLsp(doc, edit.range.end), insert: edit.newText,
        })),
      ])
      view.dispatch({
        changes, selection: { anchor: changes.mapPos(end, 1) }, scrollIntoView: true,
        annotations: [pickedCompletion.of(completion), Transaction.userEvent.of('input.complete')],
      })
    },
  }
}

export function connectLsp(view: EditorView, model: EditorModel, path: string, sessionId: string, context: EditorContext) {
  const document = { sessionId, path }
  let closed = false
  let version = 0
  let pending = Promise.resolve(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastVersion = -1
  const sync = () => {
    clearTimeout(timer)
    if (closed) return Promise.resolve(false)
    const current = model.getVersionId()
    if (current === lastVersion) return pending
    lastVersion = current
    const text = model.getValue()
    pending = pending.then(async () => {
      if (closed) return false
      const result = await rpc('cstudio.lsp.sync', { ...document, text, version: ++version }).catch(() => null)
      if (!result?.ok && lastVersion === current) lastVersion = -1
      return result?.ok === true && !closed
    })
    return pending
  }
  const subscription = model.onDidChangeContent(() => {
    clearTimeout(timer)
    timer = setTimeout(() => { void sync() }, 350)
  })
  void sync()

  const complete: CompletionSource = async request => {
    const word = request.matchBefore(/[\p{L}\p{N}_]+/u)
    const character = request.state.sliceDoc(Math.max(0, request.pos - 1), request.pos)
    const trigger = !word && /[.:]/.test(character) ? character : undefined
    if (!word && !trigger && !request.explicit) return null
    request.addEventListener('abort', () => {}, { onDocChange: true })
    if (!await sync() || request.aborted) return null
    const result = await rpc('cstudio.lsp.completion', {
      ...document, position: positionAt(request.state, request.pos), prefix: word?.text,
      context: trigger ? { triggerKind: 2, triggerCharacter: trigger } : { triggerKind: 1 },
    }).catch(() => null)
    if (closed || request.aborted || !result?.ok || !result.completions?.items.length) return null
    return { from: word?.from ?? request.pos, options: result.completions.items.map(completionOf) }
  }

  const hover = hoverTooltip(async (editor, pos) => {
    const state = editor.state
    if (!await sync()) return null
    const result = await rpc('cstudio.lsp.hover', { ...document, position: positionAt(state, pos) }).catch(() => null)
    if (closed || editor.state.doc !== state.doc || !result?.ok || !result.hover?.contents.length) return null
    const hover = result.hover
    return {
      pos: hover.range ? fromLsp(state.doc, hover.range.start) : pos,
      end: hover.range ? fromLsp(state.doc, hover.range.end) : undefined,
      above: true,
      create() {
        const dom = editor.dom.ownerDocument.createElement('div')
        dom.className = 'cstudio-cm-hover'
        dom.textContent = hover.contents.join('\n\n')
        return { dom }
      },
    }
  })

  function open(location: LspLocation) {
    const target = targetOpenPath(location)
    if (target) context.open(target, location.range.start.line + 1, location.range.start.character + 1)
  }

  async function navigate(references: boolean, setPanel: (panel: ReturnType<typeof showPanel.of> | []) => void, offset = view.state.selection.main.head) {
    const state = view.state
    if (!await sync()) {
      if (!closed) context.notify('语言服务暂不可用')
      return
    }
    const args = { ...document, position: positionAt(state, offset) }
    const result = await rpc(references ? 'cstudio.lsp.references' : 'cstudio.lsp.definition', args).catch(() => null)
    if (closed || view.state.doc !== state.doc) return
    if (!result?.ok || !result.locations.length) {
      context.notify(result?.ok ? (references ? '没有找到引用' : '没有找到定义') : result?.error || '语言服务查询失败')
      return
    }
    if (!references && result.locations.length === 1) { open(result.locations[0]); return }
    setPanel(showPanel.of(editor => {
      const dom = editor.dom.ownerDocument.createElement('div')
      dom.className = 'cstudio-cm-locations'
      const heading = dom.ownerDocument.createElement('strong')
      heading.textContent = references ? '引用' : '定义'
      const close = dom.ownerDocument.createElement('button')
      close.type = 'button'
      close.textContent = '关闭'
      close.addEventListener('click', () => { setPanel([]); editor.focus() })
      dom.append(heading, close)
      for (const location of result.locations) {
        const button = dom.ownerDocument.createElement('button')
        button.type = 'button'
        button.textContent = targetOpenPath(location) + ':' + (location.range.start.line + 1)
        button.addEventListener('click', () => { setPanel([]); open(location) })
        dom.append(button)
      }
      return { dom }
    }))
  }

  return {
    complete, hover, navigate,
    close() {
      if (closed) return
      closed = true
      clearTimeout(timer)
      subscription.dispose()
      void pending.then(() => rpc('cstudio.lsp.close', document)).catch(() => {})
    },
  }
}
