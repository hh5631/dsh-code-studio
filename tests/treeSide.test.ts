import { describe, expect, it, vi, afterEach } from 'vitest'

/**
 * 侧别模块不能依赖 React 时序：它必须在模块加载时就同步镜像到 html 根节点，
 * 否则「打开文件」时会先按宿主默认（右）排一帧再被纠正 —— 就是用户看到的
 * 「先把文件树放右侧，再放到左侧」。
 */

interface FakeElement {
  attrs: Map<string, string>
  getAttribute(name: string): string | null
  setAttribute(name: string, value: string): void
  hasAttribute(name: string): boolean
  removeAttribute(name: string): void
}

function fakeElement(): FakeElement {
  const attrs = new Map<string, string>()
  return {
    attrs,
    getAttribute: (name) => (attrs.has(name) ? attrs.get(name)! : null),
    setAttribute: (name, value) => { attrs.set(name, value) },
    hasAttribute: (name) => attrs.has(name),
    removeAttribute: (name) => { attrs.delete(name) },
  }
}

const storage = new Map<string, string>()
const html = fakeElement()
const globals = globalThis as unknown as Record<string, unknown>

vi.stubGlobal('document', { documentElement: html })
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value) },
})

/** 用全新模块实例模拟一次页面加载（模块加载即镜像一次）。 */
async function load(side: string | null) {
  vi.resetModules()
  html.attrs.clear()
  storage.clear()
  if (side !== null) storage.set('edrv.file-tree-side.v1', side)
  const mod = await import('../src/client/state/treeSide.js')
  return { mod, html }
}

afterEach(() => {
  delete globals.__nothing
})

describe('treeSide', () => {
  it('把已保存的左侧偏好在模块加载时就镜像到 html 根节点（首帧即左侧）', async () => {
    const { mod, html: root } = await load('left')
    expect(mod.readTreeSide()).toBe('left')
    expect(root.getAttribute('data-cstudio-tree-side')).toBe('left')
  })

  it('默认是右侧，且不往 html 上写多余属性', async () => {
    const { mod, html: root } = await load(null)
    expect(mod.readTreeSide()).toBe('right')
    expect(root.hasAttribute('data-cstudio-tree-side')).toBe(false)
  })

  it('切换侧别时同步更新 html 镜像并落盘，订阅者收到通知', async () => {
    const { mod, html: root } = await load('right')
    let calls = 0
    const off = mod.subscribeTreeSide(() => { calls += 1 })
    mod.writeTreeSide('left')
    expect(calls).toBe(1)
    expect(root.getAttribute('data-cstudio-tree-side')).toBe('left')
    expect(storage.get('edrv.file-tree-side.v1')).toBe('left')
    mod.writeTreeSide('right')
    expect(root.hasAttribute('data-cstudio-tree-side')).toBe(false)
    expect(storage.get('edrv.file-tree-side.v1')).toBe('right')
    expect(calls).toBe(2)
    off()
  })

  it('applyTreeSide 幂等：重复应用同一侧别不产生额外属性写入', async () => {
    const { mod } = await load('left')
    const target = fakeElement()
    let writes = 0
    const original = target.setAttribute
    target.setAttribute = (name, value) => { writes += 1; original(name, value) }
    mod.applyTreeSide(target, 'left')
    mod.applyTreeSide(target, 'left')
    mod.applyTreeSide(target, 'left')
    expect(target.getAttribute('data-cstudio-tree-side')).toBe('left')
    expect(writes).toBe(1)
    mod.applyTreeSide(target, 'right')
    expect(target.hasAttribute('data-cstudio-tree-side')).toBe(false)
  })
})
