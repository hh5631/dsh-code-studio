import { langOf, loadMonaco } from './monaco/loader.js'
import { applyOfficial, editorFont, observeScheme } from './monaco/theme.js'
import { setupLsp, setSession } from './monaco/lsp/index.js'
import { createViewKeeper } from './state/editorViewState.js'
import { TYPOGRAPHY_EVENT } from './typography.js'
import type { EditorCommand, EditorEngine } from './editorTypes.js'

export { disposeLsp } from './monaco/lsp/index.js'
export const editorName = 'Monaco'

const actions: Record<EditorCommand, string> = {
  goToLine: 'editor.action.gotoLine',
  toggleComment: 'editor.action.commentLine',
  duplicateLine: 'editor.action.copyLinesDownAction',
  goToDefinition: 'editor.action.revealDefinition',
  findReferences: 'editor.action.referenceSearch',
}

export async function loadEditorEngine(progress: (message: string) => void): Promise<EditorEngine> {
  const monaco: any = await loadMonaco((stage: { message: string }) => progress(stage.message))
  return {
    createModel(scope, path, content) {
      const uri = monaco.Uri.from({ scheme: 'cstudio', path: '/' + encodeURIComponent(scope) + '/' + path.replace(/^\/+/, '') })
      return monaco.editor.getModel(uri) ?? monaco.editor.createModel(content, 'plaintext', uri)
    },
    mount(host, { scope }) {
      const editor = monaco.editor.create(host, {
        model: null, theme: applyOfficial(monaco), ...editorFont(), automaticLayout: false,
        minimap: { enabled: false }, glyphMargin: false, overviewRulerLanes: 0,
        scrollBeyondLastLine: false, smoothScrolling: true, cursorSmoothCaretAnimation: 'on',
        renderLineHighlight: 'line', folding: true, wordWrap: 'off',
        stickyScroll: { enabled: false }, codeLens: false, padding: { top: 10, bottom: 10 },
      })
      const keeper = createViewKeeper(editor)
      const syncFont = () => { editor.updateOptions(editorFont()); monaco.editor.remeasureFonts?.() }
      const syncTheme = () => { applyOfficial(monaco); syncFont() }
      const stopTheme = observeScheme(syncTheme)
      window.addEventListener(TYPOGRAPHY_EVENT, syncFont)
      window.addEventListener('edrv:theme-change', syncTheme)
      let frame: number | undefined
      const observer = new ResizeObserver(() => {
        if (frame === undefined) frame = requestAnimationFrame(() => { frame = undefined; editor.layout() })
      })
      observer.observe(host)
      return {
        bind(path, model) { keeper.bind(scope, path, model) },
        clear() { keeper.save(); editor.setModel(null) },
        save: keeper.save,
        goTo(lineNumber, column) {
          editor.setPosition({ lineNumber, column }); editor.revealLineInCenter(lineNumber); editor.focus()
        },
        setWrap(enabled) { editor.updateOptions({ wordWrap: enabled ? 'on' : 'off' }) },
        activate(path, model, sessionId) {
          if (editor.getModel() !== model) return
          const language = langOf(path)
          if (editor.getModel().getLanguageId() !== language) monaco.editor.setModelLanguage(model, language)
          void setupLsp(monaco)
          setSession(sessionId)
        },
        run(command) { void editor.getAction(actions[command])?.run() },
        dispose() {
          window.removeEventListener(TYPOGRAPHY_EVENT, syncFont)
          window.removeEventListener('edrv:theme-change', syncTheme)
          observer.disconnect(); stopTheme?.()
          if (frame !== undefined) cancelAnimationFrame(frame)
          keeper.dispose()
        },
      }
    },
  }
}
