import React from 'react'
import { parseGitPatch, patchLineText, patchPartText, type PatchLine, type PatchPart } from '../../shared/gitPatch.js'
import { emitFileChanged } from '../events.js'
import { loadMonaco } from '../monaco/loader.js'
import { rpc } from '../rpc.js'
import { absolutePath } from '../state/gitPaths.js'
import { minimalWorkspace } from '../state/minimalWorkspace.js'
import { workspaceScopeOf } from '../state/scopeStore.js'
import { StudioIcon } from './StudioIcon.js'
import {
  anchorRowOf, changeInfoOf, groupedPartsOf, splitRowsOf, unifiedRowsOf,
  type DiffMode, type DiffTone, type SplitRow,
} from './diffLayout.js'
import '../styles/git-diff.css'

interface Props {
  cwd: string
  path: string
  staged: boolean
  sessionId?: string
  workspaceRoot?: string | null
  onClose(): void
  onApplied?(path: string): void
}
type Selection = { hunk: number; part: number }
type ChangePart = Extract<PatchPart, { kind: 'change' }>
let preferredMode: DiffMode = 'unified'

function LineText({ line }: { line?: PatchLine }) {
  return <code>{line && patchLineText(line)}{line && !line.newline && <span className="cstudio-diff-eof" title="文件末尾无换行">↵</span>}</code>
}

/** 图标工具按钮：统一 title/aria-label/disabled 语义，避免纯图标按钮丢失可访问名。 */
function IconButton({ label, icon, onClick, disabled, pressed, variant }: {
  label: string; icon: React.ComponentProps<typeof StudioIcon>['name']
  onClick(): void; disabled?: boolean; pressed?: boolean; variant?: 'revert'
}) {
  return <button type="button" className={'cstudio-diff-icon-btn' + (variant ? ` cstudio-diff-${variant}` : '')}
    title={label} aria-label={label} aria-pressed={pressed} disabled={disabled} onClick={onClick}>
    <StudioIcon name={icon} />
  </button>
}

/** 单栏行：行号 → 增删符 → 代码，左侧留一条细色带标记该行归属。 */
function UnifiedRow({ line, tone }: { line: PatchLine; tone: DiffTone }) {
  return <div className="cstudio-diff-row cstudio-diff-unified" data-tone={tone}>
    <span className="cstudio-diff-number">{line.before}</span>
    <span className="cstudio-diff-number">{line.after}</span>
    <span className="cstudio-diff-sign" aria-hidden="true">{tone === 'add' ? '+' : tone === 'remove' ? '−' : ''}</span>
    <LineText line={line} />
  </div>
}

/** 双栏单元格：行号 → 增删符 → 代码；空隙格用斜纹底表明「此侧无对应行」。 */
function SplitCell({ line, tone, gap, side }: { line?: PatchLine; tone: DiffTone; gap?: 'before' | 'after'; side: 'before' | 'after' }) {
  return <div className="cstudio-diff-cell" data-tone={tone} data-gap={gap || undefined} data-side={side}>
    <span className="cstudio-diff-number">{side === 'before' ? line?.before : line?.after}</span>
    <span className="cstudio-diff-sign" aria-hidden="true">{tone === 'add' ? '+' : tone === 'remove' ? '−' : ''}</span>
    <LineText line={line} />
  </div>
}

/** 双栏行：左右单元格 + 中央沟槽（沟槽内可放 VSCode 式还原箭头）。 */
function SplitRowView({ row, gutter }: { row: SplitRow; gutter?: React.ReactNode }) {
  return <div className="cstudio-diff-row cstudio-diff-split" data-changed={row.changed || undefined}>
    <SplitCell line={row.before} tone={row.beforeTone} gap={row.gap === 'before' ? 'before' : undefined} side="before" />
    <div className="cstudio-diff-gutter">{gutter}</div>
    <SplitCell line={row.after} tone={row.afterTone} gap={row.gap === 'after' ? 'after' : undefined} side="after" />
  </div>
}

