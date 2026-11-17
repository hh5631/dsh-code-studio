/**
 * 文件树侧别（左 / 右）的单一真源。
 *
 * 侧别是「本浏览器全局」偏好（`edrv.file-tree-side.v1`）。真正让它生效的是把属性写到
 * 宿主容器上、由 CSS 改文件树的 flex `order`。写入时机决定观感：
 *
 *   - 只在 WorkspacePanel 的 effect 里写，要等 `nativeContent` 这个 state 落一轮交给
 *     子组件；而打开文件时宿主的 `[data-textpreview-content]` 容器身份会变，
 *     effect 依赖数组不一定重跑，中间就会露出按默认（右）排好的一帧
 *     —— 也就是「先右后左」的跳变。
 *   - 所以这里额外维护一个写在 `document.documentElement` 上的镜像属性，它在模块加载
 *     （React 渲染之前）和每次切换侧别时**同步**写入。CSS 同时认这一份，
 *     首帧就已经是正确的顺序，不依赖任何 React 副作用时序。
 *
 * 本模块只负责「读 / 写偏好 + 幂等应用属性」，不参与布局计算。
 */
import { CACHE_KEY } from '../paths.js'

export type TreeSide = 'left' | 'right'

const DOC_ATTR = 'data-cstudio-tree-side'

const listeners = new Set<() => void>()
let cached: TreeSide | undefined

export function readTreeSide(): TreeSide {
  // 缓存命中即返回；未命中时**必须回填**——本函数是 WorkspacePanel 里
  // useSyncExternalStore 的 getSnapshot，React 会在每次渲染/一致性检查时调用它，
  // 不回填就等于每次渲染同步读一遍 localStorage（跨进程锁 + 反序列化）。
  // 只有 writeTreeSide 与模块加载首帧会走到未命中分支。
  if (cached) return cached
  try {
    cached = localStorage.getItem(CACHE_KEY.fileTreeSide) === 'left' ? 'left' : 'right'
  } catch {
    cached = 'right'
  }
  return cached
}

export function subscribeTreeSide(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** 幂等写属性：重复调用不产生额外 DOM 写入，可以放心放在每帧/多次 effect 里调用。 */
export function applyTreeSide(element: Element | null | undefined, side: TreeSide = readTreeSide()): void {
  if (!element) return
  if (side === 'left') {
    if (element.getAttribute(DOC_ATTR) !== 'left') element.setAttribute(DOC_ATTR, 'left')
  } else if (element.hasAttribute(DOC_ATTR)) {
    element.removeAttribute(DOC_ATTR)
  }
}

/** 把侧别镜像到 html 根节点，让布局在首帧就是对的（见文件头注释）。 */
function mirrorToDocument(side: TreeSide): void {
  if (typeof document === 'undefined') return
  applyTreeSide(document.documentElement, side)
}

export function writeTreeSide(side: TreeSide): void {
  cached = side
  mirrorToDocument(side)
  try { localStorage.setItem(CACHE_KEY.fileTreeSide, side) } catch { /* 存储被禁用时仍对本次页面生效。 */ }
  for (const listener of listeners) listener()
}

// 模块加载即镜像一次：React 渲染之前就位，首帧不会先按右侧排一遍。
mirrorToDocument(readTreeSide())
