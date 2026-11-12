import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkArtifacts, inspectArtifacts, verifyNativeLoader } from '../scripts/check-client-artifacts.mjs'

const directories: string[] = []
const OWNER = 'dsh-code-studio'
const EDITOR = 'client.editor.js'
const root = `window.__ModuleLoader__.load({id:'${OWNER}',factory:(require)=>{
  const exports = { __lazyShared: {rpc(){},dbg(){},ContextMenu(){}}, __editorShared: { workspaceRuntime: {minimalWorkspace(){}} }, __setEditorImport(){} };
  exports.__setEditorImport(require.async?.bind(require)); return exports;
}});`

function chunk(name = EDITOR): string {
  return `window.__ModuleLoader__.load({id:'${OWNER}',chunk:'${name}',factory:(require)=>{
    const {minimalWorkspace} = require('${OWNER}').__editorShared.workspaceRuntime;
    return {EditorView:function(){return minimalWorkspace}};
  }});`
}

/** @private @author ddj 2026年10月22号 @returns Isolated fixture artifacts; no project lib changes. */
async function fixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'edrv-artifacts-'))
  directories.push(directory)
  await Promise.all([
    writeFile(join(directory, 'index.js'), "export const name='dsh-code-studio'; export const inject=[]; export function apply(){}"),
    writeFile(join(directory, 'client.js'), root),
    writeFile(join(directory, EDITOR), chunk()),
  ])
  return directory
}

/** @private @author ddj 2026年10月22号 @returns Remove only exact temporary directories created by these tests. */
async function cleanup(): Promise<void> {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
}
afterEach(cleanup)

describe('client artifact registration contract', () => {
  it('accepts the root and on-demand editor chunk', async () => {
    const result = await checkArtifacts(await fixture())
    expect(Object.keys(result.bytes)).toEqual(['index.js', 'client.js', EDITOR])
    expect(result.native).toHaveProperty('skipped')
  })
  it('rejects missing and empty mandatory artifacts', async () => {
    const directory = await fixture()
    await writeFile(join(directory, 'index.js'), '')
    await expect(inspectArtifacts(directory)).rejects.toThrow('index.js: empty artifact')
    await rm(join(directory, 'index.js'))
    await expect(inspectArtifacts(directory)).rejects.toThrow()
  })
  it('rejects malformed Host artifacts and missing plugin exports without executing them', async () => {
    const directory = await fixture()
    await writeFile(join(directory, 'index.js'), 'export function apply( {')
    await expect(inspectArtifacts(directory)).rejects.toThrow('malformed JavaScript')
    await writeFile(join(directory, 'index.js'), 'throw new Error("must never execute"); export function apply(){}')
    await expect(inspectArtifacts(directory)).rejects.toThrow('missing plugin export name')
    await writeFile(join(directory, 'index.js'), 'export const name="p",inject=[],apply=42')
    await expect(inspectArtifacts(directory)).rejects.toThrow('apply export must resolve to a function')
  })
  it('rejects mismatched chunk registration', async () => {
    const directory = await fixture()
    await writeFile(join(directory, EDITOR), chunk('client.wrong.js'))
    await expect(inspectArtifacts(directory)).rejects.toThrow('wrong chunk registration')
  })
  it('rejects wrong owners and duplicate registrations', async () => {
    const directory = await fixture()
    await writeFile(join(directory, 'client.js'), root.replace(OWNER, 'wrong-owner'))
    await expect(inspectArtifacts(directory)).rejects.toThrow('wrong owner')
    await writeFile(join(directory, 'client.js'), root + root)
    await expect(inspectArtifacts(directory)).rejects.toThrow('exactly one registration')
  })
  it('rejects root registered as a chunk and missing native import injection', async () => {
    const directory = await fixture()
    await writeFile(join(directory, 'client.js'), root.replace('factory:', "chunk:'client.root.js',factory:"))
    await expect(inspectArtifacts(directory)).rejects.toThrow('root must not register as a chunk')
    await writeFile(join(directory, 'client.js'), root.replace('require.async?.bind(require)', 'undefined'))
    await expect(inspectArtifacts(directory)).rejects.toThrow('native asynchronous require')
  })
  it('rejects missing shared bridges and copied singleton implementation', async () => {
    const directory = await fixture()
    await writeFile(join(directory, EDITOR), chunk().replace('__editorShared', 'wrong'))
    await expect(inspectArtifacts(directory)).rejects.toThrow('missing shared bridge')
    await writeFile(join(directory, EDITOR), chunk() + '\nfunction rpc(){}')
    await expect(inspectArtifacts(directory)).rejects.toThrow('duplicated singleton')
  })
  it('ignores import/require text in comments and string literals but rejects executable dynamic import', async () => {
    const directory = await fixture()
    const harmless = '\n// import("node:fs"); require("node:fs")\nconst text = \'import("node:fs")\';'
    await writeFile(join(directory, 'client.js'), root + harmless)
    await expect(inspectArtifacts(directory)).resolves.toHaveProperty('root')
    await writeFile(join(directory, 'client.js'), root + '\nimport("./bad.js")')
    await expect(inspectArtifacts(directory)).rejects.toThrow('native ESM dynamic import')
  })
  it('rejects executable unexpected externals', async () => {
    const directory = await fixture()
    await writeFile(join(directory, EDITOR), chunk() + '\nrequire("node:fs")')
    await expect(inspectArtifacts(directory)).rejects.toThrow('unexpected external node:fs')
  })
  it('rejects bare ESM rather than treating it as a loader bundle', async () => {
    const directory = await fixture()
    await writeFile(join(directory, EDITOR), 'export const EditorView = () => null')
    await expect(inspectArtifacts(directory)).rejects.toThrow()
  })
})

const loaderPath = process.env.EDRV_MODULE_LOADER
const artifactDir = process.env.EDRV_ARTIFACT_DIR

describe('explicit actual Host loader validation', () => {
  it.skipIf(!loaderPath)('uses actual ClientModuleSystem for URL, cache, retry, and HMR fixtures (requires EDRV_MODULE_LOADER)', async () => {
    const evidence = await verifyNativeLoader(await inspectArtifacts(await fixture()), loaderPath!)
    expect(evidence.arrivals).toHaveLength(4)
    expect(evidence.arrivals.at(-1)).toContain(`${EDITOR}?rev=two`)
  })
  it.skipIf(!artifactDir)('validates explicitly requested real build artifacts (requires EDRV_ARTIFACT_DIR)', async () => {
    const evidence = await checkArtifacts(artifactDir!, loaderPath)
    expect(evidence.bytes[EDITOR]).toBeGreaterThan(0)
    if (loaderPath) expect(evidence.native.loader).toBe('actual ClientModuleSystem')
  })
})