function PartRows({ part, mode, selection, clustered, onRevert, canEdit, busy }: {
  part: PatchPart; mode: DiffMode; selection: Selection; clustered: boolean
  onRevert(selection: Selection): void; canEdit: boolean; busy: boolean
}) {
  const anchor = part.kind === 'change' ? anchorRowOf(part) : -1
  const rows = mode === 'unified' ? unifiedRowsOf(part) : splitRowsOf(part)
  const info = part.kind === 'change' ? changeInfoOf(part) : null
  return <div className="cstudio-diff-part" data-kind={part.kind} data-clustered={clustered || undefined}>
    {rows.map((row, i) => {
      if (mode === 'unified') {
        const unified = row as { line: PatchLine; tone: DiffTone }
        return <UnifiedRow key={i} line={unified.line} tone={unified.tone} />
      }
      const split = row as SplitRow
      // 块内箭头：只在锚点行出现，指向左侧（把右侧工作区改动还原成左侧版本）。
      const gutter = canEdit && part.kind === 'change' && i === anchor
        ? <IconButton variant="revert" icon="arrowLeft" disabled={busy}
            label={`还原第 ${info?.line ?? ''} 行附近的修改段（−${info?.removed ?? 0} / +${info?.added ?? 0}）`}
            onClick={() => onRevert(selection)} />
        : null
      return <SplitRowView key={i} row={split} gutter={gutter} />
    })}
  </div>
}

export function GitDiffView(props: Props): React.ReactElement {
  return <DiffFile key={JSON.stringify([props.sessionId, props.cwd, props.path, props.staged])} {...props} />
}

