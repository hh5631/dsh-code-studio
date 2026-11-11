/** 只读 Git patch，仅在点击变更文件时读取。 */
import React from 'react'
import { rpc } from '../rpc.js'
export function GitDiffView(props: { cwd: string; path: string; staged: boolean; onClose(): void }): React.ReactElement {
  const [state, setState] = React.useState({ text: '', error: '', loading: true })
  const lines = React.useMemo(() => {
    const list = state.text.split('\n')
    return list.length <= 4000 ? list : null
  }, [state.text])
  React.useEffect(() => {
    const controller = new AbortController()
    setState({ text: '', error: '', loading: true })
    void rpc('git.diff', { cwd: props.cwd, path: props.path, staged: props.staged }, controller.signal).then(result => {
      if (!controller.signal.aborted) setState(result.ok ? { text: result.text, error: '', loading: false } : { text: '', error: result.error, loading: false })
    }).catch(error => { if (!controller.signal.aborted) setState({ text: '', error: String(error), loading: false }) })
    return () => controller.abort()
  }, [props.cwd, props.path, props.staged])
  return React.createElement('section', { className: 'cstudio-git-diff', 'aria-label': 'Git 修改差异' },
    React.createElement('header', null, React.createElement('span', null, `${props.staged ? '已暂存' : '未暂存'} · ${props.path}`),
      React.createElement('button', { type: 'button', onClick: props.onClose, 'aria-label': '关闭 Git 差异' }, '×')),
    React.createElement('pre', { tabIndex: 0 }, state.loading ? '正在读取 Git 差异…' : state.error || (state.text && lines
      ? lines.map((line, index) => React.createElement('span', { key: index, className: line.startsWith('+') ? 'cstudio-git-add' : line.startsWith('-') ? 'cstudio-git-delete' : line.startsWith('@@') ? 'cstudio-git-hunk' : undefined }, line + '\n'))
      : state.text || '没有可显示的 Git 修改差异')))
}
