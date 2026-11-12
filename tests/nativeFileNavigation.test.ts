import { describe, it, expect, vi } from 'vitest'
import { navigateFile } from '../src/client/nativeFileNavigation.js'

describe('原生文件树编辑导航', () => {
  it('保存成功后原地替换文件资源，保留行号参数', async () => {
    const openResource = vi.fn(), save = vi.fn(async () => true)
    expect(await navigateFile({ actions: { openResource } }, 'file:a', save, { line: 12 })).toBe(true)
    expect(save).toHaveBeenCalledOnce()
    expect(openResource).toHaveBeenCalledWith('file:a', { replaceTab: true, params: { line: 12 } })
  })
  it('保存失败、取消或页签销毁时不离开当前文件', async () => {
    const openResource = vi.fn(), tab = { actions: { openResource }, signal: { aborted: false } }
    expect(await navigateFile(tab, 'file:b', async () => false)).toBe(false)
    expect(await navigateFile(tab, 'file:b', async () => { throw new Error('save failed') })).toBe(false)
    expect(await navigateFile(tab, 'file:b', async () => { tab.signal.aborted = true; return true })).toBe(false)
    expect(openResource).not.toHaveBeenCalled()
  })
  it('连续选中文件时，较慢的旧保存结果不能盖过新选择', async () => {
    const openResource = vi.fn(), tab = { actions: { openResource } }
    let finish!: (value: boolean) => void
    const old = navigateFile(tab, 'file:old', () => new Promise(resolve => { finish = resolve }))
    expect(await navigateFile(tab, 'file:new', async () => true)).toBe(true)
    finish(true)
    expect(await old).toBe(false)
    expect(openResource).toHaveBeenCalledTimes(1)
    expect(openResource).toHaveBeenCalledWith('file:new', { replaceTab: true })
  })
  it('工作区在原生预览接手后才释放已就绪的文件元数据', async () => {
    let status: 'loading' | 'live' = 'loading'
    let notify!: () => void
    const unsubscribe = vi.fn()
    const source = vi.fn(() => ({
      getSnapshot: () => ({ status }),
      subscribe(listener: () => void) { notify = listener; return unsubscribe },
    }))
    const openResource = vi.fn(() => expect(unsubscribe).not.toHaveBeenCalled())
    const opened = navigateFile({ actions: { openResource } }, 'file:a', null, undefined, { source })
    expect(openResource).not.toHaveBeenCalled()
    expect(source).toHaveBeenCalledWith('file:a')
    status = 'live'
    notify()
    expect(await opened).toBe(true)
    expect(openResource).toHaveBeenCalledOnce()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
  it('元数据等待有上限，过期的选择不会打开', async () => {
    vi.useFakeTimers()
    try {
      const openResource = vi.fn(), tab = { actions: { openResource } }
      const unsubscribe = vi.fn()
      const resources = {
        source: () => ({ getSnapshot: () => ({ status: 'loading' as const }), subscribe: () => unsubscribe }),
      }
      const old = navigateFile(tab, 'file:old', null, undefined, resources)
      const latest = navigateFile(tab, 'file:new', null, undefined, resources)
      await vi.runAllTimersAsync()
      expect(await old).toBe(false)
      expect(await latest).toBe(true)
      expect(openResource).toHaveBeenCalledExactlyOnceWith('file:new', { replaceTab: true })
      expect(unsubscribe).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
