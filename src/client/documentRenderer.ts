import { log } from './log.js'
import { LANG_BY_EXT } from './monaco/loader.js'
import { canEditFile, type SlotsLike } from './officialSidebar.js'
import { NATIVE_OPEN_EVENT } from './nativeOpenStore.js'

const SLOT = 'sidebar.right.tab.document'
const CODE = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/code'
const EDITOR = 'dsh-code-studio/document'
const CODE_FALLBACK = 'dsh-code-studio/native-code'
const extensions = [...new Set([...Object.keys(LANG_BY_EXT), 'csv', 'tsv', 'conf', 'cmake', 'diff', 'patch'])]
export const DOCUMENT_EDITOR_ID = EDITOR

interface Definition {
  id: string; extensions: readonly string[]; title: () => string
  priority?: 'builtin' | 'extension'; loading: 'text-pages' | 'bytes-complete' | 'renderer'
  wrap?: boolean; sourceLines?: boolean
}
export interface DocumentPreviewsLike {
  getSnapshot(): readonly Definition[]
  subscribe(listener: () => void): () => void
  register(definition: Definition): () => void
}
interface DocumentSlots extends SlotsLike {
  entries(name: string): readonly { options: { key?: string }; component: unknown; locale?: string }[]
  subscribe(name: string, listener: () => void): () => void
}

/** 编辑器是原生菜单的一项。对于宿主只提供纯文本的后缀，先复用原生代码正文作为默认。 */
export function installDocumentRenderer(previews: DocumentPreviewsLike, slots: DocumentSlots, render: unknown): (() => void) | null {
  if (!previews?.getSnapshot || !previews?.subscribe || !previews?.register || !slots.entries || !slots.subscribe) return null
  const body = slots.inject(SLOT, () => slots.register({ name: SLOT, key: EDITOR }, render))
  if (typeof body !== 'function') return null
  let dispose: (() => void) | undefined
  let signature = ''
  let closed = false, scheduled = false
  function sync() {
    if (closed) return
    const native = previews.getSnapshot().filter(def => def.id !== EDITOR && def.id !== CODE_FALLBACK)
    const code = native.find(def => def.id === CODE)
    const codeBody = slots.entries(SLOT).find(entry => entry.options.key === CODE)
    const enabled = code && codeBody ? extensions.filter(ext => canEditFile(`file.${ext}`)) : []
    const covered = new Set(native.flatMap(def => def.extensions.map(ext => ext.toLowerCase().replace(/^\./, ''))))
    const missing = enabled.filter(ext => !covered.has(ext))
    const next = JSON.stringify([enabled, missing, native.map(def => def.id)])
    if (next === signature) return
    signature = next
    dispose?.(); dispose = undefined
    if (!enabled.length || !code || !codeBody) return
    const undo: Array<() => void> = []
    try {
      if (missing.length) {
        const slot = slots.register({ name: SLOT, key: CODE_FALLBACK, locale: codeBody.locale }, codeBody.component)
        if (typeof slot !== 'function') return
        undo.push(() => { slot() })
        undo.push(previews.register({ ...code, id: CODE_FALLBACK, extensions: missing }))
      }
      // 相同后缀和优先级下，DSH 取先注册的原生查看器；编辑器只在菜单明确选中时挂载。
      undo.push(previews.register({ id: EDITOR, extensions: enabled, title: () => '编辑器', priority: 'builtin', loading: 'renderer', wrap: true }))
      dispose = () => { for (const release of undo.reverse()) release() }
    } catch (error) {
      for (const release of undo.reverse()) release()
      log.warn('原生视图菜单编辑器注册失败：' + String(error))
    }
  }
  function schedule() {
    if (closed || scheduled) return
    scheduled = true
    queueMicrotask(() => { scheduled = false; sync() })
  }
  const offPreviews = previews.subscribe(schedule), offSlots = slots.subscribe(SLOT, schedule)
  window.addEventListener(NATIVE_OPEN_EVENT, schedule)
  schedule()
  return () => {
    closed = true; offPreviews(); offSlots()
    window.removeEventListener(NATIVE_OPEN_EVENT, schedule)
    dispose?.(); body()
  }
}
