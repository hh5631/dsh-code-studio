import { cpp } from '@codemirror/lang-cpp'
import { javascript, tsxLanguage } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { LanguageDescription, LanguageSupport, StreamLanguage } from '@codemirror/language'
import { csharp, java } from '@codemirror/legacy-modes/mode/clike'
import { css, sCSS, less } from '@codemirror/legacy-modes/mode/css'
import { go } from '@codemirror/legacy-modes/mode/go'
import { lua } from '@codemirror/legacy-modes/mode/lua'
import { python } from '@codemirror/legacy-modes/mode/python'
import { rust } from '@codemirror/legacy-modes/mode/rust'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { standardSQL } from '@codemirror/legacy-modes/mode/sql'
import { html, xml } from '@codemirror/legacy-modes/mode/xml'
import { yaml } from '@codemirror/legacy-modes/mode/yaml'
import type { Extension } from '@codemirror/state'
import { langOf } from '../fileLanguages.js'

const js = javascript({ jsx: true })
const ts = new LanguageSupport(tsxLanguage)
const cppMode = cpp()
const jsonMode = json()

const fencedLanguages = [
  LanguageDescription.of({ name: 'JavaScript', alias: ['js', 'jsx'], support: js }),
  LanguageDescription.of({ name: 'TypeScript', alias: ['ts', 'tsx'], support: ts }),
  LanguageDescription.of({ name: 'C++', alias: ['c', 'cpp'], support: cppMode }),
  LanguageDescription.of({ name: 'JSON', support: jsonMode }),
]

const modes: Record<string, Extension> = {
  javascript: js, typescript: ts, json: jsonMode, c: cppMode, cpp: cppMode,
  markdown: markdown({ codeLanguages: fencedLanguages }),
  csharp: StreamLanguage.define(csharp), java: StreamLanguage.define(java),
  css: StreamLanguage.define(css), scss: StreamLanguage.define(sCSS), less: StreamLanguage.define(less),
  go: StreamLanguage.define(go), lua: StreamLanguage.define(lua), python: StreamLanguage.define(python),
  rust: StreamLanguage.define(rust), shell: StreamLanguage.define(shell), sql: StreamLanguage.define(standardSQL),
  html: StreamLanguage.define(html), xml: StreamLanguage.define(xml), yaml: StreamLanguage.define(yaml),
}

export function languageFor(path: string): Extension {
  return modes[langOf(path)] ?? []
}
