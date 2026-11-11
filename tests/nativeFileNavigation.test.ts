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
})
