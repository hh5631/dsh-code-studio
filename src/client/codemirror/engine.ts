import { Compartment, EditorSelection, EditorState, Prec } from '@codemirror/state'
import {
  EditorView, drawSelection, dropCursor, highlightActiveLine, highlightActiveLineGutter,
  highlightSpecialChars, keymap, lineNumbers,
} from '@codemirror/view'
import { copyLineDown, defaultKeymap, history, historyKeymap, indentWithTab, toggleComment } from '@codemirror/commands'
import { closeSearchPanel, getSearchQuery, gotoLine, openSearchPanel, search, searchKeymap, searchPanelOpen, setSearchQuery } from '@codemirror/search'
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete'
import { bracketMatching, foldGutter, foldKeymap, HighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import type { EditorEngine, EditorCommand } from '../editorTypes.js'
import { detectColorScheme, editorFont, observeScheme } from '../editorTheme.js'
import { TYPOGRAPHY_EVENT } from '../typography.js'
import { viewStatesLoad, viewStatesSave, upsertViewState } from '../state/viewStateCache.js'
import { CodeMirrorModel, trackDocument } from './model.js'
import { languageFor } from './languages.js'
import { connectLsp, offsetAt } from './lsp.js'

export const editorName = 'CodeMirror 6'

const language = new Compartment()
const appearance = new Compartment()
const wrapping = new Compartment()
const commands = new Compartment()
const intelligence = new Compartment()
const locations = new Compartment()

const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'transparent', color: 'inherit' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: 'inherit', overscrollBehavior: 'contain' },
  '.cm-content': { padding: '10px 0', caretColor: 'currentColor' },
  '.cm-line': { padding: '0 8px' },
  '.cm-gutters': { backgroundColor: 'transparent', border: 'none', color: 'var(--cstudio-muted)' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--dsw-alias-interactive-bg-hover, #80808018)' },
  '.cm-panel, .cm-tooltip': { backgroundColor: 'var(--cstudio-raised)', color: 'inherit', borderColor: 'var(--cstudio-border)' },
  '.cm-panel input, .cm-panel button': { backgroundColor: 'var(--cstudio-surface)', color: 'inherit', border: '1px solid var(--cstudio-border)' },
  '.cstudio-cm-hover': { maxWidth: 'min(560px, 75vw)', maxHeight: '40vh', overflow: 'auto', whiteSpace: 'pre-wrap', padding: '8px' },
  '.cstudio-cm-locations': { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '4px', padding: '8px', maxHeight: '35vh', overflow: 'auto' },
})
const highlighting = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier, tags.controlKeyword], color: 'light-dark(#7c37a5, #c586c0)' },
  { tag: [tags.string, tags.regexp], color: 'light-dark(#a31515, #ce9178)' },
  { tag: [tags.comment, tags.meta], color: 'light-dark(#527044, #87a87b)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'light-dark(#12755b, #b5cea8)' },
  { tag: [tags.typeName, tags.className, tags.tagName], color: 'light-dark(#267f99, #4ec9b0)' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.heading], color: 'light-dark(#795e26, #dcdcaa)' },
  { tag: [tags.propertyName, tags.attributeName], color: 'light-dark(#005b91, #9cdcfe)' },
  { tag: tags.link, textDecoration: 'underline' },
  { tag: tags.strong, fontWeight: 'bold' },
  { tag: tags.emphasis, fontStyle: 'italic' },
])
const base = [
  trackDocument, theme, syntaxHighlighting(highlighting),
  lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(), highlightSpecialChars(),
  drawSelection(), dropCursor(), EditorState.allowMultipleSelections.of(true),
  history(), foldGutter(), indentOnInput(), bracketMatching(), closeBrackets(),
  search(), autocompletion({ activateOnTyping: true }),
  keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, indentWithTab]),
  EditorState.phrases.of({
    Find: '查找', Replace: '替换', next: '下一个', previous: '上一个', all: '全部',
    'match case': '区分大小写', regexp: '正则表达式', 'by word': '全字匹配', 'replace all': '全部替换', close: '关闭',
  }),
  language.of([]), appearance.of([]), wrapping.of([]), commands.of([]), intelligence.of([]), locations.of([]),
]

interface Snapshot {
  cursorState: ReturnType<EditorSelection['toJSON']>
  viewState: { top: number; left: number }
}

function snapshot(view: EditorView): Snapshot {
  const { scrollTop: top, scrollLeft: left } = view.scrollDOM
  return { cursorState: view.state.selection.toJSON(), viewState: { top, left } }
}

function restore(view: EditorView, saved: Snapshot) {
  try {
    const selection = EditorSelection.fromJSON(saved.cursorState)
    const clamp = (pos: number) => Math.max(0, Math.min(pos, view.state.doc.length))
    view.dispatch({ selection: EditorSelection.create(selection.ranges.map(range => (
      EditorSelection.range(clamp(range.anchor), clamp(range.head))
    )), selection.mainIndex) })
  } catch { /* Stale cursor state does not prevent opening the file. */ }
  view.scrollDOM.scrollTop = saved.viewState?.top ?? 0
  view.scrollDOM.scrollLeft = saved.viewState?.left ?? 0
}

