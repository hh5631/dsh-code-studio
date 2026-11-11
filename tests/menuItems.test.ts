/**
 * client sidebar/menuItems.ts 内置菜单项测试。
 * 覆盖：默认项结构与排序（对齐 CodeBuddy 参考图分组）、「添加引用到对话」的文件/文件夹分派、
 * 忙态/不可用降级、visible 守卫（空路径/无会话/动作集缺失）、
 * 文件/文件夹/根空白区显隐矩阵（打开方式/新建/查找/剪贴板/复制路径/重命名/删除）、
 * 粘贴灰显与删除文案分派、文件管理动作执行（新建/重命名/删除/粘贴的 RPC 接线与降级）、
 * SVN 组显隐（managed/svnCli/tortoise × 文件/目录/根）与 P2 CLI 三项的状态矩阵。
 * 作者 ddj 2026-09-03 / 2026-09-16 / 2026年09月22号
 */
import { describe, expect, it, vi } from 'vitest'
import { createDefaultFileMenuItems } from '../src/client/sidebar/menuItems.js'
import type { TreeMenuItem, TreeMenuTarget } from '../src/client/sidebar/contextMenu.js'
import type { SidebarCtx } from '../src/client/sidebar/types.js'
import type { SvnChangeEntry, SvnStatusPayload } from '../src/shared/svn.js'
import { clearFileClip, fileClipOf, setFileClip } from '../src/client/fileClipboard.js'
import { rpcResponse } from './fixtures/rpcResponse.js'

/** 按 id 索引内置菜单项。 */
const byId = (): Record<string, TreeMenuItem> =>
  Object.fromEntries(createDefaultFileMenuItems().map((item) => [item.id, item]))

/** SVN 状态构造（缺省：受管理 + CLI/Tortoise 全可用）。 */
const svnOn = (over: Partial<SvnStatusPayload> = {}): SvnStatusPayload => ({
  managed: true,
  wcRoot: '/wc',
  svnCli: true,
  tortoise: true,
  svnPath: 'svn',
  tortoiseExe: 'C:\\T\\TortoiseProc.exe',
  ...over,
})

/** 假「添加到对话」动作集：appendReference 记录调用并返回可配置结果。 */
const makeAdd = (outcome = 'ok') => ({
  appendReference: vi.fn(() => Promise.resolve(outcome)),
})

/** 构造假 ctx（缺省 sessionId=s1、带动作集与 notify spy）；传 null 表示动作集缺失。 */
const makeCtx = (add: ReturnType<typeof makeAdd> | null = makeAdd(), overrides = {}) =>
  Object.assign(
    { sessionId: 's1', addToConversation: add == null ? undefined : add, notify: vi.fn() },
    overrides,
  ) as unknown as SidebarCtx

