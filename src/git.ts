/**
 * dsh-code-studio host — Git 集成（替代已移除的 SVN 支持）。
 *
 * 设计取舍：
 * - 直接调用系统 `git` CLI（不引入 npm 依赖）：与用户的 git 版本/配置天然一致，
 *   且能正确处理 worktree / submodule / 中文路径等边缘情况。
 * - 一律用 execFile + 参数数组（不经 shell）：路径与分支名里的空格、引号、
 *   分号等不会被解释，天然免疫命令注入。
 * - 所有导出函数**不抛未捕获异常**：git 未安装、目录不存在、不是仓库等
 *   都转成结构化结果（ok:false + 可读原因），让 UI 能优雅降级。
 *
 * @author dsh-code-studio 2026-11-10
 */
import { execFile } from 'node:child_process'

/** 单条 git 命令的超时（毫秒）。大仓库 status 也可能慢，给足余量但不无限等待。 */
const GIT_TIMEOUT_MS = 15_000
/** 单条 git 命令输出上限（字节）：防止超大 diff 把内存吃穿。 */
const GIT_MAX_BUFFER = 8 * 1024 * 1024

/** 一条工作区变更。 */
export interface GitChange {
  /** 相对仓库根的路径（统一 `/` 分隔）。 */
  path: string
  /** 单字母状态码：M 修改 / A 新增 / D 删除 / R 重命名 / C 复制 / U 冲突 / ? 未跟踪 / ! 忽略。 */
  status: string
  /** 是否已暂存（在 index 里）。 */
  staged: boolean
  /** 重命名/复制前的原路径（仅 R/C 有）。 */
  from?: string
}

/** 命令执行结果（内部用）。 */
interface RunResult {
  ok: boolean
  stdout: string
  stderr: string
  /** 失败原因（ok:false 时给出可读文案）。 */
  error?: string
}

/**
 * 执行一条 git 命令（不经 shell，参数按数组传递）。
 *
 * @author dsh-code-studio 2026-11-10
 * @param cwd 工作目录（仓库根或其子目录）
 * @param args git 子命令与参数
 * @returns 结构化结果（永不抛错）
 */
function runGit(cwd: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    try {
      execFile(
        'git',
        args,
        { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, windowsHide: true, encoding: 'utf8' },
        (error, stdout, stderr) => {
          const out = String(stdout ?? '')
          const err = String(stderr ?? '')
          if (error) {
            const code = (error as NodeJS.ErrnoException).code
            // ENOENT = 系统没装 git；其余按 git 自身的 stderr 说明
            const reason = code === 'ENOENT'
              ? '未找到 git 命令，请先安装 Git 并确保它在 PATH 中'
              : (err.trim() || String(error.message ?? error))
            resolve({ ok: false, stdout: out, stderr: err, error: reason })
            return
          }
          resolve({ ok: true, stdout: out, stderr: err })
        },
      )
    } catch (error) {
      resolve({ ok: false, stdout: '', stderr: '', error: String(error) })
    }
  })
}

/**
 * 判断目录是否为 git 仓库（含子目录场景：向上查找）。
 *
 * @author dsh-code-studio 2026-11-10
 * @param cwd 工作目录
 * @returns 仓库根路径；不是仓库返回 null
 */
export async function gitRootOf(cwd: string): Promise<string | null> {
  const res = await runGit(cwd, ['rev-parse', '--show-toplevel'])
  if (!res.ok) return null
  const root = res.stdout.trim()
  return root ? root : null
}

/**
 * 解析 `git status --porcelain=v1 -z` 的输出。
 *
 * 格式：每个条目是 `XY <path>`，条目之间用 NUL 分隔；
 * 重命名/复制条目额外跟一个 NUL 分隔的原路径。
 * X = 暂存区状态，Y = 工作区状态，`?` = 未跟踪，`!` = 被忽略（默认不输出）。
 *
 * @author dsh-code-studio 2026-11-10
 * @param raw git status 的原始输出（-z 模式）
 * @returns 变更列表
 */
export function parseStatus(raw: string): GitChange[] {
  const changes: GitChange[] = []
  const parts = raw.split('\0')
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i]
    if (!entry || entry.length < 4) continue
    const x = entry[0]
    const y = entry[1]
    const path = entry.slice(3)
    if (!path) continue
    // 重命名/复制：下一条是原路径
    let from: string | undefined
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      const next = parts[i + 1]
      if (next) { from = next; i += 1 }
    }
    // 同一文件可能同时有暂存与未暂存改动 → 拆成两条，让 UI 分别展示
    if (x !== ' ' && x !== '?') {
      changes.push({ path, status: x, staged: true, ...(from ? { from } : {}) })
    }
    if (y !== ' ' && y !== '?') {
      changes.push({ path, status: y, staged: false, ...(from ? { from } : {}) })
    }
    if (x === '?') {
      changes.push({ path, status: '?', staged: false })
    }
    if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) {
      // 冲突：用 U 统一表示（避免同一路径出现重复的 A/D 条目）
      if (!changes.some((c) => c.path === path && c.status === 'U')) {
        changes.push({ path, status: 'U', staged: false })
      }
    }
  }
  return changes
}

/**
 * 读取工作区变更列表。
 *
 * @author dsh-code-studio 2026-11-10
 * @param cwd 工作目录
 * @returns 变更列表与仓库根；不是仓库或 git 不可用时 ok:false
 */
