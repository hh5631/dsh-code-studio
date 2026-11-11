import React from 'react'
import type { ReleaseCheckResult } from '../../release-check.mjs'
import { transportUrl } from '../../shared/remoteChannel.js'

const RELEASES = 'https://github.com/hh5631/dsh-code-studio/releases'

export function UpdateCheck() {
  const [checking, setChecking] = React.useState(false)
  const [result, setResult] = React.useState<ReleaseCheckResult | null>(null)
  const request = React.useRef<AbortController | null>(null)
  React.useEffect(() => () => { request.current?.abort(); request.current = null }, [])

  async function check() {
    if (request.current) return
    const controller = new AbortController()
    request.current = controller
    const timer = setTimeout(() => controller.abort(), 12_000)
    setChecking(true)
    setResult(null)
    try {
      const response = await fetch(transportUrl('/api/dsh-code-studio/update-check'), {
        credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      })
      if (!response.ok) throw new Error('Update endpoint unavailable')
      const data = await response.json() as ReleaseCheckResult
      if (typeof data?.ok !== 'boolean') throw new Error('Invalid update response')
      if (request.current === controller) setResult(data)
    } catch {
      if (request.current === controller) setResult({ ok: false, current: '', error: '检查失败，请稍后重试，或打开 GitHub 发行页。' })
    } finally {
      clearTimeout(timer)
      if (request.current === controller) { request.current = null; setChecking(false) }
    }
  }

  const status = result?.ok && (result.status === 'available' ? '发现新版' : result.status === 'ahead' ? '当前版本较新' : '已是最新版本')
  return <fieldset className="cstudio-update">
    <legend>插件更新</legend>
    <div className="cstudio-update-row">
      <span role="status">{checking ? '正在检查…' : result?.ok
        ? `当前 v${result.current} · 最新 v${result.latest} · ${status}`
        : result ? (result.current ? `当前 v${result.current} · ` : '') + result.error : '检查 GitHub 上的正式版本'}</span>
      <button type="button" disabled={checking} onClick={() => void check()}>检查更新</button>
    </div>
    {result && <div className="cstudio-update-links">
      {result.ok && result.downloadUrl && <a href={result.downloadUrl} rel="noreferrer" target="_blank">下载安装包</a>}
      <a href={result.ok ? result.releaseUrl : RELEASES} rel="noreferrer" target="_blank">查看发行页</a>
    </div>}
  </fieldset>
}