describe('createDefaultFileMenuItems', () => {
  it('内置项按 order 排序：打开/新建 → 浏览器打开 → 对话/查找 → 剪贴板 → 复制路径 → 重命名/删除', () => {
    const items = createDefaultFileMenuItems()
    expect(items.map((item) => item.id)).toEqual([
      'open-with',
      'new-file',
      'new-folder',
      'forge-open',
      'forge-local',
      'reveal-in-explorer',
      'add-to-conversation',
      'find-in-folder',
      'cut',
      'copy',
      'paste',
      'copy-path',
      'copy-relative-path',
      'remote-download',
      'rename',
      'delete',
    ])
    expect(byId()['reveal-in-explorer']).toMatchObject({ label: '在文件资源管理器中显示', order: 30, group: 2 })
    expect(byId()['add-to-conversation']).toMatchObject({ label: '添加引用到对话', order: 50, group: 3 })
  })

  it('文件目标：以 file 外观追加引用并提示「已添加文件引用」', async () => {
    const add = makeAdd('ok')
    const notify = vi.fn()
    const ctx = makeCtx(add, { notify })
    byId()['add-to-conversation'].run({ path: 'src/index.ts', type: 'file' }, ctx)
    await Promise.resolve()
    expect(add.appendReference).toHaveBeenCalledWith('s1', 'src/index.ts', undefined, 'file')
    expect(notify).toHaveBeenCalledWith('已添加文件引用')
  })

  it('目录目标：以 folder 外观追加引用并提示「已添加文件夹引用」', async () => {
    const add = makeAdd('ok')
    const notify = vi.fn()
    const ctx = makeCtx(add, { notify })
    byId()['add-to-conversation'].run({ path: 'src/components', type: 'directory' }, ctx)
    await Promise.resolve()
    expect(add.appendReference).toHaveBeenCalledWith('s1', 'src/components', undefined, 'folder')
    expect(notify).toHaveBeenCalledWith('已添加文件夹引用')
  })

  it('忙态：提示已降级纯文本', async () => {
    const notify = vi.fn()
    const ctx = makeCtx(makeAdd('busy'), { notify })
    byId()['add-to-conversation'].run({ path: 'src/index.ts', type: 'file' }, ctx)
    await Promise.resolve()
    expect(notify).toHaveBeenCalledWith('已添加文件引用（已降级纯文本）')
  })

  it('两条通道都失败：提示重试（内容未被改动）', async () => {
    const notify = vi.fn()
    const ctx = makeCtx(makeAdd('failed'), { notify })
    byId()['add-to-conversation'].run({ path: 'src/index.ts', type: 'file' }, ctx)
    await Promise.resolve()
    expect(notify).toHaveBeenCalledWith('添加引用失败（输入框忙或未就绪，请重试）')
  })

  it('不可用：提示无法添加到对话', async () => {
    const notify = vi.fn()
    const ctx = makeCtx(makeAdd('unavailable'), { notify })
    byId()['add-to-conversation'].run({ path: 'src/index.ts', type: 'file' }, ctx)
    await Promise.resolve()
    expect(notify).toHaveBeenCalledWith('无法添加到对话（无会话或输入框不可用）')
  })

  it('动作集缺失：notify 提示不可用且不调用 appendReference', () => {
    const ctx = makeCtx(null)
    byId()['add-to-conversation'].run({ path: 'src/index.ts', type: 'file' }, ctx)
    expect(ctx.notify).toHaveBeenCalledWith('添加到对话不可用')
  })

  it('visible 守卫：空路径/无会话/动作集缺失隐藏，正常目标显示', () => {
    const item = byId()['add-to-conversation']
    expect(item.visible({ path: '', type: 'directory' }, makeCtx())).toBe(false)
    expect(item.visible({ path: 'src', type: 'directory' }, makeCtx(null))).toBe(false)
    expect(item.visible({ path: 'src', type: 'directory' }, makeCtx(null, { sessionId: undefined }))).toBe(false)
    expect(item.visible({ path: 'src', type: 'directory' }, makeCtx())).toBe(true)
  })
})



describe('文件/文件夹/根空白区显隐矩阵（对齐 CodeBuddy 参考图）', () => {
  const file = { path: 'src/a.ts', type: 'file' } as const
  const dir = { path: 'src', type: 'directory' } as const
  const root = { path: '', type: 'directory' } as const
  /** 带 UI 能力的 ctx（openWith/searchInFolder/cwd 齐备）。 */
  const uiCtx = (): SidebarCtx => makeCtx(makeAdd(), { cwd: '/wc', openWith: vi.fn(), searchInFolder: vi.fn() })

  it('打开方式…：仅文件 + openWith 可用', () => {
    const item = byId()['open-with']
    expect(item.visible(file, uiCtx())).toBe(true)
    expect(item.visible(dir, uiCtx())).toBe(false)
    expect(item.visible(root, uiCtx())).toBe(false)
    expect(item.visible(file, makeCtx())).toBe(false)
  })

  it('新建文件…/新建文件夹：文件夹与根空白区；文件不出', () => {
    for (const id of ['new-file', 'new-folder']) {
      const item = byId()[id]
      expect(item.visible(file, uiCtx())).toBe(false)
      expect(item.visible(dir, uiCtx())).toBe(true)
      expect(item.visible(root, uiCtx())).toBe(true)
    }
  })

  it('在文件夹中查找…：仅文件夹/根 + searchInFolder 可用', () => {
    const item = byId()['find-in-folder']
    expect(item.visible(file, uiCtx())).toBe(false)
    expect(item.visible(dir, uiCtx())).toBe(true)
    expect(item.visible(root, uiCtx())).toBe(true)
    expect(item.visible(dir, makeCtx())).toBe(false)
  })

  it('剪切/复制：非根目标；粘贴：文件夹/根专属（文件菜单不带粘贴）', () => {
    expect(byId()['cut'].visible(root, uiCtx())).toBe(false)
    expect(byId()['copy'].visible(root, uiCtx())).toBe(false)
    expect(byId()['cut'].visible(file, uiCtx())).toBe(true)
    const paste = byId()['paste']
    expect(paste.visible(file, uiCtx())).toBe(false)
    expect(paste.visible(dir, uiCtx())).toBe(true)
    expect(paste.visible(root, uiCtx())).toBe(true)
  })

  it('粘贴：剪贴板空 → 置灰；有内容 → 可点', () => {
    clearFileClip()
    const paste = byId()['paste']
    const disabledOf = (target: TreeMenuTarget): boolean =>
      typeof paste.disabled === 'function' ? paste.disabled(target, uiCtx()) : paste.disabled === true
    expect(disabledOf(dir)).toBe(true)
    setFileClip('copy', 'src/a.ts')
    expect(disabledOf(dir)).toBe(false)
    clearFileClip()
  })

  it('复制路径：仅非根；复制相对路径还需 cwd', () => {
    expect(byId()['copy-path'].visible(root, uiCtx())).toBe(false)
    expect(byId()['copy-path'].visible(file, uiCtx())).toBe(true)
    const rel = byId()['copy-relative-path']
    expect(rel.visible(file, uiCtx())).toBe(true)
    expect(rel.visible(file, makeCtx())).toBe(false)
    expect(rel.visible(root, uiCtx())).toBe(false)
  })

  it('重命名/删除：仅非根；删除文案区分文件「删除」与文件夹「永久删除」', () => {
    expect(byId()['rename'].visible(root, uiCtx())).toBe(false)
    const del = byId()['delete']
    expect(del.visible(root, uiCtx())).toBe(false)
    expect(del.visible(file, uiCtx())).toBe(true)
    expect(del.danger).toBe(true)
    const labelOf = (target: TreeMenuTarget): string =>
      typeof del.label === 'function' ? del.label(target, uiCtx()) : del.label
    expect(labelOf(file)).toBe('删除')
    expect(labelOf(dir)).toBe('永久删除')
  })
})

