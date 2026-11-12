import { fileUriToPath, type LspLocation } from '../shared/lsp.js'

/** Resolve workspace locations without losing absolute targets outside the workspace. */
export function targetOpenPath({ uri, root }: Pick<LspLocation, 'uri' | 'root'>): string {
  let target = uri
  if (uri.startsWith('file://')) {
    try { target = fileUriToPath(uri) } catch { return '' }
  }
  target = target.replace(/\\/g, '/')
  const base = root?.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!base) return target
  const windows = /^[A-Za-z]:\/|^\/\//.test(base)
  const actual = windows ? target.toLowerCase() : target
  const prefix = windows ? base.toLowerCase() : base
  return actual.startsWith(prefix + '/') ? target.slice(base.length + 1) : target
}
