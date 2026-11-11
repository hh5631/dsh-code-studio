/**
 * dsh-code-studio host — RPC 分发：类型化方法表替代巨型 switch。
 * 迁移自原 src/index.ts 的 handleRpc，方法名/载荷/错误文案一字不改。
 * 新功能 = shared/rpc.ts 加方法 + 这里加一个 handler，不改其他模块。
 * 作者 ddj 2026-08-20
 */
import { gitBranch, gitDiff, gitDiscard, gitLog, gitStage, gitStatus, gitUnstage } from './git.js'
import type { RpcHandlerMap, RpcMethod, RpcRequestMap, RpcResult } from './shared/rpc.js'
import { binaryMimeOf, SESSION_MISSING_ERROR, SESSION_NO_WORKSPACE_ERROR } from './shared/rpc.js'
import type { Ctx, Session } from './store.js'
import { BINARY_READ_CAP, READ_CAP, policyOf, resolveTarget, resolveTargetIn } from './store.js'
import { cp, mkdir, readFile, rename, rm, stat, writeFile, readdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { Registry, SessionScope } from './registry.js'
import { cwdOfSession, resolveScope, sessionOf } from './registry.js'
import { newSearcher } from './search/orchestrator.js'
import { newContentSearcher } from './search/content.js'
import { listSkillCatalog } from './skillCatalog.js'
import { isSnippetFilePath, snippetsEntries, snippetsList, snippetsRead, snippetsRemove, snippetsSave } from './snippets.js'
import { runtimeOf } from './mcpRuntime.js'
import { listMcp, refreshMcp, removeMcp, saveMcp, toggleMcp } from './mcp.js'
import { listProjects, projectRefresh, projectRemove, projectSave, projectToggle, mcpSnapshot } from './mcpProject.js'
import { normalizeFileOpenTool, FILE_OPEN_DEFAULT, FILE_OPEN_SETTINGS_NS, sectionOf, updateSection } from './fileOpenSettings.js'
import { INTEGRATION_BASE_DEFAULT } from './shared/integration.js'
import { shellMenuRegister, shellMenuRemove, shellMenuStatus } from './integrate.js'
import { unityAdd, unityInstall, unityList, unityRemove } from './unityBridge.js'
import { ackPending, handoffOpen, pendingState, pollPending } from './externalHandoff.js'
import { buildReport } from './compat.js'
import { findProfileDir, readDevForm, setDevForm } from './devForm.js'
import { normalizeRel } from './tree.js'
import { baseNameOf, checkNewName, checkRenameName, isSubPath, joinRelPath, parentRelOf } from './shared/fsNames.js'
import { invalidateIndex, listDirCached } from './treeIndex.js'
import { revealInExplorer } from './reveal.js'
import { dshHome, debugLogFile, pluginLogRoot, uiGlobalsFile, uiStateFile } from './paths.js'
import { readUiState, writeUiState } from './uiState.js'
import { clearDebugLog, debugRecord, isDebugLogName, listDebugLogs, readDebugLog } from './debugLog.js'
import { markActiveSessions, markOfficialFlags, moveOutSessions, planMoveOut, purgeArchive, restoreSession, scanSessionInventory, sessionsArchiveRoot, sessionSizeOf, sidecarSummaryOf, unarchiveOfficial } from './perf.js'
import { patchHasPerfConfig, patchInsertPerfConfig, patchRemovePerfConfig, perfConfigBlock } from './perfPatch.js'
import type { FileVersions } from './fileVersions.js'
import { settingsDocPath } from './settingsDocPath.js'
import { createTextPages } from './textPages.js'

/** Process-local cursor signer; reads must stay on the Host filesystem capability. */
const readTextPage = createTextPages()
/**
 * 无会话期诊断的伪 cwd：冷启动早期本插件客户端就会上报界面状态镜像事件
 * （此时 `sessions` 可能尚未就绪，`requireSession` 会失败），退回本固定值落盘
 * `logs/debug.<hashOf(该值)>.log`，保证「换 origin 后没恢复」这类问题的诊断不丢。
 */
const UI_AUDIT_CWD = 'ui-state'

/** 会话/工作区公共前置：返回 {session,cwd} 或错误文案。 */
async function requireSession(ctx: Ctx, sessionId: string | undefined): Promise<
  { session: Session; cwd: string } | { err: string }
> {
  const session = sessionOf(ctx, sessionId)
  if (!session) return { err: SESSION_MISSING_ERROR }
  const cwd = cwdOfSession(ctx, session)
  if (!cwd) return { err: SESSION_NO_WORKSPACE_ERROR }
  return { session, cwd }
}

/**
 * 片段文件路径解析：命中全局片段目录（~/.dsh/snippets）返回归一化绝对路径，否则 null。
 * 全局片段位于工作区之外，edrv.read / edrv.save 需绕开 resolveTarget 的 cwd 语义直读直写。
 * @author ddj 2026年09月10号
 * @param path 客户端请求路径（绝对路径）
 * @returns 归一化后的绝对路径或 null
 */
function snippetTargetOf(path: string): string | null {
  return isSnippetFilePath(path) ? path.replace(/\\/g, '/') : null
}


/**
 * 返回与当前 settings provider 文档路径精确匹配的授权目标。
 * @author ddj 2026年10月02号
 * @param ctx DSH host 上下文
 * @param path 编辑器请求路径
 * @returns provider 当前配置文档的绝对路径；未匹配返回 null
 */
function settingsTargetOf(ctx: Ctx, path: string): string | null {
  try {
    const settings = ctx.get('settings') as { documentPath?: unknown } | undefined
    return settingsDocPath(settings?.documentPath, path)
  } catch {
    return null
  }
}

/** readTargetOf 成功形态：解析后的目标路径、stat 信息与 fs 服务句柄。 */
interface ReadTargetOk {
  target: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fs: any
  info: { version?: unknown; size?: number }
}

/**
 * 二进制/文本读取共用前置（edrv.read 与 edrv.readBinary）：解析路径 + debugRecord +
 * stat + 文件类型校验 + 32MB 二进制上限，保证两条读通道的错误口径完全一致。
 * @author ddj 2026年09月22号
 * @param ctx DSH 上下文
 * @param sc requireSession 成功结果（session + cwd）
 * @param path 客户端请求路径
 * @returns 成功返回解析目标与 stat；失败返回错误文案（文件不存在时附 resolvedPath）
 */
async function readTargetOf(
  ctx: Ctx,
  sc: SessionScope,
  path: string,
): Promise<ReadTargetOk | { err: string; resolvedPath?: string; code?: 'file-too-large' | 'file-missing' }> {
  const fs = ctx.get('fs')
  if (!fs) return { err: '缺少 fs' }
  try {
    const target = await resolveTargetIn(ctx, sc.cwd, path)
    debugRecord(ctx, sc.cwd, '[DEBUG path.resolve] input=' + String(path ?? '') + ' resolved=' + fs.processPath(target), 'debug')
    const info = await fs.stat(target)
    if (!info) return { err: '文件不存在', resolvedPath: fs.processPath(target), code: 'file-missing' }
    if (info.type !== 'file') return { err: '目标不是文件', resolvedPath: fs.processPath(target) }
    if ((info.size ?? 0) > BINARY_READ_CAP) return { err: '文件过大（>32MB），不支持整文件预览', code: 'file-too-large' }
    return { target, fs, info }
  } catch (error) {
    if (['ENOENT', 'FS_NOT_FOUND'].includes(String((error as { code?: string }).code))) return { err: '文件不存在', code: 'file-missing' }
    return { err: '读取失败：' + String(error) }
  }
}

/**
 * readTargetOf 失败结果 → RPC 错误载荷（文件不存在时保留 resolvedPath 供诊断）。
 * @author ddj 2026年09月22号
 * @param prep readTargetOf 的失败分支
 * @returns { ok:false } 形态载荷
 */
function targetErrOf(prep: { err: string; resolvedPath?: string; code?: 'file-too-large' | 'file-missing' }): { ok: false; error: string; resolvedPath?: string; code?: 'file-too-large' | 'file-missing' } {
  return { ok: false, error: prep.err,
    ...(prep.resolvedPath !== undefined ? { resolvedPath: prep.resolvedPath } : {}),
    ...(prep.code ? { code: prep.code } : {}) }
}

/**
 * 本地文件系统版本令牌（mtime+size）：与 ctx.fs 的不透明版本串用途相同，
 * 仅供全局片段文件（走 node:fs 直读、不经 ctx.fs）在 edrv.read 时回带。
 * @author ddj 2026年09月15号
 * @param info node fs.Stats（stat 失败传 null）
 * @returns 版本令牌；取不到 → 空串（不启用护栏）
 */
function fileVersionOf(info: { mtimeMs?: number; size?: number } | null): string {
  if (!info || typeof info.mtimeMs !== 'number' || typeof info.size !== 'number') return ''
  return info.mtimeMs + ':' + info.size
}

/**
 * 判定错误是否为「读取后文件已被外部修改」（版本守卫拒绝写入）。
 * 不依赖 host fs 的 FsError 类（外置模块，instanceof 不可靠），按错误码与文案双重判定。
 * @author ddj 2026年09月15号
 * @param error 捕获到的异常
 * @returns 是否为版本冲突
 */
function isStaleVersion(error: unknown): boolean {
  const err = error as { code?: unknown; message?: unknown } | null
  if (err && err.code === 'FS_STALE_VERSION') return true
  const message = err && typeof err.message === 'string' ? err.message : String(error)
  return message.includes('changed since it was read')
}

/**
 * 手动保存后让目录缓存失效，不创建或更新差异审查记录。
 * @author ddj 2026年09月22号
 * @param ctx DSH 上下文
 * @param registry 差异记录桶注册表
 * @param sc requireSession 成功结果（session + cwd）
 * @param path 保存的文件路径
 */
async function afterManualSave(
  ctx: Ctx,
  registry: Registry,
  sc: { session: Session; cwd: string },
  path: string,
): Promise<void> {
  // 手动保存后目录树可能变化（新建/删除文件）：父目录+祖先进失效，后台自愈。
  invalidateIndex(ctx, sc.cwd, path)
}

/** 当前活跃会话 id 集合（live sessions，用于移出/恢复护栏）。 */
function activeSessionIds(ctx: Ctx): Set<string> {
  const sessions = ctx.get('sessions')
  if (!sessions || typeof sessions.list !== 'function') return new Set()
  return new Set((sessions.list() as Session[]).map((s) => s.id).filter(Boolean))
}

/** profile patch 文件定位（依赖本插件的 profile，同 devForm）。 */
async function patchFileInfo(ctx: Ctx): Promise<{ profileDir?: string; patchPath?: string }> {
  const profileDir = findProfileDir(ctx)
  if (!profileDir) return {}
  return { profileDir, patchPath: join(profileDir, 'cordis.patch.yml') }
}

/** 最新一次压缩配置备份文件名（cordis.patch.yml.bak-<ts>，按名倒序取新）。 */
async function latestPatchBackup(patchPath: string): Promise<string | undefined> {
  const dir = join(patchPath, '..')
  const base = basename(patchPath)
  const names = await readdir(dir).catch(() => [])
  return names.filter((n) => n.startsWith(base + '.bak-')).sort().reverse()[0]
}

/** 读取设置中的深链基址（缺省/非法回退默认 3080）。 */
export async function integrationBaseUrlOf(ctx: Ctx): Promise<string> {
  const settings = ctx.get('settings')
  const value = sectionOf(settings, FILE_OPEN_SETTINGS_NS)?.value as { integrationBaseUrl?: unknown } | undefined
  const raw = typeof value?.integrationBaseUrl === 'string' ? value.integrationBaseUrl.trim() : ''
  return raw || INTEGRATION_BASE_DEFAULT
}

// --region 文件操作（edrv.fs.*：资源管理器右键的新建/重命名/删除/复制/移动）

/**
 * 文件操作目标解析：工作区相对路径 → 绝对路径，并做工作区边界检查。
 * edrv.fs.* 各方法共用（对齐 edrv.saveBinary 的 contains 护栏口径）。
 * @author ddj 2026年09月22号
 * @param ctx DSH 上下文
 * @param session 当前会话
 * @param rel 工作区相对路径
 * @returns 绝对路径；缺 fs/越界/解析失败返回错误文案
 */
async function fsOpsTarget(ctx: Ctx, session: Session, rel: string): Promise<{ abs: string } | { err: string }> {
  const fs = ctx.get('fs')
  if (!fs) return { err: '缺少 fs' }
  try {
    const target = await resolveTarget(ctx, session, rel)
    const rootTarget = await fs.resolve(policyOf(ctx, session)?.workspaceRoot ?? '.', {})
    if (!fs.contains(rootTarget, target)) return { err: '拒绝操作：目标不在会话工作区内' }
    return { abs: fs.processPath(target) }
  } catch (error) {
    return { err: '路径解析失败：' + String(error) }
  }
}

/**
 * 取异常的系统错误码（EEXIST/EXDEV 等分支判定用）。
 * @author ddj 2026年09月22号
 * @param error 捕获到的异常
 * @returns 错误码；取不到返回空串
 */
function fsErrCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : ''
}

