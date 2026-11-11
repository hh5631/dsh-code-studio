/** 与原生文件树共用位置的源代码管理视图。 */
import React from 'react'
import type { GitChange } from '../../../git.js'
import { rpc } from '../../rpc.js'
import { GitStore, useGitStore, GIT_CHANGED_EVENT } from '../../state/gitStore.js'
import { gitTone, repositoryDirectory } from '../../state/gitPaths.js'
import { fileIconEl } from '../../ui/icons.js'
import { StudioIcon } from '../../ui/StudioIcon.js'
import '../../styles/git.css'

interface GitContext {
  cwd?: string | null; activePath?: string | null; visible?: boolean; gitStore?: GitStore
  openFile?(path: string): void
  openGitDiff?(path: string, staged: boolean, root?: string): void
  prepareFileOperation?(path: string): Promise<boolean>
  gitChanged?(method?: string, path?: string): void
  notify?(message: string): void
}
type Mutation = 'git.stage' | 'git.unstage' | 'git.discard'
const LABELS: Record<string, string> = { M: '已修改', A: '新增', D: '已删除', R: '已重命名', C: '已复制', U: '冲突', '?': '未跟踪' }

function OwnedGitPanel({ ctx }: { ctx: GitContext }): React.ReactElement {
  const { store } = useGitStore(repositoryDirectory(ctx.cwd, ctx.activePath), ctx.visible !== false)
  return React.createElement(GitBody, { ctx, store })
}
export function GitPanel({ ctx = {} }: { ctx?: GitContext }): React.ReactElement {
  return ctx.gitStore ? React.createElement(GitBody, { ctx, store: ctx.gitStore }) : React.createElement(OwnedGitPanel, { ctx })
}