describe('文件管理动作执行（新建/重命名/删除/粘贴的 RPC 接线与降级）', () => {
  /** 桩 fetch：解析 { method, args } 载荷并返回可配置结果；返回调用记录与恢复函数。 */
  const stubFetch = (result: unknown) => {
    const original = (globalThis as { fetch?: unknown }).fetch
    const calls: Array<{ method: string; args: Record<string, unknown> }> = []
    ;(globalThis as { fetch: unknown }).fetch = vi.fn((_url: string, init: { body: string }) => {
      calls.push(JSON.parse(init.body))
      return Promise.resolve(rpcResponse(result))
    })
    return { calls, restore: () => { (globalThis as { fetch?: unknown }).fetch = original } }
  }

  /** 落定异步动作（run 返回 void，内部 void + Promise 链）。 */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

  it('剪切/复制：登记文件剪贴板并提示；不发 RPC', () => {
    clearFileClip()
    const stub = stubFetch({ ok: true })
    try {
      const notify = vi.fn()
      const ctx = makeCtx(makeAdd(), { notify })
      byId()['cut'].run({ path: 'src/a.ts', type: 'file' }, ctx)
      expect(fileClipOf()).toEqual({ mode: 'cut', path: 'src/a.ts' })
      expect(notify).toHaveBeenCalledWith('已剪切「a.ts」')
      byId()['copy'].run({ path: 'src/b.ts', type: 'file' }, ctx)
      expect(fileClipOf()).toEqual({ mode: 'copy', path: 'src/b.ts' })
      expect(notify).toHaveBeenCalledWith('已复制「b.ts」')
      expect(stub.calls).toHaveLength(0)
    } finally {
      stub.restore()
      clearFileClip()
    }
  })

  it('粘贴：剪贴板空提示并不发 RPC', async () => {
    clearFileClip()
    const stub = stubFetch({ ok: true })
    try {
      const notify = vi.fn()
      byId()['paste'].run({ path: 'docs', type: 'directory' }, makeCtx(makeAdd(), { notify }))
      await settle()
      expect(notify).toHaveBeenCalledWith('剪贴板为空')
      expect(stub.calls).toHaveLength(0)
    } finally {
      stub.restore()
    }
  })

  it('粘贴（复制模式）：fsCopy 到目标目录，剪贴板保留', async () => {
    setFileClip('copy', 'src/a.ts')
    const stub = stubFetch({ ok: true, from: 'src/a.ts', to: 'docs/a.ts' })
    try {
      const notify = vi.fn()
      byId()['paste'].run({ path: 'docs', type: 'directory' }, makeCtx(makeAdd(), { notify }))
      await settle()
      expect(stub.calls).toEqual([{ method: 'cstudio.fsCopy', args: { sessionId: 's1', from: 'src/a.ts', toDir: 'docs' } }])
      expect(notify).toHaveBeenCalledWith('已复制到 docs')
      expect(fileClipOf()).toEqual({ mode: 'copy', path: 'src/a.ts' })
    } finally {
      stub.restore()
      clearFileClip()
    }
  })

  it('粘贴（剪切模式）：fsMove 后清空剪贴板', async () => {
    setFileClip('cut', 'src/a.ts')
    const stub = stubFetch({ ok: true, from: 'src/a.ts', to: 'docs/a.ts' })
    try {
      const notify = vi.fn()
      byId()['paste'].run({ path: 'docs', type: 'directory' }, makeCtx(makeAdd(), { notify }))
      await settle()
      expect(stub.calls[0].method).toBe('cstudio.fsMove')
      expect(notify).toHaveBeenCalledWith('已移动到 docs')
      expect(fileClipOf()).toBeNull()
    } finally {
      stub.restore()
      clearFileClip()
    }
  })

  it('新建文件…：名称弹窗 → fsCreateFile（嵌套名拼接）→ 打开文件', async () => {
    const stub = stubFetch({ ok: true, path: 'src/sub/a.ts' })
    try {
      const notify = vi.fn()
      const openFile = vi.fn()
      const prompt = vi.fn(() => Promise.resolve('sub/a.ts'))
      byId()['new-file'].run({ path: 'src', type: 'directory' }, makeCtx(makeAdd(), { notify, openFile, prompt }))
      await settle()
      expect(prompt).toHaveBeenCalledWith('新建文件', '')
      expect(stub.calls).toEqual([{ method: 'cstudio.fsCreateFile', args: { sessionId: 's1', path: 'src/sub/a.ts' } }])
      expect(openFile).toHaveBeenCalledWith('src/sub/a.ts')
      expect(notify).toHaveBeenCalledWith('已新建文件 src/sub/a.ts')
    } finally {
      stub.restore()
    }
  })

  it('新建文件…：非法名称（.. 路径段）弹回提示、不发 RPC', async () => {
    const stub = stubFetch({ ok: true })
    try {
      const notify = vi.fn()
      const prompt = vi.fn(() => Promise.resolve('a/../b'))
      byId()['new-folder'].run({ path: 'src', type: 'directory' }, makeCtx(makeAdd(), { notify, prompt }))
      await settle()
      expect(notify).toHaveBeenCalledWith('名称不能包含 . 或 .. 路径段')
      expect(stub.calls).toHaveLength(0)
    } finally {
      stub.restore()
    }
  })

  it('重命名…：fsRename 带新名称段；名称未变化为 no-op', async () => {
    const stub = stubFetch({ ok: true, from: 'src/a.ts', to: 'src/b.ts' })
    try {
      const notify = vi.fn()
      const prompt = vi.fn(() => Promise.resolve('b.ts'))
      byId()['rename'].run({ path: 'src/a.ts', type: 'file' }, makeCtx(makeAdd(), { notify, prompt }))
      await settle()
      expect(prompt).toHaveBeenCalledWith('重命名', 'a.ts')
      expect(stub.calls).toEqual([{ method: 'cstudio.fsRename', args: { sessionId: 's1', path: 'src/a.ts', newName: 'b.ts' } }])
      expect(notify).toHaveBeenCalledWith('已重命名')

      stub.calls.length = 0
      prompt.mockReturnValueOnce(Promise.resolve('a.ts'))
      byId()['rename'].run({ path: 'src/a.ts', type: 'file' }, makeCtx(makeAdd(), { notify, prompt }))
      await settle()
      expect(stub.calls).toHaveLength(0)
    } finally {
      stub.restore()
    }
  })

  it('删除：confirm 拦截取消则不发 RPC；确认后 fsDelete', async () => {
    const stub = stubFetch({ ok: true, path: 'src/a.ts' })
    try {
      const notify = vi.fn()
      const confirm = vi.fn(() => false)
      byId()['delete'].run({ path: 'src/a.ts', type: 'file' }, makeCtx(makeAdd(), { notify, confirm }))
      await settle()
      expect(confirm).toHaveBeenCalled()
      expect(stub.calls).toHaveLength(0)

      confirm.mockReturnValueOnce(true)
      byId()['delete'].run({ path: 'src/a.ts', type: 'file' }, makeCtx(makeAdd(), { notify, confirm }))
      await settle()
      expect(stub.calls).toEqual([{ method: 'cstudio.fsDelete', args: { sessionId: 's1', path: 'src/a.ts' } }])
      expect(notify).toHaveBeenCalledWith('已删除「a.ts」')
    } finally {
      stub.restore()
    }
  })

  it('删除：RPC 失败只提示错误、不清剪贴板语义', async () => {
    const stub = stubFetch({ ok: false, error: '源不存在' })
    try {
      const notify = vi.fn()
      const confirm = vi.fn(() => true)
      byId()['delete'].run({ path: 'src', type: 'directory' }, makeCtx(makeAdd(), { notify, confirm }))
      await settle()
      expect(notify).toHaveBeenCalledWith('删除失败：源不存在')
    } finally {
      stub.restore()
    }
  })
})
