export interface EditorModel {
  getValue(): string
  setValue(value: string): void
  getVersionId(): number
  isDisposed(): boolean
  isAttachedToEditor(): boolean
  dispose(): void
  onDidChangeContent(listener: () => void): { dispose(): void }
}

export type CreateEditorModel = (scope: string, path: string, content: string) => EditorModel

export interface EditorContext {
  scope: string
  open(path: string, line?: number, column?: number): void
  notify(message: string): void
  save(): void
}

export type EditorCommand = 'goToLine' | 'toggleComment' | 'duplicateLine' | 'goToDefinition' | 'findReferences'

export interface DocumentEditor {
  bind(path: string, model: EditorModel): void
  clear(): void
  save(): void
  goTo(line: number, column: number): void
  setWrap(enabled: boolean): void
  activate(path: string, model: EditorModel, sessionId?: string): void | (() => void)
  run(command: EditorCommand): void
  dispose(): void
}

export interface EditorEngine {
  createModel: CreateEditorModel
  mount(host: HTMLElement, context: EditorContext): DocumentEditor
}
