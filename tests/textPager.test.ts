import { afterEach, describe, expect, it, vi } from 'vitest'

const viewHooks = vi.hoisted(() => ({ refs: [] as any[], states: [] as any[], effects: [] as any[], refIndex: 0, stateIndex: 0, effectIndex: 0 }))
vi.mock('react', () => ({ default: {
  createElement: (type: any, props: any, ...children: any[]) => ({ type, props: props ?? {}, children }),
  useRef: (initial: any) => viewHooks.refs[viewHooks.refIndex++] ?? (viewHooks.refs[viewHooks.refIndex - 1] = { current: initial }),
  useState: (initial: any) => {
    const index = viewHooks.stateIndex++
    if (!(index in viewHooks.states)) viewHooks.states[index] = initial
    return [viewHooks.states[index], (value: any) => { viewHooks.states[index] = value }]
  },
  useEffect: (effect: any, deps: any[]) => {
    const index = viewHooks.effectIndex++, previous = viewHooks.effects[index]
    if (previous && deps.every((entry, i) => entry === previous.deps[i])) return
    previous?.cleanup?.(); viewHooks.effects[index] = { cleanup: effect(), deps }
  },
} }))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ Button: 'button' }))
import { LargeTextView } from '../src/client/ui/LargeTextView.js'

/** @private @author ddj 2026年10月22号 @param props Preview identity. @returns Real component virtual tree using retained hook slots. */
function renderView(props: any): any {
  viewHooks.refIndex = 0; viewHooks.stateIndex = 0; viewHooks.effectIndex = 0
  return LargeTextView(props)
}
/** @private @author ddj 2026年10月22号 @returns Clear retained hook resources and globals. */
function clearView(): void {
  for (const effect of viewHooks.effects) effect?.cleanup?.()
  viewHooks.refs = []; viewHooks.states = []; viewHooks.effects = []
  vi.unstubAllGlobals()
}
afterEach(clearView)
import { createTextPager } from '../src/client/textPages.js'
import { TEXT_PAGE_BYTES, TEXT_VIEW_BYTES, TEXT_VIEW_LINES } from '../src/shared/textPages.js'
import type { TextPageResult } from '../src/shared/textPages.js'

/** @private @author ddj 2026年10月22号 @param text Page content. @param offset Byte position. @param eof End marker. @returns Valid server envelope. */
function page(text: string, offset = text.length, eof = false): TextPageResult {
  return { ok: true, text, offset, size: eof ? offset : TEXT_VIEW_BYTES * 2, version: 'v1', eof,
    nextCursor: eof ? null : 'signed-' + offset, encoding: 'utf-8', partialLine: !eof }
}

describe('LargeTextView visibility and identity lifecycle', () => {
  it('defers hidden first load and never auto-loads another page on visibility changes', async () => {
    const document = new EventTarget() as EventTarget & { hidden: boolean }
    document.hidden = true; vi.stubGlobal('document', document)
    const load = vi.fn(async () => page('abc'))
    const props = { sessionId: 's', path: 'a', loadPage: load }
    renderView(props); await Promise.resolve()
    expect(load).not.toHaveBeenCalled()
    document.hidden = false; document.dispatchEvent(new Event('visibilitychange'))
    await Promise.resolve(); await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(1)
    document.hidden = true
    const tree = renderView(props)
    tree.children[0].children[1].props.onClick()
    expect(load).toHaveBeenCalledTimes(1)
    document.hidden = false; document.dispatchEvent(new Event('visibilitychange'))
    await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(1)
  })
  it('waits for the old transport then reads the new identity exactly once', async () => {
    let resolveOld!: (result: TextPageResult) => void
    const load = vi.fn().mockImplementationOnce(() => new Promise<TextPageResult>(done => { resolveOld = done }))
      .mockResolvedValue(page('fresh', 5, true))
    renderView({ sessionId: 's', path: 'a', loadPage: load })
    renderView({ sessionId: 'other', path: 'b', loadPage: load })
    expect(load).toHaveBeenCalledTimes(1)
    resolveOld(page('obsolete'))
    for (let index = 0; index < 5; index++) await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(2)
    expect(load.mock.calls[1][0]).toMatchObject({ sessionId: 'other', path: 'b' })
    expect(viewHooks.states[0].text).toBe('fresh')
    expect(viewHooks.states[0].text).not.toContain('obsolete')
  })
  it('does not start a deferred identity request after unmount', async () => {
    let resolveOld!: (result: TextPageResult) => void
    const load = vi.fn(() => new Promise<TextPageResult>(done => { resolveOld = done }))
    renderView({ sessionId: 's', path: 'a', loadPage: load })
    renderView({ sessionId: 's', path: 'b', loadPage: load })
    clearView(); resolveOld(page('obsolete'))
    for (let index = 0; index < 4; index++) await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(1)
  })
})

