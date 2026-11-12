/** 扩展名 → 编辑器语言 ID（常见语言；未知回退 plaintext）。 */
export const LANG_BY_EXT: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  json: 'json', jsonc: 'json', md: 'markdown', markdown: 'markdown', mdx: 'mdx',
  css: 'css', scss: 'scss', less: 'less', html: 'html', htm: 'html', vue: 'html', xml: 'xml',
  yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini',
  py: 'python', sh: 'shell', bash: 'shell', zsh: 'shell', ps1: 'powershell',
  lua: 'lua', java: 'java', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
  cs: 'csharp', go: 'go', rs: 'rust', rb: 'ruby', php: 'php', sql: 'sql',
  swift: 'swift', kt: 'kotlin', kts: 'kotlin', dart: 'dart', dockerfile: 'dockerfile',
  // 工程/配置文件（拿到正确语法分色，而非 plaintext）
  csproj: 'xml', props: 'xml', targets: 'xml', plist: 'xml',
  lua51: 'lua', luac: 'lua',
  v: 'verilog', vh: 'verilog', sv: 'systemverilog', svh: 'systemverilog',
  tcl: 'tcl', xdc: 'tcl', sdc: 'tcl', ucf: 'tcl',
  gitattributes: 'ini', editorconfig: 'ini', env: 'ini', properties: 'ini',
  json5: 'jsonc', log: 'plaintext', txt: 'plaintext',
  // 代码片段文件按 JSON 高亮（VS Code 同款：.code-snippets 是带注释的 JSON）
  'code-snippets': 'json',
}

/**
 * 路径 → 编辑器语言 ID：取 basename 扩展名（dockerfile/Dockerfile 特判）。
 * @author ddj 2026年08月20号
 * @param path 文件路径
 * @returns language id
 */
export function langOf(path: string) {
  const base = String(path || '').split(/[\\/]/).pop() || ''
  if (/^dockerfile$/i.test(base)) return 'dockerfile'
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return 'plaintext'
  return LANG_BY_EXT[base.slice(dot + 1).toLowerCase()] ?? 'plaintext'
}

/** 片段文件后缀（判断「文件自身是片段文件」而非普通源码）。 */
const SNIPPET_FILE_SUFFIX = '.code-snippets'

/**
 * 片段文件 → 它绑定的语言 id（VS Code 文件名约定 `<language>.code-snippets`）。
 *
 * 为什么不能直接用 {@link langOf}：`.code-snippets` 本身在 LANG_BY_EXT 里映射为 json
 * （编辑片段文件时要按 JSON 高亮），于是 langOf('lua.code-snippets') 会得到 'json' 而不是
 * 'lua' —— 曾导致「新建」默认文件名被算成 `json.code-snippets`。故这里按片段命名约定
 * 单独解析：去掉 `.code-snippets` 后缀取语言前缀。
 *
 * @author ddj 2026年09月10号
 * @param path 片段文件路径
 * @returns 语言 id（`global.code-snippets` / 无法识别 → 空串 = 全语言）
 */
export function snippetLanguageOf(path: string) {
  const base = String(path || '').split(/[\\/]/).pop() || ''
  if (!base.toLowerCase().endsWith(SNIPPET_FILE_SUFFIX)) return langOf(path)
  const lang = base.slice(0, -SNIPPET_FILE_SUFFIX.length).toLowerCase()
  return lang === 'global' ? '' : lang
}
