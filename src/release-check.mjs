/** Read-only update checks for the hh5631 DSH packages. No API token or asset download. */
import { readFileSync } from 'node:fs'

const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
function parts(version) {
  const match = typeof version === 'string' && stable.exec(version)
  const values = match ? match.slice(1).map(Number) : []
  return values.length === 3 && values.every(Number.isSafeInteger) ? values : null
}

export function createReleaseChecker({ name, version }, request = fetch) {
  if (!/^dsh-[a-z0-9-]+$/.test(name) || !parts(version)) throw new Error('Invalid plugin package metadata')
  const repo = `https://github.com/hh5631/${name}`
  const releases = `${repo}/releases`
  const current = parts(version)
  let cached, expires = 0, pending

  async function check() {
    const options = { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(8000) }
    const latest = await request(`${releases}/latest`, options)
    const tagPath = `/hh5631/${name}/releases/tag/`
    const location = new URL(latest.headers.get('location') || '', `${releases}/latest`)
    const tag = location.pathname.startsWith(tagPath) ? location.pathname.slice(tagPath.length) : ''
    const next = tag.startsWith('v') ? parts(tag.slice(1)) : null
    if (latest.status < 300 || latest.status >= 400 || location.origin !== 'https://github.com' || !next) {
      return { ok: false, current: version, error: 'GitHub 暂未返回有效的正式版本，请稍后重试。' }
    }
    const difference = next.map((number, i) => number - current[i]).find(number => number !== 0) ?? 0
    const status = difference > 0 ? 'available' : difference < 0 ? 'ahead' : 'current'
    let downloadUrl = null
    if (status === 'available') {
      const url = `${releases}/download/${tag}/${name}.tgz`
      try {
        const asset = await request(url, options)
        const target = new URL(asset.headers.get('location') || '', url)
        if (asset.ok || (asset.status >= 300 && asset.status < 400 && target.origin === 'https://release-assets.githubusercontent.com')) downloadUrl = url
      } catch { /* The release page is still available if asset lookup fails. */ }
    }
    return { ok: true, current: version, latest: tag.slice(1), status, releaseUrl: `${releases}/tag/${tag}`, downloadUrl }
  }

  return () => {
    if (Date.now() < expires && cached) return Promise.resolve(cached)
    if (!pending) {
      pending = check().catch(() => ({ ok: false, current: version, error: '无法连接 GitHub，请稍后重试。' }))
        .then(result => {
          cached = result
          expires = Date.now() + (result.ok ? 60_000 : 15_000)
          return result
        }).finally(() => { pending = undefined })
    }
    return pending
  }
}

/** Use the DSH Connection owner-only route; a non-Web Host can omit the capability. */
export function installReleaseCheck(ctx, manifestUrl) {
  if (typeof ctx.inject !== 'function') return
  let name, check
  try {
    const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'))
    name = manifest.name
    check = createReleaseChecker(manifest)
  } catch { return }
  ctx.inject(['connection'], scope => {
    if (typeof scope.connection?.fetch?.register !== 'function') return
    scope.effect(() => scope.connection.fetch.register({
      path: `/api/${name}/update-check`, methods: ['GET'], requestBody: 'buffered',
      fetch: async () => Response.json(await check(), { headers: { 'cache-control': 'no-store' } }),
    }), `${name}: update check`)
  })
}
