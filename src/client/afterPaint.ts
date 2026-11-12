/** Give the browser a chance to paint the loading or editing state before the next stage. */
export function afterPaint(run: () => void): () => void {
  let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(finish) })
  const fallback = setTimeout(finish, 150)
  let active = true
  function cancel() {
    active = false
    cancelAnimationFrame(frame)
    clearTimeout(fallback)
  }
  function finish() { if (active) { cancel(); run() } }
  return cancel
}
