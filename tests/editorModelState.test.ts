import { afterEach, describe, expect, it, vi } from 'vitest'
import { EDITOR_MODEL_SELECTOR, EDITOR_ROOT_SELECTOR, TAB_SELECTOR, hasCodeFocus, hasEditorModel, hasEditorView, hasOpenTabs } from '../src/client/editorModelState.js'

afterEach(() => vi.unstubAllGlobals())

describe('command availability in the file editor', () => {
  it('uses the active editable surface and ignores other controls', () => {
    class ElementStub {
      constructor(private readonly editable: boolean) {}
      closest(selector: string) {
        return selector === EDITOR_MODEL_SELECTOR && this.editable ? this : null
      }
    }
    const content = new ElementStub(true)
    const findInput = new ElementStub(false)
    const nodes = new Map([[EDITOR_ROOT_SELECTOR, {}], [EDITOR_MODEL_SELECTOR, content], [TAB_SELECTOR, {}]])
    vi.stubGlobal('Element', ElementStub)
    vi.stubGlobal('document', { querySelector: (selector: string) => nodes.get(selector) ?? null, activeElement: content })

    expect(hasEditorView()).toBe(true)
    expect(hasEditorModel()).toBe(true)
    expect(hasOpenTabs()).toBe(true)
    expect(hasCodeFocus()).toBe(true)
    expect(hasCodeFocus(findInput)).toBe(false)

    nodes.delete(EDITOR_MODEL_SELECTOR)
    expect(hasEditorModel()).toBe(false)
    expect(hasOpenTabs()).toBe(true)
  })

  it('allows module use without a browser document', () => {
    expect(hasCodeFocus()).toBe(false)
    expect(hasEditorModel()).toBe(false)
    expect(hasEditorView()).toBe(false)
    expect(hasOpenTabs()).toBe(false)
  })
})