describe('bounded text pager', () => {
  it('allows only one in-flight request and only explicit continuation', async () => {
    let resolve!: (result: TextPageResult) => void
    const load = vi.fn(() => new Promise<TextPageResult>(done => { resolve = done }))
    const pager = createTextPager(load, vi.fn())
    pager.reset({ path: 'a', sessionId: 's' })
    const pending = pager.loadNext()
    await pager.loadNext()
    expect(load).toHaveBeenCalledTimes(1)
    resolve(page('abc'))
    await pending
    expect(pager.getState().text).toBe('abc')
    expect(load).toHaveBeenCalledTimes(1)
    expect(pager.getState().loading).toBe(false)
  })
  it('invalidates identity changes without overlapping the old transport', async () => {
    let resolve!: (result: TextPageResult) => void
    const load = vi.fn(() => new Promise<TextPageResult>(done => { resolve = done }))
    const pager = createTextPager(load, vi.fn())
    pager.reset({ path: 'a', sessionId: 's' })
    const pending = pager.loadNext()
    pager.reset({ path: 'a', sessionId: 'other-session' })
    await pager.loadNext()
    expect(load).toHaveBeenCalledTimes(1)
    resolve(page('obsolete'))
    await pending
    expect(pager.getState().text).toBe('')
    expect(pager.getState().loading).toBe(false)
  })
  it('ignores responses after disposal', async () => {
    let resolve!: (result: TextPageResult) => void
    const changed = vi.fn()
    const pager = createTextPager(() => new Promise(done => { resolve = done }), changed)
    pager.reset({ path: 'a' })
    const pending = pager.loadNext()
    pager.dispose()
    const count = changed.mock.calls.length
    resolve(page('obsolete'))
    await pending
    expect(changed).toHaveBeenCalledTimes(count)
    expect(pager.getState().text).toBe('')
  })
  it('enforces 8 MiB for huge lines and stops issuing requests', async () => {
    let offset = 0
    const load = vi.fn(async () => { offset += TEXT_PAGE_BYTES; return page('a'.repeat(TEXT_PAGE_BYTES), offset) })
    const pager = createTextPager(load, vi.fn())
    pager.reset({ path: 'a' })
    for (let index = 0; index < 35; index++) await pager.loadNext()
    expect(pager.getState().text.length).toBe(TEXT_VIEW_BYTES)
    expect(pager.getState().capped).toBe(true)
    expect(load).toHaveBeenCalledTimes(32)
  })
  it('enforces 50000 displayed lines without retaining the rest of a dense page', async () => {
    const load = vi.fn(async () => page('a\n'.repeat(TEXT_VIEW_LINES + 20)))
    const pager = createTextPager(load, vi.fn())
    pager.reset({ path: 'a' })
    await pager.loadNext()
    expect(pager.getState().lines).toBe(TEXT_VIEW_LINES)
    expect(pager.getState().text.split('\n')).toHaveLength(TEXT_VIEW_LINES)
    await pager.loadNext()
    expect(load).toHaveBeenCalledTimes(1)
  })
  it('retries a failed page explicitly without dropping already loaded content', async () => {
    const load = vi.fn().mockResolvedValueOnce(page('abc')).mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(page('def', 6, true))
    const pager = createTextPager(load, vi.fn())
    pager.reset({ path: 'a' })
    await pager.loadNext(); await pager.loadNext()
    expect(pager.getState()).toMatchObject({ text: 'abc', error: 'Error: offline' })
    await pager.loadNext()
    expect(pager.getState()).toMatchObject({ text: 'abcdef', error: null, eof: true })
    expect(load.mock.calls[2][0].cursor).toBe('signed-3')
  })
  it('counts CRLF and bare CR lines without exceeding the line cap', async () => {
    for (const ending of ['\r\n', '\r']) {
      const pager = createTextPager(async () => page(('x' + ending).repeat(TEXT_VIEW_LINES + 2)), vi.fn())
      pager.reset({ path: 'a' }); await pager.loadNext()
      expect(pager.getState().lines).toBe(TEXT_VIEW_LINES)
      expect(pager.getState().text.split(/\r\n|\r|\n/)).toHaveLength(TEXT_VIEW_LINES)
    }
  })
  it('rejects malformed and version-mixed pages; propagates unsupported', async () => {
    const load = vi.fn().mockResolvedValueOnce(page('abc')).mockResolvedValueOnce({ ...page('def', 6), version: 'v2' })
    const pager = createTextPager(load, vi.fn())
    pager.reset({ path: 'a' })
    await pager.loadNext()
    await pager.loadNext()
    expect(pager.getState()).toMatchObject({ text: 'abc', error: 'Invalid or stale text page' })
    pager.reset({ path: 'b' })
    load.mockResolvedValueOnce({ ok: false, reason: 'unsupported', error: 'No authorized range read' })
    await pager.loadNext()
    expect(pager.getState().error).toBe('No authorized range read')
  })
})
