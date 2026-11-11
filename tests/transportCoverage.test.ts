/**
 * 入口覆盖回归：插件内部 /cstudio 地址必须经 transportUrl 解析（不得裸用 appUrl）。
 * 防止新增入口回退到「本地可达、远程 403」的写法。
 * @author ddj 2026年11月02号
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('../src', import.meta.url))

/** 递归收集目录下的 .ts/.tsx 源文件。 */
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.tsx?$/.test(name)) out.push(full)
  }
  return out
}

describe('transport coverage', () => {
  const files = ['client', 'shared'].flatMap((dir) => sourceFiles(join(SRC, dir)))

  it('never resolves an /cstudio path through plain appUrl', () => {
    const offenders = files
      .filter((file) => /appUrl\(\s*'\/cstudio/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file))
    expect(offenders).toEqual([])
  })

  it('routes every /cstudio entry through the channel-aware resolver', () => {
    const entries = [
      'client/monaco/loader.ts',
      'client/pdf/pdfLoader.ts',
      // client/ui/DiffBadge.ts 已改用内联 SVG 图标，不再加载 /cstudio 网络资源，
      // 故不在「必须经 transportUrl 解析」的清单内（2026-11-10）。
    ]
    for (const entry of entries) {
      expect(readFileSync(join(SRC, entry), 'utf8')).toContain("transportUrl('/cstudio")
    }
    expect(readFileSync(join(SRC, 'shared/rpc.ts'), 'utf8')).toContain('transportUrl(RPC_PATH)')
  })
})
