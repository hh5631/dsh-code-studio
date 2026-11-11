/** Git unified diff 的行号与修改段。客户端展示和服务端定位使用同一份解析结果。 */
export interface PatchLine {
  text: string
  before?: number
  after?: number
  newline: boolean
}

export type PatchPart =
  | { kind: 'context'; lines: PatchLine[] }
  | { kind: 'change'; before: PatchLine[]; after: PatchLine[]; offset: number }

export interface PatchHunk {
  title: string
  offset: number
  parts: PatchPart[]
}

export const GIT_EDIT_LIMIT = 2 * 1024 * 1024

/** 二进制、合并差异和过大的 diff 保留原始只读展示。 */
export function parseGitPatch(text: string): { editable: boolean; hunks: PatchHunk[] } | null {
  const lines = text.split('\n', 4002)
  if (lines.length >= 4002 || lines.filter(line => line.startsWith('diff --git ')).length !== 1) return null
  if (lines.at(-1) === '') lines.pop()
  let cursor = lines.findIndex(line => line.startsWith('@@ '))
  if (cursor < 0) return null
  const header = lines.slice(0, cursor)
  const editable = header.some(line => /^index [\da-f]+\.\.[\da-f]+ 100(?:644|755)$/.test(line))
    && !header.some(line => /^(?:new file mode|deleted file mode|rename |copy |old mode|new mode)/.test(line))
  const hunks: PatchHunk[] = []
  while (cursor < lines.length) {
    const title = lines[cursor++]
    const range = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(title)
    if (!range) return null
    const beforeCount = Number(range[2] ?? 1), afterCount = Number(range[4] ?? 1)
    let before = Number(range[1]) + (beforeCount === 0 ? 1 : 0)
    let after = Number(range[3]) + (afterCount === 0 ? 1 : 0)
    if (![before, after, beforeCount, afterCount].every(Number.isSafeInteger) || before < 1 || after < 1) return null
    const firstBefore = before, firstAfter = after
    const parts: PatchPart[] = []
    let previous: PatchLine | undefined
    while (cursor < lines.length && !lines[cursor].startsWith('@@ ')) {
      const line = lines[cursor++]
      if (line.startsWith('\\ ') && previous?.newline) {
        previous.newline = false
        continue
      }
      const sign = line[0]
      if (sign !== ' ' && sign !== '-' && sign !== '+') return null
      const row: PatchLine = { text: line.slice(1), newline: true }
      let part = parts.at(-1)
      if (sign === ' ') {
        if (part?.kind !== 'context') { part = { kind: 'context', lines: [] }; parts.push(part) }
        row.before = before++; row.after = after++
        part.lines.push(row)
      } else {
        if (part?.kind !== 'change') { part = { kind: 'change', before: [], after: [], offset: after - 1 }; parts.push(part) }
        if (sign === '-') { row.before = before++; part.before.push(row) }
        else { row.after = after++; part.after.push(row) }
      }
      previous = row
    }
    if (before - firstBefore !== beforeCount || after - firstAfter !== afterCount) return null
    hunks.push({ title, offset: firstAfter - 1, parts })
  }
  return { editable, hunks }
}

export const patchLineText = (line: PatchLine): string => line.newline ? line.text.replace(/\r$/, '') : line.text

export function patchPartText(lines: PatchLine[]): string {
  return lines.map(line => patchLineText(line) + (line.newline ? '\n' : '')).join('')
}

/** 核对完整 hunk 的当前侧，再只拼接选中修改段。其余行保留原始字节对应的文本。 */
export function editGitPatchPart(content: string, hunk: PatchHunk, partIndex: number, replacement?: string): string | null {
  const part = hunk.parts[partIndex]
  if (part?.kind !== 'change') return null
  const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const current = hunk.parts.flatMap(item => item.kind === 'context' ? item.lines : item.after)
  if (hunk.offset + current.length > lines.length) return null
  if (!current.every((line, i) => {
    const disk = lines[hunk.offset + i]
    return line.newline ? disk.endsWith('\n') && disk.replace(/\r?\n$/, '') === patchLineText(line) : disk === line.text
  })) return null

  const before = lines.slice(0, part.offset).join('')
  const after = lines.slice(part.offset + part.after.length).join('')
  const nearby = lines[part.offset] ?? lines[part.offset - 1]
  const sample = nearby?.endsWith('\n') ? nearby : lines.find(line => line.endsWith('\n'))
  const eol = sample?.endsWith('\r\n') ? '\r\n' : '\n'
  // Git 可能按属性把 CRLF 转成 LF；原始补丁可见的换行差异仍照旧侧还原。
  const normalizedEol = current.some((line, i) => line.newline && !line.text.endsWith('\r') && lines[hunk.offset + i].endsWith('\r\n'))
  const middle = replacement === undefined
    ? part.before.map(line => line.text + (line.newline ? normalizedEol && !line.text.endsWith('\r') ? eol : '\n' : '')).join('')
    : replacement.replace(/\r\n|\n/g, eol)
  const headGap = before && middle && !before.endsWith('\n') ? eol : ''
  const tailGap = middle && after && !middle.endsWith('\n') ? eol : ''
  return before + headGap + middle + tailGap + after
}
