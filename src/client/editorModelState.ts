/** Inspect the editor owned by this plugin for command availability. */
export const EDITOR_ROOT_SELECTOR = '.edrv-editor-row'
export const EDITOR_MODEL_SELECTOR = EDITOR_ROOT_SELECTOR + ' [data-cstudio-editor-active="true"] .cm-content[contenteditable="true"]'
export const TAB_SELECTOR = EDITOR_ROOT_SELECTOR + ' .edrv-tabs .edrv-tab'

export function hasCodeFocus(target?: unknown): boolean {
  if (typeof document === 'undefined') return false
  const node = target ?? document.activeElement
  return node instanceof Element && node.closest(EDITOR_MODEL_SELECTOR) !== null
}

export function hasEditorView(): boolean {
  return typeof document !== 'undefined' && document.querySelector(EDITOR_ROOT_SELECTOR) !== null
}

export function hasEditorModel(): boolean {
  return typeof document !== 'undefined' && document.querySelector(EDITOR_MODEL_SELECTOR) !== null
}

export function hasOpenTabs(): boolean {
  return typeof document !== 'undefined' && document.querySelector(TAB_SELECTOR) !== null
}
