/** 同一原生页签只提交最后一次选中文件的导航，保存失败时保留当前编辑。 */
const generations = new WeakMap<object, number>()
export interface NativeNavigationTab {
  actions?: { openResource?: (address: string, options: { replaceTab: boolean; params?: object }) => void }
  signal?: { aborted: boolean }
}
export async function navigateFile(tab: NativeNavigationTab | undefined, address: string, prepare?: (() => Promise<boolean>) | null, params?: object): Promise<boolean> {
  const actions = tab?.actions
  if (!actions?.openResource) return false
  const revision = (generations.get(actions) ?? 0) + 1
  generations.set(actions, revision)
  try {
    if (prepare && !await prepare()) return false
    if (tab?.signal?.aborted || generations.get(actions) !== revision) return false
    actions.openResource(address, { replaceTab: true, ...(params ? { params } : {}) })
    return true
  } catch { return false }
}