export async function gitStatus(cwd: string): Promise<{ ok: true; root: string; changes: GitChange[] } | { ok: false; error: string }> {
  const root = await gitRootOf(cwd)
  if (!root) return { ok: false, error: '当前目录不是 Git 仓库' }
  const res = await runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  if (!res.ok) return { ok: false, error: res.error ?? '读取 Git 状态失败' }
  return { ok: true, root, changes: parseStatus(res.stdout) }
}

/**
 * 读取单个文件的差异文本。
 *
 * @author dsh-code-studio 2026-11-10
 * @param cwd 工作目录
 * @param path 文件路径（相对仓库根或绝对路径）
 * @param staged 是否读取暂存区（false = 工作区 vs 暂存区）
 * @returns 差异文本；失败返回 ok:false
 */
export async function gitDiff(cwd: string, path: string, staged: boolean): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const root = await gitRootOf(cwd)
  if (!root) return { ok: false, error: '当前目录不是 Git 仓库' }
  const args = ['diff', '--no-color', '--no-ext-diff', ...(staged ? ['--cached'] : []), '--', path]
  const res = await runGit(root, args)
  if (!res.ok) return { ok: false, error: res.error ?? '读取差异失败' }
  return { ok: true, text: res.stdout }
}

/**
 * 暂存指定文件（`git add`）。
 *
 * @author dsh-code-studio 2026-11-10
 * @param cwd 工作目录
 * @param paths 文件路径列表
 * @returns 是否成功
 */
export async function gitStage(cwd: string, paths: string[]): Promise<{ ok: true } | { ok: false; error: string }> {
  const root = await gitRootOf(cwd)
  if (!root) return { ok: false, error: '当前目录不是 Git 仓库' }
  if (!paths.length) return { ok: true }
  const res = await runGit(root, ['add', '--', ...paths])
  return res.ok ? { ok: true } : { ok: false, error: res.error ?? '暂存失败' }
}

/**
 * 取消暂存指定文件（`git restore --staged`，兼容旧 git 的 `reset HEAD`）。
 *
 * @author dsh-code-studio 2026-11-10
 * @param cwd 工作目录
 * @param paths 文件路径列表
 * @returns 是否成功
 */
export async function gitUnstage(cwd: string, paths: string[]): Promise<{ ok: true } | { ok: false; error: string }> {
  const root = await gitRootOf(cwd)
  if (!root) return { ok: false, error: '当前目录不是 Git 仓库' }
  if (!paths.length) return { ok: true }
  const res = await runGit(root, ['restore', '--staged', '--', ...paths])
  if (res.ok) return { ok: true }
  // 老版本 git 没有 restore：退回 reset HEAD
  const fallback = await runGit(root, ['reset', 'HEAD', '--', ...paths])
  return fallback.ok ? { ok: true } : { ok: false, error: fallback.error ?? res.error ?? '取消暂存失败' }
}

/**
 * 丢弃工作区改动（`git restore`，**破坏性**）。
 *
 * 注意：未跟踪文件不会被删除（那是 `clean` 的职责，风险更高，此处不提供）。
 *
 * @author dsh-code-studio 2026-11-10
 * @param cwd 工作目录
 * @param paths 文件路径列表
 * @returns 是否成功
 */
export async function gitDiscard(cwd: string, paths: string[]): Promise<{ ok: true } | { ok: false; error: string }> {
  const root = await gitRootOf(cwd)
  if (!root) return { ok: false, error: '当前目录不是 Git 仓库' }
  if (!paths.length) return { ok: true }
  const res = await runGit(root, ['restore', '--', ...paths])
  if (res.ok) return { ok: true }
  const fallback = await runGit(root, ['checkout', '--', ...paths])
  return fallback.ok ? { ok: true } : { ok: false, error: fallback.error ?? res.error ?? '丢弃改动失败' }
}

/**
 * 读取最近提交（`git log --oneline`）。
 *
 * @author dsh-code-studio 2026-11-10
 * @param cwd 工作目录
 * @param limit 条数上限（默认 30，最大 200）
 * @returns 提交列表（hash + subject）
 */
export async function gitLog(cwd: string, limit = 30): Promise<{ ok: true; commits: Array<{ hash: string; subject: string }> } | { ok: false; error: string }> {
  const root = await gitRootOf(cwd)
  if (!root) return { ok: false, error: '当前目录不是 Git 仓库' }
  const n = Math.max(1, Math.min(200, Math.round(Number(limit) || 30)))
  const res = await runGit(root, ['log', '--oneline', '--no-color', '-n', String(n)])
  if (!res.ok) return { ok: false, error: res.error ?? '读取提交历史失败' }
  const commits = res.stdout.split('\n').filter(Boolean).map((line) => {
    const at = line.indexOf(' ')
    return at < 0 ? { hash: line, subject: '' } : { hash: line.slice(0, at), subject: line.slice(at + 1) }
  })
  return { ok: true, commits }
}

/**
 * 读取当前分支名（detached HEAD 时返回短 hash）。
 *
 * @author dsh-code-studio 2026-11-10
 * @param cwd 工作目录
 * @returns 分支名；不是仓库返回 null
 */
export async function gitBranch(cwd: string): Promise<string | null> {
  const root = await gitRootOf(cwd)
  if (!root) return null
  const res = await runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!res.ok) return null
  const name = res.stdout.trim()
  return name && name !== 'HEAD' ? name : null
}
