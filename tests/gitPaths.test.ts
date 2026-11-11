import { describe, expect, it } from 'vitest'
import { absolutePath, gitDecorations, normalizedPath, repositoryDirectory } from '../src/client/state/gitPaths.js'

describe('Git 状态映射到原生文件树', () => {
  it('父工作区中的仓库按实际根路径标色，目录聚合后代状态', () => {
    const colors = gitDecorations('/workspace/project', [
      { path: 'src/a.ts', status: 'M', staged: false }, { path: 'new.md', status: '?', staged: false },
    ])
    expect(colors.get(absolutePath('/workspace', 'project/src/a.ts'))).toBe('modified')
    expect(colors.get('/workspace/project/src')).toBe('modified')
    expect(colors.get('/workspace/project/new.md')).toBe('added')
    expect(colors.get('/workspace/other/src/a.ts')).toBeUndefined()
  })
  it('同一文件同时有暂存与未暂存修改时，冲突优先，干净文件不染色', () => {
    const colors = gitDecorations('/repo', [
      { path: 'a.ts', status: 'A', staged: true }, { path: 'a.ts', status: 'M', staged: false },
      { path: 'b.ts', status: 'M', staged: true }, { path: 'b.ts', status: 'U', staged: false },
    ])
    expect(colors.get('/repo/a.ts')).toBe('modified')
    expect(colors.get('/repo/b.ts')).toBe('conflict')
    expect(colors.get('/repo/clean.ts')).toBeUndefined()
  })
  it('重命名与删除使用各自的状态色', () => {
    const colors = gitDecorations('/repo', [{ path: 'new.ts', from: 'old.ts', status: 'R', staged: true }, { path: 'gone.ts', status: 'D', staged: false }])
    expect(colors.get('/repo/new.ts')).toBe('renamed')
    expect(colors.get('/repo/gone.ts')).toBe('deleted')
    expect(colors.get('/repo/old.ts')).toBeUndefined()
  })
  it('Windows 路径大小写和分隔符匹配，POSIX 路径保留大小写', () => {
    const colors = gitDecorations('C:\\Workspace\\Repo', [{ path: 'Src/Test.ts', status: 'M', staged: false }])
    expect(colors.get(absolutePath('c:/workspace', 'REPO/src/test.ts'))).toBe('modified')
    expect(normalizedPath('/repo/A.ts')).not.toBe(normalizedPath('/repo/a.ts'))
    expect(repositoryDirectory('/workspace', 'project/src/a.ts')).toBe('/workspace/project/src')
    expect(repositoryDirectory('/workspace', '/other/a.ts')).toBe('/other')
  })
})