function DiffFile({ cwd, path, staged, sessionId, workspaceRoot, onClose, onApplied }: Props) {
  const [mode, setMode] = React.useState(preferredMode)
  const [state, setState] = React.useState<{ text: string; revision?: string; error: string; loading: boolean }>({ text: '', error: '', loading: true })
  const [reload, refresh] = React.useReducer(count => count + 1, 0)
  const [draft, setDraft] = React.useState<(Selection & { text: string }) | null>(null)
  const [feedback, setFeedback] = React.useState<{ error: boolean; text: string } | null>(null)
  const [busy, setBusy] = React.useState(false)
  const writing = React.useRef(false)
  const live = React.useRef(false)
  const patch = React.useMemo(() => parseGitPatch(state.text), [state.text])
  const canEdit = !staged && !!sessionId && !!state.revision && patch?.editable === true
  const left = staged ? 'HEAD' : '暂存区'
  const right = staged ? '暂存区' : '工作区'
  const leftHint = staged ? '上次提交' : '已暂存的快照'
  const rightHint = staged ? '待提交内容' : '当前文件内容'
  const changes = React.useMemo(() => patch ? patch.hunks.reduce((sum, hunk) =>
    sum + hunk.parts.filter(part => part.kind === 'change').length, 0) : 0, [patch])
  const clustered = React.useMemo(() => patch ? patch.hunks.map(hunk => groupedPartsOf(hunk.parts)) : [], [patch])

  React.useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  React.useEffect(() => {
    const controller = new AbortController()
    setState(previous => ({ ...previous, revision: undefined, error: '', loading: true }))
    void rpc('git.diff', { cwd, path, staged, sessionId }, controller.signal).then(result => {
      if (controller.signal.aborted) return
      setState(result.ok ? { text: result.text, revision: result.revision, error: '', loading: false }
        : { text: '', error: result.error, loading: false })
    }).catch(cause => {
      if (!controller.signal.aborted) setState({ text: '', error: String(cause), loading: false })
    })
    return () => controller.abort()
  }, [cwd, path, staged, sessionId, reload])

  async function apply(selection: Selection, replacement?: string) {
    if (!sessionId || !canEdit || !state.revision || writing.current) return
    if (replacement === undefined && !window.confirm('将此修改段还原为暂存区内容？文件的其他修改会保留。')) return
    writing.current = true
    setBusy(true)
    setFeedback(null)
    try {
      const scope = workspaceScopeOf(workspaceRoot, sessionId)
      const workspace = minimalWorkspace(scope, sessionId)
      const target = absolutePath(cwd, path)
      const affected = [...workspace.documents.keys()].filter(key => absolutePath(workspaceRoot || cwd, key) === target)
      for (const key of affected) {
        const saved = await workspace.saves.flush(key)
        if (saved.some(result => !result.ok) || workspace.saves.state(key).dirty) throw new Error('文件尚未保存，请回到编辑器处理')
      }
      if (!live.current) return
      const result = await rpc('git.editPart', { cwd, path, sessionId, revision: state.revision, ...selection, replacement })
      if (!result.ok) throw new Error(result.error)
      emitFileChanged(target, { scope, kind: 'text' })
      if (affected.length) void loadMonaco(() => {}).then((monaco: unknown) => Promise.all(
        affected.filter(key => workspace.documents.has(key)).map(key => workspace.load(key, monaco, true)),
      )).catch(() => {})
      if (live.current) {
        onApplied?.(target)
        setDraft(null)
        setFeedback({ error: false, text: replacement === undefined ? '已还原此段' : '已替换此段' })
        setState(previous => ({ ...previous, revision: undefined, loading: true }))
        refresh()
      }
    } catch (cause) {
      if (live.current) setFeedback({ error: true, text: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      writing.current = false
      if (live.current) setBusy(false)
    }
  }

  function partControls(change: ChangePart, selection: Selection) {
    if (!canEdit) return null
    const editing = draft?.hunk === selection.hunk && draft.part === selection.part
    const info = changeInfoOf(change)
    return <>
      <div className="cstudio-diff-part-bar">
        <span className="cstudio-diff-part-info">
          <span className="cstudio-diff-part-line">{change.after.length ? `工作区第 ${info.line} 行` : `原第 ${info.line} 行`}</span>
          <span className="cstudio-diff-part-stat" aria-label={`删除 ${info.removed} 行，新增 ${info.added} 行`}>
            <b>−{info.removed}</b><b>+{info.added}</b>
          </span>
        </span>
        <span className="cstudio-diff-part-actions">
          <IconButton label="还原此段到暂存区版本" icon="arrowLeft" variant="revert" disabled={busy || !!draft}
            onClick={() => void apply(selection)} />
          <IconButton label="编辑此段内容" icon="edit" disabled={busy || !!draft}
            onClick={() => setDraft({ ...selection, text: patchPartText(change.after) })} />
        </span>
      </div>
      {editing && <div className="cstudio-diff-replacement">
        <textarea aria-label="替换此段的内容" autoFocus spellCheck={false} value={draft.text} disabled={busy}
          onChange={event => setDraft({ ...selection, text: event.target.value })} />
        <div className="cstudio-diff-part-tools">
          <button type="button" disabled={busy} onClick={() => setDraft(null)}>取消</button>
          <button type="button" className="cstudio-diff-apply" disabled={busy}
            onClick={() => void apply(selection, draft.text)}>{busy ? '正在写入…' : '应用替换'}</button>
        </div>
      </div>}
    </>
  }

  return <section className="cstudio-git-diff" data-mode={mode} aria-label="Git 修改差异">
    <header className="cstudio-diff-toolbar">
      <span className="cstudio-diff-title" title={path}>{path}</span>
      {patch && <div className="cstudio-diff-modes" role="group" aria-label="对比布局">
        <IconButton label="单栏内联对比" icon="layoutInline" pressed={mode === 'unified'}
          onClick={() => { preferredMode = 'unified'; setMode('unified') }} />
        <IconButton label="双栏并排对比" icon="layoutSplit" pressed={mode === 'split'}
          onClick={() => { preferredMode = 'split'; setMode('split') }} />
      </div>}
      {patch && <span className="cstudio-diff-summary" title={`${changes} 处修改段`}>{changes} 处改动</span>}
      <IconButton label="刷新差异" icon="refresh" disabled={busy || state.loading || !!draft}
        onClick={() => { setFeedback(null); refresh() }} />
      <IconButton label="关闭 Git 差异" icon="close" onClick={onClose} />
    </header>
    {patch && <div className="cstudio-diff-labels" data-mode={mode}>
      <div className="cstudio-diff-label" data-side="before"><span className="cstudio-diff-label-title">{left}</span><span className="cstudio-diff-label-hint">{leftHint}</span></div>
      <div className="cstudio-diff-label-caption" aria-hidden="true">→</div>
      <div className="cstudio-diff-label" data-side="after"><span className="cstudio-diff-label-title">{right}</span><span className="cstudio-diff-label-hint">{rightHint}</span></div>
    </div>}
    {feedback && <div className="cstudio-diff-feedback" role={feedback.error ? 'alert' : 'status'}>{feedback.text}</div>}
    {patch ? <div className="cstudio-diff-scroll" tabIndex={0} aria-label="差异内容" aria-busy={state.loading}>
      {patch.hunks.map((hunk, h) => <section className="cstudio-diff-hunk" key={h}>
        <div className="cstudio-diff-range">{hunk.title}</div>
        {hunk.parts.map((part, p) => <React.Fragment key={p}>
          {part.kind === 'change' && partControls(part, { hunk: h, part: p })}
          <PartRows part={part} mode={mode} selection={{ hunk: h, part: p }}
            clustered={clustered[h]?.has(p) ?? false} onRevert={value => void apply(value)}
            canEdit={canEdit} busy={busy || !!draft} />
        </React.Fragment>)}
      </section>)}
    </div> : state.text ? <pre className="cstudio-diff-raw" tabIndex={0}>{state.text}</pre>
      : <p className="cstudio-diff-feedback" role={state.error ? 'alert' : 'status'}>{state.loading ? '正在读取 Git 差异…' : state.error || '没有可显示的 Git 修改差异'}</p>}
  </section>
}
