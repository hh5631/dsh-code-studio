import { Annotation, EditorState, Text, Transaction, type Extension } from '@codemirror/state'
import { EditorView, type ViewUpdate } from '@codemirror/view'
import type { EditorModel } from '../editorTypes.js'

const remoteEdit = Annotation.define<boolean>()
const attachedModels = new WeakMap<EditorView, CodeMirrorModel>()

export const trackDocument = EditorView.updateListener.of(update => {
  attachedModels.get(update.view)?.update(update)
})

export class CodeMirrorModel implements EditorModel {
  private version = 1
  private disposed = false
  private lineSeparator = '\n'
  private readonly listeners = new Set<() => void>()
  private readonly views = new Map<EditorView, () => void>()
  private state: EditorState

  constructor(text: string, private readonly extensions: Extension) {
    this.state = this.newState(text)
  }

  private newState(text: string): EditorState {
    this.lineSeparator = text.match(/\r\n|\n|\r/)?.[0] ?? '\n'
    return EditorState.create({
      doc: Text.of(text.split(/\r\n|\n|\r/)),
      extensions: this.extensions,
    })
  }

  getValue() { return this.state.doc.sliceString(0, this.state.doc.length, this.lineSeparator) }
  getVersionId() { return this.version }
  isDisposed() { return this.disposed }
  isAttachedToEditor() { return this.views.size > 0 }

  onDidChangeContent(listener: () => void) {
    this.listeners.add(listener)
    return { dispose: () => { this.listeners.delete(listener) } }
  }

  private changed() {
    this.version += 1
    for (const listener of this.listeners) listener()
  }

  setValue(text: string) {
    this.state = this.newState(text)
    for (const reset of this.views.values()) reset()
    this.changed()
  }

  attach(view: EditorView, reset: () => void) {
    attachedModels.set(view, this)
    this.views.set(view, reset)
    this.restore(view)
  }

  restore(view: EditorView) { view.setState(this.state) }

  detach(view: EditorView) {
    attachedModels.delete(view)
    this.views.delete(view)
  }

  update(update: ViewUpdate) {
    if (update.transactions.some(transaction => transaction.annotation(remoteEdit))) return
    this.state = update.state
    if (!update.docChanged) return
    for (const view of this.views.keys()) {
      if (view === update.view) continue
      view.dispatch({
        changes: update.changes,
        annotations: [remoteEdit.of(true), Transaction.addToHistory.of(false)],
      })
    }
    this.changed()
  }

  dispose() {
    this.disposed = true
    this.listeners.clear()
  }
}