/**
 * 复制/移动共用核心（edrv.fsCopy / edrv.fsMove）：目标目录存在 + 同名拒绝覆盖 +
 * 「不能以自身或其子目录为目标」护栏；move 跨设备（EXDEV）回退「递归复制 + 删除源」。
 * @author ddj 2026年09月22号
 * @param ctx DSH 上下文
 * @param sc requireSession 成功结果（session + cwd）
 * @param args 请求载荷（from / toDir 均为工作区相对路径）
 * @param mode copy = 复制；move = 移动
 * @returns 成功返回 from/to 相对路径；失败返回错误文案
 */
async function fsTransfer(
  ctx: Ctx,
  sc: { session: Session; cwd: string },
  args: { from: string; toDir: string },
  mode: 'copy' | 'move',
): Promise<{ from: string; to: string } | { err: string }> {
  const fromRel = normalizeRel(args.from)
  const toDirRel = normalizeRel(args.toDir)
  if (fromRel === null || fromRel === '' || toDirRel === null) return { err: '路径不合法' }
  if (isSubPath(fromRel, toDirRel)) return { err: '不能以自身或其子目录为目标' }
  const src = await fsOpsTarget(ctx, sc.session, fromRel)
  if ('err' in src) return src
  const dir = await fsOpsTarget(ctx, sc.session, toDirRel)
  if ('err' in dir) return dir
  const dirInfo = await stat(dir.abs).catch(() => null)
  if (!dirInfo || !dirInfo.isDirectory()) return { err: '目标目录不存在' }
  const toRel = joinRelPath(toDirRel, baseNameOf(fromRel))
  const dst = await fsOpsTarget(ctx, sc.session, toRel)
  if ('err' in dst) return dst
  const srcInfo = await stat(src.abs).catch(() => null)
  if (!srcInfo) return { err: '源不存在' }
  if (await stat(dst.abs).catch(() => null)) return { err: '目标目录已存在同名文件或目录' }
  try {
    await transferEntry(src.abs, dst.abs, mode)
  } catch (error) {
    return { err: (mode === 'copy' ? '复制失败：' : '移动失败：') + String(error) }
  }
  invalidateIndex(ctx, sc.cwd, fromRel)
  invalidateIndex(ctx, sc.cwd, toRel)
  return { from: fromRel, to: toRel }
}

