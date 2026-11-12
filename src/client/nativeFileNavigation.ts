/** 同一原生页签只提交最后一次选中文件的导航，保存失败时保留当前编辑。 */
const generations = new WeakMap<object, number>()
export interface NativeNavigationTab {
  actions?: { openResource?: (address: string, options: { replaceTab: boolean; params?: object }) => void }
  signal?: { aborted: boolean }
}
export interface NativePreviewResources {
  source(address: string): {
    getSnapshot(): { status: 'none' | 'loading' | 'live' | 'failed' }
    subscribe(listener: () => void): () => void
  }
}

function holdPreviewMetadata(resources: NativePreviewResources, address: string) {
  const source = resources.source(address)
  let unsubscribe: (() => void) | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  const ready = new Promise<void>(resolve => {
    timeout = setTimeout(resolve, 120)
    const check = () => { if (source.getSnapshot().status !== 'loading') resolve() }
    unsubscribe = source.subscribe(check)
    check()
  })
  return {
    ready,
    release() { clearTimeout(timeout); unsubscribe?.() },
  }
}

export async function navigateFile(
  tab: NativeNavigationTab | undefined,
  address: string,
  prepare?: (() => Promise<boolean>) | null,
  params?: object,
  previewResources?: NativePreviewResources,
): Promise<boolean> {
  const actions = tab?.actions
  if (!actions?.openResource) return false
  const revision = (generations.get(actions) ?? 0) + 1
  generations.set(actions, revision)
  let metadata: ReturnType<typeof holdPreviewMetadata> | undefined
  try {
    if (prepare && !await prepare()) return false
    if (previewResources && !tab?.signal?.aborted && generations.get(actions) === revision) {
      // Keep the workspace header in place until the native preview can draw its full path and actions.
      try {
        metadata = holdPreviewMetadata(previewResources, address)
        await metadata.ready
      } catch { /* Older hosts and unavailable providers still use the native open flow. */ }
    }
    if (tab?.signal?.aborted || generations.get(actions) !== revision) return false
    actions.openResource(address, { replaceTab: true, ...(params ? { params } : {}) })
    return true
  } catch { return false }
  finally { metadata?.release() }
}
