import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildHandlers } from '../src/rpc.js'
import { editGitPatchPart, parseGitPatch } from '../src/shared/gitPatch.js'

const header = 'diff --git a/example b/example\nindex 1234567..abcdef0 100644\n--- a/example\n+++ b/example\n'

describe('Git 修改段', () => {
  it('保留 CRLF 文件中的其他段，仍可还原 Git 可见的换行差异', () => {
    const patch = parseGitPatch(header + '@@ -1,3 +1,3 @@\n keep\r\n-old\n+new\r\n end\r\n')!
    expect(editGitPatchPart('keep\r\nnew\r\nend\r\n', patch.hunks[0], 1)).toBe('keep\r\nold\nend\r\n')
    expect(editGitPatchPart('keep\r\nnew\r\nend\r\n', patch.hunks[0], 1, 'one\ntwo')).toBe('keep\r\none\r\ntwo\r\nend\r\n')
    expect(editGitPatchPart('changed\r\nnew\r\nend\r\n', patch.hunks[0], 1)).toBeNull()
  })

  it('在空文件还原删除段时正确处理零行范围和无末尾换行', () => {
    const patch = parseGitPatch(header + '@@ -1 +0,0 @@\n-old\n\\ No newline at end of file\n')!
    expect(editGitPatchPart('', patch.hunks[0], 0)).toBe('old')
  })

  it('真实 Git 补丁只写选中段，保留同一 hunk 其他改动、暂存区和同名通配路径', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cstudio-git-patch-'))
    try {
      const cwd = await realpath(dir)
      const git = (...args: string[]) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      const path = '[a].txt', file = join(cwd, path)
      const base = 'head\nfirst\nkeep\nsecond\ntail\n'
      const staged = base.replace('head', 'staged')
      const working = staged.replace('first', 'FIRST').replace('second', 'SECOND')
      git('init', '-q')
      await writeFile(file, base)
      await writeFile(join(cwd, 'a.txt'), 'another\n')
      git('add', '--', '.')
      git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base')
      await writeFile(file, staged)
      git('--literal-pathspecs', 'add', '--', path)
      await writeFile(file, working)
      await writeFile(join(cwd, 'a.txt'), 'another change\n')

      const versionOf = async (name: string) => createHash('sha256').update(await readFile(name)).digest('hex')
      const fs = {
        resolve: async (name: string) => resolve(cwd, name),
        stat: async (name: string) => ({ type: 'file', version: await versionOf(name) }),
        readBytes: readFile,
        writeText: async (name: string, text: string, expected: { kind: string; version: string }) => {
          if (expected.kind !== 'replaceIfVersion' || expected.version !== await versionOf(name)) throw Object.assign(new Error('stale'), { code: 'FS_STALE_VERSION' })
          await writeFile(name, text)
        },
      }
      const session = { id: 'session', header: { cwd } }
      const handlers = buildHandlers({ get: (name: string) => name === 'sessions' ? { get: () => session } : name === 'fs' ? fs : undefined }, new Map())
      const args = { cwd, path, sessionId: session.id }
      const diff = await handlers['git.diff']({ ...args, staged: false })
      if (!diff.ok || !diff.revision) throw new Error('Expected editable diff')
      expect(diff.text).not.toContain('another change')
      const edit = { ...args, hunk: 0, part: 1, revision: diff.revision }
      expect(await handlers['git.editPart'](edit)).toEqual({ ok: true })
      expect(await readFile(file, 'utf8')).toBe(staged.replace('second', 'SECOND'))
      expect(await handlers['git.editPart']({ ...edit, replacement: 'stale\n' })).toMatchObject({ ok: false })

      const refreshed = await handlers['git.diff']({ ...args, staged: false })
      if (!refreshed.ok || !refreshed.revision) throw new Error('Expected updated revision')
      expect(await handlers['git.editPart']({ ...edit, revision: refreshed.revision, replacement: 'replaced\nextra' })).toEqual({ ok: true })
      expect(await readFile(file, 'utf8')).toBe(staged.replace('second', 'replaced\nextra'))
      expect(git('show', ':' + path)).toBe(staged)
      expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe('another change\n')
      expect(await handlers['git.diff']({ ...args, staged: true })).toMatchObject({ ok: true, revision: undefined })

      // 仓库可从会话的子目录读取，但不准写子目录之外的文件。
      session.header.cwd = join(cwd, 'workspace')
      await mkdir(session.header.cwd)
      expect(await handlers['git.editPart']({ ...edit, revision: refreshed.revision })).toMatchObject({ ok: false, error: '此文件不支持分段编辑' })
    } finally { await rm(dir, { force: true, recursive: true }) }
  })
})
