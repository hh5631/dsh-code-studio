import { describe, expect, it, vi } from 'vitest'
import { createFileOpenerRegistry, selectOpener, officialSidebarOpener, OFFICIAL_OPEN_TOOL } from '../src/client/fileOpeners.js'
import { installOpenPathRouter, vscodeOpener } from '../src/client/openPathRouter.js'

describe('file opener registry', () => {
  it('sorts available openers and falls back from unavailable selection', () => {
    const registry = createFileOpenerRegistry()
    registry.register({ id: 'system', label: 'System', priority: 0, open: vi.fn() })
    registry.register({ id: 'editor', label: 'Editor', priority: 10, isAvailable: () => false, open: vi.fn() })
    expect(selectOpener(registry, 'editor')?.id).toBe('system')
  })

  it('removes an opener with its disposer', () => {
    const registry = createFileOpenerRegistry()
    const dispose = registry.register({ id: 'x', label: 'X', open: vi.fn() })
    expect(registry.get('x')).toBeDefined()
    dispose()
    expect(registry.get('x')).toBeUndefined()
  })
})

describe('open path router', () => {
  it('routes to selected opener and restores the original method', async () => {
    const original = vi.fn(async () => {})
    const selected = vi.fn(async () => {})
    const workspaces = { openPath: original }
    const registry = createFileOpenerRegistry()
    registry.register({ id: 'selected', label: 'Selected', open: selected })
    const dispose = installOpenPathRouter({
      workspaces,
      registry,
      selected: () => 'selected',
      context: () => ({ sessionId: 's1' }),
    })
    await workspaces.openPath('a.ts')
    expect(selected).toHaveBeenCalledWith('a.ts', { sessionId: 's1' })
    dispose()
    expect(workspaces.openPath).toBe(original)
  })
})

describe('official sidebar opener', () => {
  it('opens via openResource with a session address for relative paths', () => {
    const openResource = vi.fn()
    const opener = officialSidebarOpener({ openResource })
    expect(opener.id).toBe(OFFICIAL_OPEN_TOOL)
    opener.open!('src/a b.ts', { sessionId: 's1' })
    expect(openResource).toHaveBeenCalledWith('dsh-resource://file/session/s1/src/a%20b.ts')
  })
  it('keeps absolute paths under the session address required by native preview', () => {
    const openResource = vi.fn()
    const opener = officialSidebarOpener({ openResource })
    opener.open!('C:\\repo\\x.ts', { sessionId: 's1' })
    expect(openResource).toHaveBeenCalledWith('dsh-resource://file/session/s1/C:/repo/x.ts')
    opener.open!('/repo/src/a b.ts', { sessionId: 's1', cwd: '/repo' })
    expect(openResource).toHaveBeenLastCalledWith('dsh-resource://file/session/s1/src/a%20b.ts')
  })
  it('throws for relative path without session (routing falls back)', () => {
    const opener = officialSidebarOpener({ openResource: vi.fn() })
    expect(() => opener.open!('src/a.ts', {})).toThrow()
  })
})

describe('automatic file opening', () => {
  it('prefers native preview over Code Studio when DSH provides it', () => {
    const registry = createFileOpenerRegistry()
    registry.register(vscodeOpener())
    registry.register(officialSidebarOpener({ openResource: vi.fn() }))
    expect(selectOpener(registry, 'auto')?.id).toBe(OFFICIAL_OPEN_TOOL)
  })
})
