/**
 * 远程访问通道前缀（/remote）回归：本地零前缀、远程整链前缀、异常 seat 降级。
 * @author ddj 2026年11月02号
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CHANNEL_PREFIX, CHANNEL_SEAT, channelPrefix, transportPath, transportUrl } from '../src/shared/remoteChannel.js'

afterEach(() => vi.unstubAllGlobals())

describe('remote channel prefix', () => {
  it('keeps the local path outside a browser', () => {
    expect(channelPrefix()).toBe('')
    expect(transportPath('/cstudio/rpc')).toBe('/cstudio/rpc')
    expect(transportUrl('/cstudio/rpc')).toBe('/cstudio/rpc')
  })

  it('prefixes every internal path once the remote channel seat is installed', () => {
    vi.stubGlobal('window', { [CHANNEL_SEAT]: { restore: () => {} } })
    vi.stubGlobal('document', { baseURI: 'https://box.example/prefix/' })
    expect(channelPrefix()).toBe(CHANNEL_PREFIX)
    expect(transportUrl('/cstudio/rpc')).toBe('https://box.example/prefix/remote/cstudio/rpc')
    expect(transportUrl('/cstudio/vendor/monaco/vs/loader.js'))
      .toBe('https://box.example/prefix/remote/cstudio/vendor/monaco/vs/loader.js')
  })

  it('ignores a seat that is not the boot object', () => {
    vi.stubGlobal('window', { [CHANNEL_SEAT]: true })
    expect(channelPrefix()).toBe('')
    expect(transportUrl('/cstudio/rpc')).toBe('/cstudio/rpc')
  })

  it('keeps the desktop protocol when the channel is present', () => {
    vi.stubGlobal('window', { [CHANNEL_SEAT]: {} })
    vi.stubGlobal('document', { baseURI: 'dsh-app://app/' })
    expect(transportUrl('/cstudio/rpc')).toBe('dsh-app://app/remote/cstudio/rpc')
  })

  it('still rejects external paths', () => {
    expect(() => transportUrl('//evil.test/')).toThrow()
    expect(() => transportUrl('https://evil.test/')).toThrow()
  })
})
