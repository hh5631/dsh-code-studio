import React from 'react'
import { parseGitPatch, patchLineText, patchPartText, type PatchLine, type PatchPart } from '../../shared/gitPatch.js'
import { emitFileChanged } from '../events.js'
import { loadMonaco } from '../monaco/loader.js'
import { rpc } from '../rpc.js'
import { absolutePath } from '../state/gitPaths.js'
import { minimalWorkspace } from '../state/minimalWorkspace.js'
import { workspaceScopeOf } from '../state/scopeStore.js'
import { StudioIcon } from './StudioIcon.js'
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
type Mode = 'unified' | 'split'
type Selection = { hunk: number; part: number }
type ChangePart = Extract<PatchPart, { kind: 'change' }>
let preferredMode: Mode = 'unified'

function LineText({ line }: { line?: PatchLine }) {
  return <code>{line && patchLineText(line)}{line && !line.newline && <span className="cstudio-diff-eof" title="文件末尾无换行">↵</span>}</code>
}

function UnifiedRow({ line }: { line: PatchLine }) {
  const tone = line.before === undefined ? 'add' : line.after === undefined ? 'remove' : undefined
  return <div className="cstudio-diff-row cstudio-diff-unified" data-tone={tone}>
    <span className="cstudio-diff-number">{line.before}</span>
    <span className="cstudio-diff-number">{line.after}</span>
    <span className="cstudio-diff-sign" aria-hidden="true">{tone === 'add' ? '+' : tone === 'remove' ? '−' : ''}</span>
    <LineText line={line} />
  </div>
}

function SplitRow({ before, after, changed = false }: { before?: PatchLine; after?: PatchLine; changed?: boolean }) {
  return <div className="cstudio-diff-row cstudio-diff-split">
    <div className="cstudio-diff-cell" data-tone={changed && before ? 'remove' : undefined} data-gap={!before || undefined}>
      <span className="cstudio-diff-number">{before?.before}</span>
      <span className="cstudio-diff-sign" aria-hidden="true">{changed && before ? '−' : ''}</span>
      <LineText line={before} />
    </div>
    <div className="cstudio-diff-cell" data-tone={changed && after ? 'add' : undefined} data-gap={!after || undefined}>
      <span className="cstudio-diff-number">{after?.after}</span>
      <span className="cstudio-diff-sign" aria-hidden="true">{changed && after ? '+' : ''}</span>
      <LineText line={after} />
    </div>
  </div>
}

function PartRows({ part, mode }: { part: PatchPart; mode: Mode }) {
  if (part.kind === 'context') return <>{part.lines.map((line, i) => mode === 'unified'
    ? <UnifiedRow key={i} line={line} /> : <SplitRow key={i} before={line} after={line} />)}</>
  if (mode === 'unified') return <>{[...part.before, ...part.after].map((line, i) => <UnifiedRow key={i} line={line} />)}</>
  return <>{Array.from({ length: Math.max(part.before.length, part.after.length) }, (_, i) =>
    <SplitRow key={i} before={part.before[i]} after={part.after[i]} changed />)}</>
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
    const line = change.after[0]?.after ?? change.before[0]?.before
    return <>
      <div className="cstudio-diff-part-tools">
        <span>{change.after.length ? `工作区第 ${line} 行` : `原第 ${line} 行`}</span>
        <button type="button" disabled={busy || !!draft} onClick={() => void apply(selection)}>还原此段</button>
        <button type="button" disabled={busy || !!draft} onClick={() => setDraft({ ...selection, text: patchPartText(change.after) })}>替换此段</button>
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

  return <section className="cstudio-git-diff" aria-label="Git 修改差异">
    <header className="cstudio-diff-toolbar">
      <span className="cstudio-diff-title" title={path}>{path}</span>
      {patch && <div className="cstudio-diff-modes" role="group" aria-label="对比布局">
        {(['unified', 'split'] as const).map(item => <button key={item} type="button" aria-pressed={mode === item}
          onClick={() => { preferredMode = item; setMode(item) }}>{item === 'unified' ? '单栏' : '双栏'}</button>)}
      </div>}
      <button type="button" title="刷新差异" aria-label="刷新差异" disabled={busy || state.loading || !!draft}
        onClick={() => { setFeedback(null); refresh() }}><StudioIcon name="refresh" /></button>
      <button type="button" title="关闭 Git 差异" aria-label="关闭 Git 差异" onClick={onClose}><StudioIcon name="close" /></button>
    </header>
    {patch && (mode === 'split'
      ? <div className="cstudio-diff-labels cstudio-diff-split"><span>{left}</span><span>{right}</span></div>
      : <div className="cstudio-diff-labels">{left} → {right}</div>)}
    {feedback && <div className="cstudio-diff-feedback" role={feedback.error ? 'alert' : 'status'}>{feedback.text}</div>}
    {patch ? <div className="cstudio-diff-scroll" tabIndex={0} aria-label="差异内容" aria-busy={state.loading}>
      {patch.hunks.map((hunk, h) => <section key={h}>
        <div className="cstudio-diff-range">{hunk.title}</div>
        {hunk.parts.map((part, p) => <React.Fragment key={p}>
          {part.kind === 'change' && partControls(part, { hunk: h, part: p })}
          <PartRows part={part} mode={mode} />
        </React.Fragment>)}
      </section>)}
    </div> : state.text ? <pre className="cstudio-diff-raw" tabIndex={0}>{state.text}</pre>
      : <p className="cstudio-diff-feedback" role={state.error ? 'alert' : 'status'}>{state.loading ? '正在读取 Git 差异…' : state.error || '没有可显示的 Git 修改差异'}</p>}
  </section>
}
