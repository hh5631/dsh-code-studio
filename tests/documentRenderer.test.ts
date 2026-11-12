import { expect, it, vi } from 'vitest'
import { DOCUMENT_EDITOR_ID, installDocumentRenderer, type DocumentPreviewsLike } from '../src/client/documentRenderer.js'

it('keeps native code and Markdown as defaults and adds an explicit editor choice', async () => {
  type Definition = Parameters<DocumentPreviewsLike['register']>[0]
  const definitions: Definition[] = []
  const listeners = new Set<() => void>()
  const codeId = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/code'
  const code = { id: codeId, extensions: ['ts'], title: () => '代码', priority: 'builtin', loading: 'text-pages' } as const
  definitions.push(code, { ...code, id: 'native-markdown', extensions: ['md'], title: () => 'Markdown' })
  const nativeBody = () => null
  const entries = [{ options: { key: codeId }, component: nativeBody, locale: 'sidebarCodePreview' }]
  const notify = () => { for (const listener of listeners) listener() }
  const previews: DocumentPreviewsLike = {
    getSnapshot: () => [...definitions],
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    register(definition) { definitions.push(definition); notify(); return () => { definitions.splice(definitions.indexOf(definition), 1); notify() } },
  }
  const slots = {
    entries: () => entries, subscribe: () => () => {},
    inject(_name: string, register: () => unknown) { return register() },
    register(options: { key: string }, component: unknown) {
      const entry = { options, component: component as typeof nativeBody, locale: 'sidebarCodePreview' }
      entries.push(entry); return () => { entries.splice(entries.indexOf(entry), 1) }
    },
  }
  vi.stubGlobal('window', new EventTarget())
  try {
    const dispose = installDocumentRenderer(previews, slots, () => null)
    await Promise.resolve()
    const menu = (ext: string) => definitions.filter(def => def.extensions.includes(ext)).map(def => def.id)
    expect(menu('ts')).toEqual([codeId, DOCUMENT_EDITOR_ID])
    expect(menu('md')).toEqual(['native-markdown', DOCUMENT_EDITOR_ID])
    expect(menu('txt')).toEqual(['dsh-code-studio/native-code', DOCUMENT_EDITOR_ID])
    expect(entries.find(entry => entry.options.key === 'dsh-code-studio/native-code')?.component).toBe(nativeBody)
    expect(menu('png')).toEqual([])
    dispose?.()
    expect(menu('ts')).toEqual([codeId])
    expect(menu('txt')).toEqual([])
  } finally { vi.unstubAllGlobals() }
})