function GitBody({ ctx, store }: { ctx: GitContext; store: GitStore }): React.ReactElement {
  const state = React.useSyncExternalStore(store.subscribe, store.snapshot)
  const root = state.data?.root ?? ''
  const changes = state.data?.changes ?? []
  const [view, setView] = React.useState<'changes' | 'history'>('changes')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const [selected, setSelected] = React.useState('')
  const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({})
  const [limits, setLimits] = React.useState<Record<string, number>>({})
  const [historyRevision, refreshHistory] = React.useReducer(value => value + 1, 0)
  const [history, setHistory] = React.useState<{ root: string; loading: boolean; commits: Array<{ hash: string; subject: string }>; error: string }>({ root: '', loading: false, commits: [], error: '' })
  const alive = React.useRef(true), currentRoot = React.useRef(root)
  currentRoot.current = root
  React.useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  React.useEffect(() => { setError(''); setSelected(''); setLimits({}); setCollapsed({}) }, [root])
  React.useEffect(() => {
    if (view !== 'history' || !root) return
    let live = true
    setHistory({ root, loading: true, commits: [], error: '' })
    void rpc('git.log', { cwd: root, limit: 20 }).then(result => {
      if (live) setHistory({ root, loading: false, commits: result.ok ? result.commits : [], error: result.ok ? '' : result.error })
    }).catch(cause => { if (live) setHistory({ root, loading: false, commits: [], error: String(cause) }) })
    return () => { live = false }
  }, [view, root, historyRevision])

  const mutate = async (method: Mutation, change: GitChange) => {
    if (busy || !root) return
    if (method === 'git.discard' && !window.confirm(`丢弃“${change.path}”的未暂存修改？此操作不可撤销。`)) return
    setBusy(true); setError('')
    try {
      const path = root.replace(/[\\/]+$/, '') + '/' + change.path
      if (ctx.prepareFileOperation && !await ctx.prepareFileOperation(path)) return
      const result = await rpc(method, { cwd: root, paths: [change.path] })
      if (!result.ok) throw new Error(result.error)
      ctx.gitChanged?.(method, path)
      window.dispatchEvent(new CustomEvent(GIT_CHANGED_EVENT, { detail: { root, source: store } }))
      await store.refresh(true)
    } catch (cause) { if (alive.current && currentRoot.current === root) setError(String(cause)) }
    finally { if (alive.current) setBusy(false) }
  }
  const action = (label: string, icon: 'plus' | 'minus' | 'discard', method: Mutation, change: GitChange) => React.createElement('button', {
    type: 'button', className: 'cstudio-git-action', title: label, 'aria-label': `${label} ${change.path}`, disabled: busy,
    onClick: () => { void mutate(method, change) },
  }, React.createElement(StudioIcon, { name: icon }))
  const row = (change: GitChange) => {
    const name = change.path.split('/').pop() || change.path
    const directory = change.path.slice(0, change.path.length - name.length).replace(/\/$/, '')
    const key = `${change.path}:${change.staged}`
    const open = () => {
      setSelected(key)
      if (change.status === '?') ctx.openFile?.(root + '/' + change.path)
      else ctx.openGitDiff?.(change.path, change.staged, root)
    }
    return React.createElement('div', { key: `${change.path}:${change.staged}:${change.status}`, className: 'cstudio-git-row', 'data-git-tone': gitTone(change.status) },
      React.createElement('button', { type: 'button', className: 'cstudio-git-file', title: change.path, onClick: open, 'aria-pressed': selected === key, 'aria-label': `${name}，${LABELS[change.status] || '修改'}，${change.staged ? '已暂存' : '未暂存'}` },
        fileIconEl(name), React.createElement('span', { className: 'cstudio-git-filename' }, name),
        directory ? React.createElement('span', { className: 'cstudio-git-directory' }, directory) : null),
      React.createElement('span', { className: 'cstudio-git-row-actions' },
        change.staged ? action('取消暂存', 'minus', 'git.unstage', change) : action('暂存', 'plus', 'git.stage', change),
        !change.staged && change.status !== '?' ? action('丢弃修改', 'discard', 'git.discard', change) : null),
      React.createElement('span', { className: 'cstudio-git-status', title: LABELS[change.status] || '修改' }, change.status === '?' ? 'U' : change.status))
  }
  const group = (id: string, title: string, list: GitChange[]) => {
    if (!list.length) return null
    const limit = limits[id] ?? 200
    return React.createElement('section', { className: 'cstudio-git-group', key: id },
      React.createElement('button', { type: 'button', className: 'cstudio-git-group-heading', 'aria-expanded': !collapsed[id], onClick: () => setCollapsed(value => ({ ...value, [id]: !value[id] })) },
        React.createElement(StudioIcon, { name: collapsed[id] ? 'right' : 'down', size: 14 }), React.createElement('span', null, title), React.createElement('span', { className: 'cstudio-git-count' }, list.length)),
      collapsed[id] ? null : React.createElement(React.Fragment, null, list.slice(0, limit).map(row),
        list.length > limit ? React.createElement('button', { className: 'cstudio-git-more', type: 'button', onClick: () => setLimits(value => ({ ...value, [id]: limit + 200 })) }, `显示其余 ${list.length - limit} 项`) : null))
  }
  const empty = (icon: 'branch' | 'check' | 'commit', text: string) => React.createElement('div', { className: 'cstudio-git-empty', role: 'status' }, React.createElement(StudioIcon, { name: icon, size: 28 }), React.createElement('p', null, text))
  let body: React.ReactNode
  if (state.phase === 'idle' || state.phase === 'loading') body = empty('branch', store.cwd ? '正在读取仓库…' : '打开工作区文件后查看 Git')
  else if (state.phase === 'error') body = empty('branch', state.error.includes('不是 Git 仓库') ? '此文件不在 Git 仓库中' : state.error)
  else if (view === 'history') body = history.loading || history.root !== root ? empty('commit', '正在读取提交…')
    : history.error ? empty('commit', history.error)
    : !history.commits.length ? empty('commit', '还没有提交记录')
    : React.createElement('div', { className: 'cstudio-git-history' }, history.commits.map(commit => React.createElement('div', { key: commit.hash, className: 'cstudio-git-commit', title: `${commit.subject}\n${commit.hash}` },
      React.createElement(StudioIcon, { name: 'commit' }), React.createElement('div', null, React.createElement('span', { className: 'cstudio-git-subject' }, commit.subject), React.createElement('code', null, commit.hash.slice(0, 8))))))
  else if (!changes.length) body = empty('check', '工作区干净')
  else body = React.createElement('div', { className: 'cstudio-git-changes' },
    group('staged', '已暂存', changes.filter(change => change.staged)),
    group('unstaged', '修改', changes.filter(change => !change.staged && change.status !== '?')),
    group('untracked', '未跟踪', changes.filter(change => change.status === '?')))

  return React.createElement('div', { className: 'cstudio-git-panel' },
    React.createElement('div', { className: 'cstudio-git-heading' },
      React.createElement(StudioIcon, { name: 'branch' }),
      React.createElement('span', { className: 'cstudio-git-branch', title: root }, state.branch || (root ? '未命名分支' : '源代码管理')),
      React.createElement('button', { type: 'button', className: 'cstudio-git-refresh', title: '刷新 Git', 'aria-label': '刷新 Git', disabled: busy || state.refreshing,
        onClick: () => { setError(''); void store.refresh(true); refreshHistory() } }, React.createElement(StudioIcon, { name: 'refresh' }))),
    root ? React.createElement('div', { className: 'cstudio-git-views', role: 'tablist', 'aria-label': 'Git 视图' },
      React.createElement('button', { type: 'button', role: 'tab', 'aria-selected': view === 'changes', onClick: () => setView('changes') }, '修改', React.createElement('span', null, changes.length)),
      React.createElement('button', { type: 'button', role: 'tab', 'aria-selected': view === 'history', onClick: () => setView('history') }, '提交')) : null,
    error ? React.createElement('div', { role: 'alert', className: 'cstudio-git-error' }, error) : null,
    body)
}

export function createGitPanel() {
  return { id: 'git', title: 'Git', icon: () => React.createElement(StudioIcon, { name: 'branch' }), order: 21, render: (ctx: GitContext) => React.createElement(GitPanel, { ctx }) }
}
