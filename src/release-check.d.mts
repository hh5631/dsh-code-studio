export type ReleaseCheckResult =
  | { ok: true; current: string; latest: string; status: 'available' | 'ahead' | 'current'; releaseUrl: string; downloadUrl: string | null }
  | { ok: false; current: string; error: string }
export function createReleaseChecker(pkg: { name: string; version: string }, request?: typeof fetch): () => Promise<ReleaseCheckResult>
export function installReleaseCheck(ctx: unknown, manifestUrl: URL): void