export async function loadEditorEngine(): Promise<EditorEngine> {
  return {
    createModel: (_scope, _path, text) => new CodeMirrorModel(text, base),
    mount(host, context) {
      const view = new EditorView({ parent: host, extensions: base })
      const cacheScope = context.scope + ':codemirror'
      let bound: { path: string; model: CodeMirrorModel } | null = null
      let wrapped = false
      let activeLsp: ReturnType<typeof connectLsp> | undefined
      let fileLanguage: ReturnType<typeof languageFor> = []
      const setPanel: Parameters<NonNullable<typeof activeLsp>['navigate']>[1] = panel => {
        view.dispatch({ effects: locations.reconfigure(panel) })
      }

      function style() {
        const { fontSize, fontFamily, lineHeight } = editorFont()
        const dark = detectColorScheme() === 'dark'
        return EditorView.theme({ '&': { fontSize: fontSize + 'px', fontFamily, lineHeight: lineHeight + 'px', colorScheme: dark ? 'dark' : 'light' } }, { dark })
      }

      const shortcuts = Prec.highest(keymap.of([
        { key: 'Mod-s', run: () => { context.save(); return true }, preventDefault: true },
        { key: 'Shift-Alt-ArrowDown', run: copyLineDown, preventDefault: true },
        { key: 'F12', run: () => { run('goToDefinition'); return true }, preventDefault: true },
        { key: 'Shift-F12', run: () => { run('findReferences'); return true }, preventDefault: true },
      ]))
      function lspExtensions() {
        const lsp = activeLsp
        return lsp ? [lsp.hover, autocompletion({ override: [lsp.complete] })] : []
      }
      function configure() {
        view.dispatch({ effects: [
          appearance.reconfigure(style()),
          wrapping.reconfigure(wrapped ? EditorView.lineWrapping : []),
          language.reconfigure(fileLanguage),
          commands.reconfigure(shortcuts),
          intelligence.reconfigure(lspExtensions()),
          locations.reconfigure([]),
        ] })
      }
      function updateAppearance() {
        view.dispatch({ effects: appearance.reconfigure(style()) })
      }
      const stopTheme = observeScheme(updateAppearance)
      window.addEventListener(TYPOGRAPHY_EVENT, updateAppearance)
      window.addEventListener('edrv:theme-change', updateAppearance)

      function save() {
        if (!bound) return
        const before = viewStatesLoad(cacheScope)
        const next = upsertViewState(before, bound.path, snapshot(view))
        if (next !== before) viewStatesSave(cacheScope, next)
      }
      function releaseLsp() {
        if (!activeLsp) return
        activeLsp.close()
        activeLsp = undefined
        view.dispatch({ effects: [intelligence.reconfigure([]), locations.reconfigure([])] })
      }
      function resetView() {
        if (!bound) return
        const saved = snapshot(view)
        const searchState = getSearchQuery(view.state)
        const searching = searchPanelOpen(view.state)
        bound.model.restore(view)
        configure()
        restore(view, saved)
        view.dispatch({ effects: setSearchQuery.of(searchState) })
        if (searching) openSearchPanel(view)
      }
      function run(command: EditorCommand) {
        if (!bound) return
        if (command === 'goToLine') { gotoLine(view); return }
        if (command === 'toggleComment') { view.focus(); toggleComment(view); return }
        if (command === 'duplicateLine') { view.focus(); copyLineDown(view); return }
        if (activeLsp) void activeLsp.navigate(command === 'findReferences', setPanel)
        else context.notify('当前文件没有可用的语言服务')
      }

      return {
        bind(path, model) {
          if (bound?.model === model) return
          const searchState = getSearchQuery(view.state)
          const searching = searchPanelOpen(view.state)
          const wasFocused = view.hasFocus
          save()
          releaseLsp()
          bound?.model.detach(view)
          const next = model as CodeMirrorModel
          bound = { path, model: next }
          fileLanguage = []
          next.attach(view, resetView)
          configure()
          const saved = viewStatesLoad(cacheScope)[path] as Snapshot | undefined
          if (saved) restore(view, saved)
          else { view.scrollDOM.scrollTop = 0; view.scrollDOM.scrollLeft = 0 }
          view.dispatch({ effects: setSearchQuery.of(searchState) })
          if (searching) openSearchPanel(view)
          else { closeSearchPanel(view); if (wasFocused) view.focus() }
        },
        clear() {
          save()
          releaseLsp()
          bound?.model.detach(view)
          bound = null
          view.setState(EditorState.create({ extensions: base }))
        },
        save,
        goTo(line, column) {
          const pos = offsetAt(view.state.doc, line, column)
          view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) })
          view.focus()
        },
        setWrap(enabled) {
          wrapped = enabled
          view.dispatch({ effects: wrapping.reconfigure(wrapped ? EditorView.lineWrapping : []) })
        },
        activate(path, model, sessionId) {
          if (bound?.model !== model) return
          fileLanguage = languageFor(path)
          if (sessionId && /\.(?:lua|csx?)$/i.test(path)) activeLsp = connectLsp(view, model, path, sessionId, context)
          view.dispatch({ effects: [language.reconfigure(fileLanguage), intelligence.reconfigure(lspExtensions())] })
          return releaseLsp
        },
        run,
        dispose() {
          save()
          releaseLsp()
          bound?.model.detach(view)
          stopTheme?.()
          window.removeEventListener(TYPOGRAPHY_EVENT, updateAppearance)
          window.removeEventListener('edrv:theme-change', updateAppearance)
          view.destroy()
        },
      }
    },
  }
}
