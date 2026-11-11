import { log } from './log.js'
import { LANG_BY_EXT } from './monaco/loader.js'
import { deferToOfficial, type SlotsLike } from './officialSidebar.js'
import { inNativePath, NATIVE_OPEN_EVENT } from './nativeOpenStore.js'

const DOCUMENT_SLOT = 'sidebar.right.tab.document'
export const DOCUMENT_EDITOR_ID = 'dsh-code-studio/document'
const supported = [...Object.keys(LANG_BY_EXT), 'csv', 'tsv', 'conf', 'cmake', 'diff', 'patch']

export interface DocumentPreviewsLike {
  register(definition: {
    id: string; extensions: string[]; title: () => string
    priority: 'extension'; loading: 'renderer'; wrap: boolean
  }): () => void
}

/** 在 DSH 原生文档工具栏之下提供编辑正文，原生预览仍可从工具栏选择。 */
export function installDocumentRenderer(previews: DocumentPreviewsLike, slots: SlotsLike, render: unknown) {
  if (typeof previews?.register !== 'function') return null
  let body: unknown
  let removeRenderer: (() => void) | undefined
  let extensions = new Set<string>()
  const sync = () => {
    const next = supported.filter(ext => !deferToOfficial(`file.${ext}`) && !inNativePath(`file.${ext}`))
    if (next.length === extensions.size && next.every(ext => extensions.has(ext))) return
    removeRenderer?.()
    removeRenderer = undefined
    extensions.clear()
    removeRenderer = previews.register({ id: DOCUMENT_EDITOR_ID, extensions: next, title: () => '编辑器', priority: 'extension', loading: 'renderer', wrap: true })
    extensions = new Set(next)
  }
  try {
    body = slots.inject(DOCUMENT_SLOT, () => slots.register({ name: DOCUMENT_SLOT, key: DOCUMENT_EDITOR_ID }, render))
    if (typeof body !== 'function') return null
    sync()
  } catch (error) {
    if (typeof body === 'function') body()
    log.warn('原生文档编辑器注册失败（' + String(error) + '）')
    return null
  }
  const syncNative = () => {
    try { sync() } catch (error) { log.warn('同步原生预览范围失败（' + String(error) + '）') }
  }
  window.addEventListener(NATIVE_OPEN_EVENT, syncNative)
  return {
    matches(path: string) {
      const base = path.split(/[\\/]/).pop() ?? ''
      const dot = base.lastIndexOf('.')
      return dot >= 0 && extensions.has(base.slice(dot + 1).toLowerCase())
    },
    dispose() {
      window.removeEventListener(NATIVE_OPEN_EVENT, syncNative)
      removeRenderer?.()
      if (typeof body === 'function') body()
    },
  }
}