/**
 * 单条目复制/移动落盘（文件/目录通用；move 跨设备回退复制+删除源）。
 * @author ddj 2026年09月22号
 * @param absFrom 源绝对路径
 * @param absTo 目标绝对路径
 * @param mode copy = 复制；move = 移动
 */
async function transferEntry(absFrom: string, absTo: string, mode: 'copy' | 'move'): Promise<void> {
  if (mode === 'copy') {
    await cp(absFrom, absTo, { recursive: true, force: false, errorOnExist: true })
    return
  }
  try {
    await rename(absFrom, absTo)
  } catch (error) {
    if (fsErrCode(error) !== 'EXDEV') throw error
    await cp(absFrom, absTo, { recursive: true, force: false, errorOnExist: true })
    await rm(absFrom, { recursive: true })
  }
}

// --endregion

/** 各方法 handler 表（类型由 shared/rpc 的 RpcHandlerMap 约束）。 */
export function buildHandlers(
  ctx: Ctx,
  registry: Registry,
  searcher = newSearcher(ctx),
  contentSearcher = newContentSearcher(ctx),
  lspHandlers?: Partial<RpcHandlerMap>,
  aiHandlers?: Partial<RpcHandlerMap>,
  fileVersions?: FileVersions,
): RpcHandlerMap {
  return {
    // edrv.lsp.* 由 createLspRpc 一次性提供（tracker 跨请求保留），这里并入。
    ...((lspHandlers ?? {}) as RpcHandlerMap),
    // edrv.ai.* 由 createAiRpc 提供（AI 内联补全/模型目录/配置读写），这里并入。
    ...((aiHandlers ?? {}) as RpcHandlerMap),
    /**
     * 界面状态镜像读取：回填换 origin（Web GUI 重启换端口）后丢失的 localStorage 界面状态。
     * 文件缺失/损坏 → 空表（客户端自然不动作）。
     * @author ddj 2026年09月28号
     */
    'cstudio.uiState.get': async (args) => {
      const sc = await resolveScope(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const keys = await readUiState(uiStateFile(sc.cwd))
      const globals = await readUiState(uiGlobalsFile())
      return { ok: true, keys, globals }
    },
    /**
     * 界面状态镜像写入：把客户端改动过的 `cstudio.*` 键增量同步到 host 文件（空补丁不落盘）。
     * 失败时写一条诊断日志（默认静默的客户端 dbg 之外的可查证据），并如实回错误由客户端逐键回退。
     * @author ddj 2026年09月28号 / 2026年09月29号
     */
    'cstudio.uiState.set': async (args) => {
      const sc = await resolveScope(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const tasks: Array<Promise<{ ok: true } | { ok: false; error: string }>> = []
      if (args.keys && Object.keys(args.keys).length) tasks.push(writeUiState(uiStateFile(sc.cwd), args.keys))
      if (args.globals && Object.keys(args.globals).length) tasks.push(writeUiState(uiGlobalsFile(), args.globals))
      const results = await Promise.all(tasks)
      const failed = results.find((item) => !item.ok)
      if (failed && !failed.ok) {
        const keyCount = Object.keys(args.keys ?? {}).length
        const globalCount = Object.keys(args.globals ?? {}).length
        debugRecord(ctx, sc.cwd, '界面状态镜像写入失败: ' + failed.error
          + '（keys=' + keyCount + ' 键, globals=' + globalCount + ' 键）', 'warn')
        return { ok: false, error: failed.error }
      }
      return { ok: true }
    },
    /** @author ddj 2026年10月22号 @param args Read-only request. @returns Bounded official range read, or unsupported on older providers; never bypasses Host IO. */
    'cstudio.textPage': async (args) => {
      const sc = await resolveScope(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err, reason: 'read-failed' }
      try {
        const target = await resolveTargetIn(ctx, sc.cwd, args.path)
        const fs = ctx.get('fs')
        if (typeof fs?.readByteRange !== 'function' || typeof fs.stat !== 'function') return readTextPage(undefined, args)
        // Keys are opaque identities, never decoded into physical paths. Both legacy string and official FsTarget are supported.
        const targetKey = typeof target === 'string' ? target : (target as { targetKey?: unknown }).targetKey
        if (typeof targetKey !== 'string') return readTextPage(undefined, args)
        /** @author ddj 2026年10月22号 @returns Provider metadata used for before/after freshness checks. */
        function statPage() { return fs.stat(target) }
        /** @author ddj 2026年10月22号 @param offset Verified cursor position. @param length Bounded byte count. @returns Bytes through the official provider only. */
        function readRange(offset: number, length: number) { return fs.readByteRange(target, { offset, length }) }
        return readTextPage({ identity: JSON.stringify([sc.cwd, targetKey]), stat: statPage, readRange }, args)
      } catch (error) { return { ok: false, error: '读取失败：' + String(error), reason: 'read-failed' } }
    },
    'cstudio.read': async (args) => {
      const settingsTarget = settingsTargetOf(ctx, args.path)
      if (settingsTarget && args.encoding !== 'base64') {
        try {
          const info = await stat(settingsTarget)
          if (!info.isFile()) return { ok: false, error: '设置配置文件不存在' }
          if (info.size > READ_CAP) return { ok: false, error: '设置配置文件过大（>8MB）' }
          const content = await readFile(settingsTarget, 'utf8')
          return { ok: true, content, size: content.length, version: fileVersionOf(info) }
        } catch (error) {
          return { ok: false, error: '读取设置配置文件失败：' + String(error), resolvedPath: settingsTarget }
        }
      }
      // 全局片段文件（~/.dsh/snippets/*.code-snippets）在工作区之外：直读，不走会话 cwd 解析
      const snippetTarget = snippetTargetOf(args.path)
      if (snippetTarget && args.encoding !== 'base64') {
        try {
          const content = await readFile(snippetTarget, 'utf8')
          // 版本令牌随读带回：客户端据此判断「读后是否被外部改过」（片段文件同理）
          const info = await stat(snippetTarget).catch(() => null)
          return { ok: true, content, size: content.length, version: fileVersionOf(info) }
        } catch (error) {
          return { ok: false, error: '读取片段文件失败：' + String(error), resolvedPath: snippetTarget }
        }
      }
      const sc = await resolveScope(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const prep = await readTargetOf(ctx, sc, args.path)
      if ('err' in prep) return targetErrOf(prep)
      const maxText = typeof args.maxTextBytes === 'number' && Number.isFinite(args.maxTextBytes)
        ? Math.max(512 * 1024, Math.min(READ_CAP, args.maxTextBytes)) : READ_CAP
      if (args.encoding !== 'base64' && (prep.info.size ?? 0) > maxText) return { ok: false, code: 'file-too-large', error: '文件较大，使用分页只读预览' }
      try {
        if (args.encoding === 'base64') {
          // 图片/PDF 等二进制预览：readBytes 无解码、无二进制拒绝；超上限已由 readTargetOf 拦截
          const bytes = await prep.fs.readBytes(prep.target, undefined, BINARY_READ_CAP)
          const content = Buffer.from(bytes).toString('base64')
          return { ok: true, content, size: bytes.byteLength, encoding: 'base64', mime: binaryMimeOf(args.path), version: String(prep.info.version ?? '') }
        }
        if ((prep.info.size ?? 0) > READ_CAP) return { ok: false, error: '文件过大（>8MB），不支持整文件预览', code: 'file-too-large' }
        const content = await prep.fs.readText(prep.target)
        const size = Buffer.byteLength(content, 'utf8')
        if (size > maxText) return { ok: false, code: 'file-too-large', error: '文件较大，使用分页只读预览' }
        return { ok: true, content, size, version: String(prep.info.version ?? '') }
      } catch (error) {
        return { ok: false, error: '读取失败：' + String(error) }
      }
    },
    'cstudio.readBinary': async (args) => {
      // 二进制直读通道（图片/PDF 预览）：与 edrv.read base64 分支共用 readTargetOf 前置，
      // 返回 Uint8Array 信封；routes 接线后以 octet-stream + x-edrv-* 头直出，
      // 未接线时信封被 JSON 化，由 client 探测到后自动回退 base64 路径（见 shared/rpc readBinaryPreview）。
      const sc = await resolveScope(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const prep = await readTargetOf(ctx, sc, args.path)
      if ('err' in prep) return targetErrOf(prep)
      try {
        const bytes = await prep.fs.readBytes(prep.target, undefined, BINARY_READ_CAP)
        return {
          ok: true,
          binary: { bytes, mime: binaryMimeOf(args.path), size: bytes.byteLength, version: String(prep.info.version ?? '') },
        }
      } catch (error) {
        return { ok: false, error: '读取失败：' + String(error) }
      }
    },
    'cstudio.versions': async (args) => {
      // 工作区外的 settings 文档按同一精确授权路径直接观察，其余路径保持工作区版本服务策略。
      const items = []
      const regularPaths: string[] = []
      for (const path of args.paths) {
        const target = settingsTargetOf(ctx, path)
        if (!target) {
          regularPaths.push(path)
          continue
        }
        try {
          const info = await stat(target)
          items.push({ path, version: fileVersionOf(info), size: info.size, type: 'file' as const })
        } catch (error) {
          items.push({ path, version: '', type: 'missing' as const, error: String(error) })
        }
      }
      if (regularPaths.length === 0) return { ok: true, items }
      if (!fileVersions) return { ok: false, error: '文件版本观察器未装配' }
      const regular = await fileVersions.versions({ ...args, paths: regularPaths })
      return { ...regular, items: [...items, ...regular.items] }
    },
    'edrv.save': async (args) => {
      const settingsTarget = settingsTargetOf(ctx, args.path)
      if (settingsTarget) {
        try {
          const info = await stat(settingsTarget)
          const currentRev = fileVersionOf(info)
          if (args.rev && args.rev !== currentRev) return { ok: false, conflict: true, error: '设置配置文件已被外部修改，请先重新加载' }
          if (settingsTargetOf(ctx, args.path) !== settingsTarget) return { ok: false, error: '设置配置文件路径已变化，拒绝保存' }
          await writeFile(settingsTarget, args.content, 'utf8')
          const saved = await stat(settingsTarget).catch(() => null)
          return { ok: true, rev: fileVersionOf(saved) || currentRev }
        } catch (error) {
          return { ok: false, error: '保存设置配置文件失败：' + String(error) }
        }
      }
      // 全局片段文件：直写（工作区外），且不进差异审查（片段变更不是 agent 编辑产物）
      const snippetTarget = snippetTargetOf(args.path)
      if (snippetTarget) {
        try {
          await writeFile(snippetTarget, args.content, 'utf8')
          return { ok: true }
        } catch (error) {
          return { ok: false, error: '保存片段文件失败：' + String(error) }
        }
      }
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const fs = ctx.get('fs')
      if (!fs) return { ok: false, error: '缺少 fs' }
      try {
        const target = await resolveTarget(ctx, sc.session, args.path)
         debugRecord(ctx, sc.cwd, '[DEBUG path.resolve] input=' + String(args.path ?? '') + ' resolved=' + fs.processPath(target), 'debug')
        // 版本守卫（客户端带回上次读取的版本）：文件在读取后被外部改过则拒绝写入，
        // 避免用陈旧缓冲静默覆盖外部改动；客户端未带 rev（旧版/无版本后端）时行为不变。
        const rev = typeof args.rev === 'string' && args.rev ? args.rev : null
        const intent = rev ? { kind: 'replaceIfVersion', version: rev } : undefined
        const outcome = await fs.writeText(target, args.content, intent, void 0, policyOf(ctx, sc.session))
        await afterManualSave(ctx, registry, sc, args.path)
        return { ok: true, rev: outcome?.version ? String(outcome.version) : rev ?? undefined }
      } catch (error) {
        if (isStaleVersion(error)) {
          return { ok: false, conflict: true, error: '文件已被外部修改，请先重新加载（或用编辑器内容覆盖）' }
        }
        return { ok: false, error: '保存失败：' + String(error) }
      }
    },
    'cstudio.saveBinary': async (args) => {
      if (args.encoding !== 'base64') return { ok: false, error: '仅支持 base64 编码' }
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const fs = ctx.get('fs')
      if (!fs) return { ok: false, error: '缺少 fs' }
      try {
        const target = await resolveTarget(ctx, sc.session, args.path)
         debugRecord(ctx, sc.cwd, '[DEBUG path.resolve] input=' + String(args.path ?? '') + ' resolved=' + fs.processPath(target), 'debug')
        const info = await fs.stat(target)
        if (!info || info.type !== 'file') return { ok: false, error: '文件不存在' }
        // fs 服务仅提供文本写（writeText/editText），二进制回写经 node:fs 直写解析后的
        // 真实路径；以工作区边界 + 大小上限 + 用户显式保存动作三重约束兜底（对齐
        // revert.ts deleteCreated 的 contains 用法）。
        const rootTarget = await fs.resolve(policyOf(ctx, sc.session)?.workspaceRoot ?? '.', {})
        if (!fs.contains(rootTarget, target)) return { ok: false, error: '拒绝保存：目标不在会话工作区内' }
        const bytes = Buffer.from(args.content, 'base64')
        if (bytes.byteLength === 0) return { ok: false, error: '内容为空，拒绝写回' }
        if (bytes.byteLength > BINARY_READ_CAP) return { ok: false, error: '内容过大（>32MB），拒绝写回' }
        await writeFile(fs.processPath(target), bytes)
        await afterManualSave(ctx, registry, sc, args.path)
        return { ok: true }
      } catch (error) {
        return { ok: false, error: '二进制保存失败：' + String(error) }
      }
    },
    'cstudio.debug': async (args) => {
      // 诊断日志：client 上报 → debugLog 模块缓冲批量落盘 ~/.dsh/dsh-code-studio/logs/
      // （console 不一定落盘，文件可靠）。只出现在调试开关开启时（client dbg 默认关）。
      const text = String(args.text ?? '')
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) {
        // 会话未就绪（冷启动早期、界面状态镜像水合期）也必须能落盘：否则换 origin 后的
        // 「水合失败/放弃」诊断全部丢失，只剩「界面没恢复」这个不可观测的现象。
        debugRecord(ctx, UI_AUDIT_CWD, text, args.level)
        return { ok: true }
      }
      debugRecord(ctx, sc.cwd, text, args.level)
      return { ok: true }
    },
    'cstudio.dlog.list': async (args) => {
      // 诊断日志清单：日志根下全部 debug.*.log + 当前会话对应文件名（可能尚不存在）
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const files = await listDebugLogs()
      const current = basename(debugLogFile(sc.cwd))
      return { ok: true, root: pluginLogRoot(), files, current }
    },
    'cstudio.dlog.read': async (args) => {
      // 尾部读取：file 缺省读当前会话那份；maxBytes 夹取 [1KB, 512KB]
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const name = isDebugLogName(args.file) ? args.file : basename(debugLogFile(sc.cwd))
      const maxBytes = Math.min(Math.max(args.maxBytes ?? 256 * 1024, 1024), 512 * 1024)
      const read = await readDebugLog(name, maxBytes)
      if (!read) return { ok: false, error: '日志不存在：' + name + '（开启诊断日志并触发一次操作后生成）' }
      return { ok: true, ...read }
    },
    'cstudio.dlog.clear': async (args) => {
      // 清空：file 缺省清当前会话那份；白名单外直接拒绝
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const name = isDebugLogName(args.file) ? args.file : basename(debugLogFile(sc.cwd))
      const cleared = await clearDebugLog(name)
      if (!cleared) return { ok: false, error: '清空失败：日志不存在或名字非法' }
      return { ok: true, name }
    },
    'cstudio.dlog.reveal': async () => {
      // 打开日志根目录（OS 文件管理器；目录形态 → 直接打开）
      const revealed = await revealInExplorer(pluginLogRoot(), true)
      if (!revealed.ok) return { ok: false, error: revealed.error }
      return { ok: true, opened: true }
    },
    'cstudio.searchFiles': async (args) => {
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const result = await searcher.search({ session: sc.session, cwd: sc.cwd, query: args.query, activePaths: [] })
      return { ok: true, ...result }
    },
    'cstudio.searchContent': async (args) => {
      // 工作区内容搜索：rg --json 主路径；provider 失败转错误响应（无 fallback）。
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      try {
        const result = await contentSearcher.search({
          session: sc.session,
          cwd: sc.cwd,
          query: args.query,
          matchCase: args.matchCase,
          wholeWord: args.wholeWord,
          regex: args.regex,
          maxResults: args.maxResults,
          include: args.include,
          exclude: args.exclude,
          force: args.force,
        })
        return { ok: true, ...result }
      } catch (error) {
        return { ok: false, error: '搜索失败：' + String(error) }
      }
    },
    'cstudio.listDir': async (args) => {
      // 目录树（侧边栏文件管理用）：树索引命中直出（内存，0 IO）；失效/force 时
      // 走快路径（resolve + listDirCheap + putIndex）；同路径在途请求去重复用。
      const sc = await resolveScope(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const rel = normalizeRel(args.path)
      if (rel === null) return { ok: false, error: '路径不合法' }
      const res = await listDirCached(ctx, sc.cwd, rel, args.force === true)
      if ('error' in res) return { ok: false, error: res.error }
      return { ok: true, root: res.root, path: rel, entries: res.entries }
    },
    'cstudio.revealInExplorer': async (args) => {
      // 在 OS 文件浏览器中打开/定位路径（树行/编辑器右键菜单用），相对工作区解析。
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const fs = ctx.get('fs')
      if (!fs) return { ok: false, error: '缺少 fs' }
      try {
        const rel = normalizeRel(args.path)
        if (rel === null) return { ok: false, error: '路径不合法' }
        const target = await fs.resolve(rel || '.', { cwd: sc.cwd })
        const info = await fs.stat(target)
        if (!info) return { ok: false, error: '路径不存在' }
        const abs = fs.processPath(target)
        const outcome = await revealInExplorer(abs, info.type === 'directory')
        if (!outcome.ok) return { ok: false, error: outcome.error }
        return { ok: true, revealed: abs }
      } catch (error) {
        return { ok: false, error: '打开失败：' + String(error) }
      }
    },
    'cstudio.fsCreateFile': async (args) => {
      // 新建文件（资源管理器右键「新建文件…」）：空内容独占创建（同名拒绝），
      // 名称可含 a/b.c 嵌套段（父目录按需创建）；名称校验与客户端弹窗共用 shared/fsNames。
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const bad = checkNewName(args.path)
      if (bad) return { ok: false, error: bad }
      const r = await fsOpsTarget(ctx, sc.session, args.path)
      if ('err' in r) return { ok: false, error: r.err }
      try {
        await mkdir(dirname(r.abs), { recursive: true })
        await writeFile(r.abs, '', { flag: 'wx' })
      } catch (error) {
        const code = fsErrCode(error)
        return { ok: false, error: code === 'EEXIST' ? '已存在同名文件或目录' : '新建文件失败：' + String(error) }
      }
      invalidateIndex(ctx, sc.cwd, args.path)
      return { ok: true, path: args.path }
    },
    'cstudio.fsCreateDir': async (args) => {
      // 新建文件夹（资源管理器右键「新建文件夹」）：名称可含嵌套段（父目录按需创建），已存在拒绝。
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const bad = checkNewName(args.path)
      if (bad) return { ok: false, error: bad }
      const r = await fsOpsTarget(ctx, sc.session, args.path)
      if ('err' in r) return { ok: false, error: r.err }
      try {
        await mkdir(dirname(r.abs), { recursive: true })
        await mkdir(r.abs)
      } catch (error) {
        const code = fsErrCode(error)
        return { ok: false, error: code === 'EEXIST' ? '已存在同名文件或目录' : '新建文件夹失败：' + String(error) }
      }
      invalidateIndex(ctx, sc.cwd, args.path)
      return { ok: true, path: args.path }
    },
    'cstudio.fsRename': async (args) => {
      // 重命名（仅名称段、同父目录内）：目标已存在拒绝；名称未变化按幂等成功返回。
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const bad = checkRenameName(args.newName)
      if (bad) return { ok: false, error: bad }
      const fromRel = normalizeRel(args.path)
      if (fromRel === null || fromRel === '') return { ok: false, error: '路径不合法' }
      const toRel = joinRelPath(parentRelOf(fromRel), args.newName)
      if (toRel === fromRel) return { ok: true, from: fromRel, to: fromRel }
      const src = await fsOpsTarget(ctx, sc.session, fromRel)
      if ('err' in src) return { ok: false, error: src.err }
      const dst = await fsOpsTarget(ctx, sc.session, toRel)
      if ('err' in dst) return { ok: false, error: dst.err }
      if (!(await stat(src.abs).catch(() => null))) return { ok: false, error: '源不存在' }
      try {
        await rename(src.abs, dst.abs)
      } catch (error) {
        const code = fsErrCode(error)
        const exists = code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'EPERM'
        return { ok: false, error: exists ? '已存在同名文件或目录' : '重命名失败：' + String(error) }
      }
      invalidateIndex(ctx, sc.cwd, fromRel)
      invalidateIndex(ctx, sc.cwd, toRel)
      return { ok: true, from: fromRel, to: toRel }
    },
    'cstudio.fsDelete': async (args) => {
      // 删除（文件/文件夹递归；「删除/永久删除」共用）：根拒绝；破坏性由客户端确认框把关。
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const rel = normalizeRel(args.path)
      if (rel === null || rel === '') return { ok: false, error: '路径不合法' }
      const r = await fsOpsTarget(ctx, sc.session, rel)
      if ('err' in r) return { ok: false, error: r.err }
      try {
        await rm(r.abs, { recursive: true })
      } catch (error) {
        return { ok: false, error: '删除失败：' + String(error) }
      }
      invalidateIndex(ctx, sc.cwd, rel)
      return { ok: true, path: rel }
    },
    'cstudio.fsCopy': async (args) => {
      // 复制到目标目录（文件/文件夹递归）：同名拒绝覆盖（细节见 fsTransfer）。
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const r = await fsTransfer(ctx, sc, args, 'copy')
      if ('err' in r) return { ok: false, error: r.err }
      return { ok: true, from: r.from, to: r.to }
    },
    'cstudio.fsMove': async (args) => {
      // 移动到目标目录（文件/文件夹）：同名拒绝覆盖（细节见 fsTransfer）。
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const r = await fsTransfer(ctx, sc, args, 'move')
      if ('err' in r) return { ok: false, error: r.err }
      return { ok: true, from: r.from, to: r.to }
    },
    'mcp.list': async () => ({ ok: true, ...listMcp(ctx) }),
    'mcp.snapshot': async () => ({ ok: true, ...mcpSnapshot(ctx) }),
    'mcp.sessionSnapshot': async () => ({ ok: true, ...runtimeOf(ctx).sessionSnapshot() }),
    'mcp.save': async (args) => {
      try { return { ok: true, server: await saveMcp(ctx, args.config) } }
      catch (error) { return { ok: false, error: String(error) } }
    },
    'mcp.remove': async (args) => {
      try { await removeMcp(ctx, args.id); return { ok: true } }
      catch (error) { return { ok: false, error: String(error) } }
    },
    'mcp.toggle': async (args) => {
      try { return { ok: true, server: await toggleMcp(ctx, args.id, args.enabled) } }
      catch (error) { return { ok: false, error: String(error) } }
    },
    'mcp.refresh': async (args) => {
      try { return { ok: true, server: await refreshMcp(ctx, args.id) } }
      catch (error) { return { ok: false, error: String(error) } }
    },
    'mcp.projects': async () => {
      try { return { ok: true, ...await listProjects(ctx) } }
      catch (error) { return { ok: false, error: String(error) } }
    },
    'mcp.projectConnect': async (args) => {
      const runtime = runtimeOf(ctx)
      const agent = [...runtime.agents.keys()].find((owner) => owner.session?.id === args.sessionId)
      if (!agent || runtime.workspace(agent) !== args.workspacePath) return { ok: false, error: '请先打开此项目的活跃会话；不会激活历史会话' }
      try {
        await runtime.connect(agent, args.serverName)
        const project = mcpSnapshot(ctx).projects.find((item) => item.workspacePath === args.workspacePath)!
        return { ok: true, project }
      } catch { return { ok: false, error: '项目 MCP 连接失败，请查看会话状态和 Host 日志' } }
    },
    'mcp.projectSave': async (args) => {
      try { return { ok: true, project: await projectSave(ctx, args.workspacePath, args.serverName, args.config, args.policy) } }
      catch (error) { return { ok: false, error: String(error) } }
    },
    'mcp.projectRemove': async (args) => {
      try { return { ok: true, project: await projectRemove(ctx, args.workspacePath, args.serverName) } }
      catch (error) { return { ok: false, error: String(error) } }
    },
    'mcp.projectToggle': async (args) => {
      try { return { ok: true, project: await projectToggle(ctx, args.workspacePath, args.serverName, args.enabled) } }
      catch (error) { return { ok: false, error: String(error) } }
    },
    'mcp.projectRefresh': async (args) => {
      try { return { ok: true, project: await projectRefresh(ctx, args.workspacePath, args.serverName) } }
      catch (error) { return { ok: false, error: String(error) } }
    },
    'vscode.fileOpenSettingsGet': async () => {
      const settings = ctx.get('settings')
      const section = sectionOf(settings, FILE_OPEN_SETTINGS_NS)
      const value = section?.value as { fileOpenTool?: unknown } | undefined
      return { ok: true, fileOpenTool: normalizeFileOpenTool(value?.fileOpenTool ?? FILE_OPEN_DEFAULT), integrationBaseUrl: await integrationBaseUrlOf(ctx), revision: section?.revision }
    },
    'vscode.settingsDocumentPath': async () => {
      try {
        const settings = ctx.get('settings') as { prepareDocument?: () => Promise<string> } | undefined
        if (typeof settings?.prepareDocument !== 'function') return { ok: false, error: '设置配置文件不可用' }
        const path = await settings.prepareDocument()
        if (typeof path !== 'string' || !path.trim()) return { ok: false, error: '设置配置文件路径为空' }
        return { ok: true, path }
      } catch (error) {
        return { ok: false, error: '准备设置配置文件失败：' + String(error) }
      }
    },
    'vscode.fileOpenSettingsUpdate': async (args) => {
      const settings = ctx.get('settings')
      const patch: Record<string, unknown> = { fileOpenTool: normalizeFileOpenTool(args.fileOpenTool) }
      if (typeof args.integrationBaseUrl === 'string' && args.integrationBaseUrl.trim()) patch.integrationBaseUrl = args.integrationBaseUrl.trim()
      // 冲突自愈（0.1.7 SettingsConflictError 重读重试一次）与形状校验读取统一走 fileOpenSettings 工具
      const result = await updateSection(settings, FILE_OPEN_SETTINGS_NS, patch, args.expectedRevision)
      if (!result.ok) return { ok: false, error: result.error ?? '设置服务不可用' }
      const section = sectionOf(settings, FILE_OPEN_SETTINGS_NS)
      const value = section?.value as { fileOpenTool?: unknown } | undefined
      return { ok: true, fileOpenTool: normalizeFileOpenTool(value?.fileOpenTool), integrationBaseUrl: await integrationBaseUrlOf(ctx), revision: section?.revision }
    },
    'compat': async () => ({ ok: true, report: await buildReport(ctx) }),
    'vscode.devFormGet': async () => ({ ok: true, devForm: readDevForm(ctx) }),
    'vscode.devFormSet': async (args) => {
      try {
        const result = await setDevForm(ctx, args.enabled === true, args.path)
        if (!result.ok) return { ok: false, error: result.error ?? '切换开发形态失败' }
        return { ok: true, devForm: readDevForm(ctx), restart: result.restart }
      } catch (error) {
        return { ok: false, error: String(error) }
      }
    },
    'cstudio.integration.status': async () => {
      try {
        return { ok: true, ...(await shellMenuStatus(ctx, await integrationBaseUrlOf(ctx))) }
      } catch (error) {
        return { ok: false, error: String(error) }
      }
    },
    'cstudio.integration.register': async () => {
      try {
        return { ok: true, ...(await shellMenuRegister(ctx, await integrationBaseUrlOf(ctx))) }
      } catch (error) {
        return { ok: false, error: String(error) }
      }
    },
    'cstudio.integration.unregister': async () => {
      try {
        return { ok: true, ...(await shellMenuRemove(ctx, await integrationBaseUrlOf(ctx))) }
      } catch (error) {
        return { ok: false, error: String(error) }
      }
    },
    'cstudio.unity.list': async () => {
      try {
        return { ok: true, ...(await unityList()) }
      } catch (error) {
        return { ok: false, error: String(error) }
      }
    },
    'cstudio.unity.add': async (args) => {
      try {
        return { ok: true, project: await unityAdd(args.path) }
      } catch (error) {
        return { ok: false, error: String(error) }
      }
    },
    'cstudio.unity.remove': async (args) => {
      try {
        await unityRemove(args.path)
        return { ok: true }
      } catch (error) {
        return { ok: false, error: String(error) }
      }
    },
    'cstudio.unity.install': async (args) => {
      try {
        return { ok: true, project: await unityInstall(args.path, undefined, { ctx, baseUrl: await integrationBaseUrlOf(ctx) }) }
      } catch (error) {
        return { ok: false, error: String(error) }
      }
    },
    'cstudio.externalStat': async (args) => {
      // 深链判型（无会话依赖）：绝对路径直过 resolve；缺失/其他类型归入 missing
      const fs = ctx.get('fs')
      if (!fs) return { ok: false, error: '缺少 fs' }
      try {
        const target = await fs.resolve(args.path)
        const info = await fs.stat(target)
        if (!info || info.type === 'other') return { ok: true, kind: 'missing' }
        return { ok: true, kind: info.type === 'directory' ? 'directory' : 'file' }
      } catch (error) {
        return { ok: false, error: String(error) }
      }
    },
    'cstudio.external.handoff': async (args) => ({
      ok: true,
      ...handoffOpen({ paths: args.paths, line: args.line, column: args.column }),
    }),
    'cstudio.external.pending': async (args) => ({ ok: true, open: pollPending(args) }),
    'cstudio.external.ack': async (args) => ({ ok: true, accepted: ackPending(args) }),
    'cstudio.external.pendingState': async (args) => ({
      ok: true,
      ...pendingState(args.token, args.take === true),
    }),
    'cstudio.perf.inventory': async () => {
      try {
        const home = dshHome()
        const inventory = await scanSessionInventory(home, sessionsArchiveRoot(home))
        const active = activeSessionIds(ctx)
        markActiveSessions(inventory.sessions, active)
        markOfficialFlags(inventory.sessions, ctx)
        return { ok: true, ...inventory, activeIds: [...active] }
      } catch (error) {
        return { ok: false, error: '盘点失败：' + String(error) }
      }
    },
    'cstudio.perf.sessionSize': async (args) => {
      try {
        const size = await sessionSizeOf(dshHome(), args.cwd, args.sessionId ?? '')
        return { ok: true, ...size }
      } catch (error) {
        return { ok: false, error: '读取会话体积失败：' + String(error) }
      }
    },
    'cstudio.perf.movePlan': async (args) => {
      try {
        const home = dshHome()
        const inventory = await scanSessionInventory(home, sessionsArchiveRoot(home))
        markActiveSessions(inventory.sessions, activeSessionIds(ctx))
        const plan = planMoveOut(inventory, { workspaceKey: args.workspaceKey, sessionIds: args.sessionIds, minBytes: args.minBytes, olderThanDays: args.olderThanDays })
        return { ok: true, ...plan }
      } catch (error) {
        return { ok: false, error: '移出规划失败：' + String(error) }
      }
    },
    'cstudio.perf.moveOut': async (args) => {
      try {
        const home = dshHome()
        const items = (args.sessionIds ?? []).map((sessionId) => ({ workspaceKey: args.workspaceKey, sessionId, bytes: 0 }))
        const result = await moveOutSessions(home, sessionsArchiveRoot(home), items, activeSessionIds(ctx), args.dryRun === true)
        return { ok: true, ...result }
      } catch (error) {
        return { ok: false, error: '移出失败：' + String(error) }
      }
    },
    'cstudio.perf.restore': async (args) => {
      try {
        const result = await restoreSession(dshHome(), sessionsArchiveRoot(dshHome()), args.workspaceKey, args.sessionId)
        if (!result.ok) return { ok: false, error: result.error ?? '恢复失败' }
        // 目录搬回后对齐官方归档标志（best-effort：服务缺失/调用失败不影响恢复结果，见 perf.unarchiveOfficial）
        await unarchiveOfficial(ctx, args.sessionId)
        return { ok: true, restored: true }
      } catch (error) {
        return { ok: false, error: '恢复失败：' + String(error) }
      }
    },
    'cstudio.perf.purgeArchive': async (args) => {
      try {
        const result = await purgeArchive(sessionsArchiveRoot(dshHome()), args.olderThanDays)
        return { ok: true, ...result }
      } catch (error) {
        return { ok: false, error: '清除失败：' + String(error) }
      }
    },
    'cstudio.perf.sidecarSummary': async (args) => {
      const sc = await requireSession(ctx, args.sessionId)
      const cwd = 'err' in sc ? null : sc.cwd
      try {
        const summary = await sidecarSummaryOf(ctx, cwd)
        return { ok: true, ...summary }
      } catch (error) {
        return { ok: false, error: '读取侧车摘要失败：' + String(error) }
      }
    },
    'cstudio.perf.configGet': async () => {
      try {
        const { profileDir, patchPath } = await patchFileInfo(ctx)
        const block = perfConfigBlock()
        if (!patchPath) return { ok: true, applied: false, block }
        const text = await readFile(patchPath, 'utf8').catch(() => '')
        const backup = await latestPatchBackup(patchPath)
        return { ok: true, profileDir, patchPath, applied: patchHasPerfConfig(text), block, backup }
      } catch (error) {
        return { ok: false, error: '读取压缩配置失败：' + String(error) }
      }
    },
    'cstudio.perf.configApply': async () => {
      try {
        const { patchPath } = await patchFileInfo(ctx)
        if (!patchPath) return { ok: false, error: '未找到依赖本插件的 profile（检查 DSH_HOME/profiles）' }
        const text = await readFile(patchPath, 'utf8').catch(() => '')
        const backup = patchPath + '.bak-' + Date.now()
        if (text) await writeFile(backup, text, 'utf8')
        await mkdir(join(patchPath, '..'), { recursive: true })
        await writeFile(patchPath, patchInsertPerfConfig(text), 'utf8')
        return { ok: true, applied: true, backup, restart: true }
      } catch (error) {
        return { ok: false, error: '写入压缩配置失败：' + String(error) }
      }
    },
    'cstudio.perf.configUndo': async () => {
      try {
        const { patchPath } = await patchFileInfo(ctx)
        if (!patchPath) return { ok: false, error: '未找到依赖本插件的 profile（检查 DSH_HOME/profiles）' }
        const backup = await latestPatchBackup(patchPath)
        if (backup) {
          const backupPath = join(join(patchPath, '..'), backup)
          const saved = await readFile(backupPath, 'utf8').catch(() => null)
          if (saved !== null) {
            await writeFile(patchPath, saved, 'utf8')
            await rm(backupPath, { force: true }).catch(() => {})
            return { ok: true, restored: true, backup }
          }
        }
        const text = await readFile(patchPath, 'utf8').catch(() => '')
        if (!patchHasPerfConfig(text)) return { ok: false, error: '没有可撤销的压缩配置' }
        await writeFile(patchPath, patchRemovePerfConfig(text), 'utf8')
        return { ok: true, restored: true }
      } catch (error) {
        return { ok: false, error: '撤销压缩配置失败：' + String(error) }
      }
    },
    // ── Git 集成（替代已移除的 SVN；cwd 由客户端按会话作用域传入）──────
    'git.status': async (args) => {
      try {
        const result = await gitStatus(String(args?.cwd ?? ''))
        return result.ok ? { ok: true, root: result.root, changes: result.changes } : result
      } catch (error) {
        return { ok: false, error: '读取 Git 状态失败：' + String(error) }
      }
    },
    'git.diff': async (args) => {
      try {
        const result = await gitDiff(String(args?.cwd ?? ''), String(args?.path ?? ''), args?.staged === true)
        return result.ok ? { ok: true, text: result.text } : result
      } catch (error) {
        return { ok: false, error: '读取差异失败：' + String(error) }
      }
    },
    'git.stage': async (args) => {
      try {
        return await gitStage(String(args?.cwd ?? ''), (args?.paths ?? []).map(String))
      } catch (error) {
        return { ok: false, error: '暂存失败：' + String(error) }
      }
    },
    'git.unstage': async (args) => {
      try {
        return await gitUnstage(String(args?.cwd ?? ''), (args?.paths ?? []).map(String))
      } catch (error) {
        return { ok: false, error: '取消暂存失败：' + String(error) }
      }
    },
    'git.discard': async (args) => {
      try {
        return await gitDiscard(String(args?.cwd ?? ''), (args?.paths ?? []).map(String))
      } catch (error) {
        return { ok: false, error: '丢弃改动失败：' + String(error) }
      }
    },
    'git.log': async (args) => {
      try {
        const result = await gitLog(String(args?.cwd ?? ''), args?.limit ?? 30)
        return result.ok ? { ok: true, commits: result.commits } : result
      } catch (error) {
        return { ok: false, error: '读取提交历史失败：' + String(error) }
      }
    },
    'git.branch': async (args) => {
      try {
        return { ok: true, branch: await gitBranch(String(args?.cwd ?? '')) }
      } catch (error) {
        return { ok: false, error: '读取分支失败：' + String(error) }
      }
    },
    'skills.list': async (args) => {
      try {
        // 只读枚举：不做 workspace 注册校验（读盘无副作用），cwd 由客户端按会话作用域传入
        return { ok: true, ...(await listSkillCatalog(args?.cwd)) }
      } catch (error) {
        return { ok: false, error: '读取技能候选失败：' + String(error) }
      }
    },
    'snippets.list': async () => {
      try {
        return { ok: true, ...(await snippetsList(ctx)) }
      } catch (error) {
        return { ok: false, error: '读取代码片段失败：' + String(error) }
      }
    },
    'snippets.read': async (args) => {
      try {
        return { ok: true, content: await snippetsRead(ctx, args) }
      } catch (error) {
        return { ok: false, error: '读取代码片段失败：' + String(error) }
      }
    },
    'snippets.save': async (args) => {
      try {
        return { ok: true, file: await snippetsSave(ctx, args) }
      } catch (error) {
        return { ok: false, error: '保存代码片段失败：' + String(error) }
      }
    },
    'snippets.remove': async (args) => {
      try {
        await snippetsRemove(ctx, args)
        return { ok: true }
      } catch (error) {
        return { ok: false, error: '删除代码片段失败：' + String(error) }
      }
    },
    'snippets.entries': async (args) => {
      try {
        // 当前会话工作区用于叠加项目片段；会话缺失时仅返回全局片段（不报错，补全仍可用）
        const sc = await requireSession(ctx, args.sessionId)
        const cwd = 'err' in sc ? undefined : sc.cwd
        return { ok: true, ...(await snippetsEntries(ctx, cwd)) }
      } catch (error) {
        return { ok: false, error: '读取代码片段条目失败：' + String(error) }
      }
    },
  }
}

/**
 * 统一入口：按方法分发到 handler 表。
 * @author ddj 2026年08月20号 / 2026年08月26号
 */
export async function handleRpc<M extends RpcMethod>(
  ctx: Ctx,
  registry: Registry,
  method: M,
  args: RpcRequestMap[M],
  searcher = newSearcher(ctx),
  contentSearcher = newContentSearcher(ctx),
  lspHandlers?: Partial<RpcHandlerMap>,
  aiHandlers?: Partial<RpcHandlerMap>,
  fileVersions?: FileVersions,
): Promise<RpcResult<M>> {
  const handlers = buildHandlers(ctx, registry, searcher, contentSearcher, lspHandlers, aiHandlers, fileVersions)
  const handler = Object.hasOwn(handlers, method) ? handlers[method] : undefined
  if (typeof handler !== 'function') return { ok: false, error: '未知方法: ' + String(method) } as RpcResult<M>
  return handler(args)
}
