import type { GitChange } from '../../git.js'

export type GitTone = 'modified' | 'added' | 'deleted' | 'renamed' | 'conflict'
export function normalizedPath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/$/, '')
  return /^(?:[a-z]:\/|\/\/)/i.test(normalized) ? normalized.toLowerCase() : normalized
}
export function absolutePath(base: string, path: string): string {
  return normalizedPath(/^(?:\/|[a-z]:[\\/])/i.test(path) ? path : base.replace(/[\\/]+$/, '') + '/' + path)
}
export function repositoryDirectory(base: string | null | undefined, path: string | null | undefined): string {
  if (!path) return base || ''
  if (!base && !/^(?:\/|[a-z]:[\\/])/i.test(path)) return ''
  const file = absolutePath(base || '', path)
  return file.slice(0, file.lastIndexOf('/')) || base || '/'
}
export function gitTone(status: string): GitTone {
  if (status === 'U') return 'conflict'
  if (status === 'D') return 'deleted'
  if (status === 'A' || status === '?') return 'added'
  if (status === 'R' || status === 'C') return 'renamed'
  return 'modified'
}

/** 仓库相对路径映射回工作区文件树，目录聚合后代状态，冲突优先。 */
export function gitDecorations(root: string, changes: GitChange[]): Map<string, GitTone> {
  const values = new Map<string, GitTone>()
  const ranks: Record<GitTone, number> = { added: 1, renamed: 2, modified: 3, deleted: 4, conflict: 5 }
  const boundary = normalizedPath(root)
  for (const change of changes) {
    const tone = gitTone(change.status)
    let path = absolutePath(root, change.path)
    if (path !== boundary && !path.startsWith(boundary + '/')) continue
    while (path === boundary || path.startsWith(boundary + '/')) {
      const previous = values.get(path)
      if (!previous || ranks[tone] > ranks[previous]) values.set(path, tone)
      if (path === boundary) break
      path = path.slice(0, path.lastIndexOf('/'))
    }
  }
  return values
}
