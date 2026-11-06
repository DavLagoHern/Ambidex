import { nativeInvoke, nativeOn } from './native'

/** DOM placeholder whose actual page is a separate, unprivileged native WebKit child. */
export interface NativePage extends HTMLDivElement {
  loadURL(url: string): Promise<void>
  getURL(): string
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  reload(): void
  stop(): void
  isLoading(): boolean
  getWebContentsId(): number
}
export function attachNativePage(el: HTMLDivElement, url: string, onError: (message: string) => void): () => void {
  const id = crypto.getRandomValues(new Uint32Array(1))[0] * 0x100000 + (crypto.getRandomValues(new Uint32Array(1))[0] & 0xfffff)
  let state = { url, back: false, fwd: false, loading: true, title: '' }
  let created = false, disposed = false, lastBounds = '', updating = false
  const call = (channel: string, ...args: unknown[]) => nativeInvoke(channel, id, ...args)
  const fire = (type: string, values: object = {}) => el.dispatchEvent(Object.assign(new Event(type), values))
  Object.assign(el, {
    loadURL: (next: string) => call('browser:navigate', next), getURL: () => state.url,
    canGoBack: () => state.back, canGoForward: () => state.fwd,
    goBack: () => void call('browser:back'), goForward: () => void call('browser:forward'),
    reload: () => void call('browser:reload'), stop: () => void call('browser:stop'),
    isLoading: () => state.loading, getWebContentsId: () => id
  })
  const off = nativeOn('browser:state', (patch: typeof state & { id: number }) => {
    if (patch.id !== id || disposed) return
    const before = state; state = { ...state, ...patch }
    if (state.url !== before.url) fire('did-navigate', { url: state.url, isMainFrame: true })
    if (state.title !== before.title) fire('page-title-updated', { title: state.title })
    fire(state.loading ? 'did-start-loading' : 'did-stop-loading')
    if (!state.loading) fire('dom-ready')
    bounds()
  })
  const bounds = () => {
    if (!created || disposed || updating) return
    const r = el.getBoundingClientRect()
    const visible = !!el.offsetParent && getComputedStyle(el).visibility === 'visible' && state.url !== 'about:blank' && r.width > 1 && r.height > 1 && !document.querySelector('.overlay,.dock-overlay,.web-issues,.web-error') && !document.body.classList.contains('dock-dragging') && !document.body.classList.contains('dragging')
    const rect = { x: r.x, y: r.y, width: r.width, height: r.height, visible }
    const key = JSON.stringify(rect)
    if (key === lastBounds) return
    lastBounds = key; updating = true
    void call('browser:bounds', rect).catch(e => onError(String(e))).finally(() => { updating = false; requestAnimationFrame(bounds) })
  }
  const resize = new ResizeObserver(bounds); resize.observe(el)
  const mutation = new MutationObserver(bounds); mutation.observe(document.body, { attributes: true, childList: true, subtree: true, attributeFilter: ['class', 'style'] })
  window.addEventListener('resize', bounds); window.addEventListener('scroll', bounds, true)
  void call('browser:create', url).then(async () => {
    created = true
    if (disposed) { await call('browser:close'); return }
    fire('dom-ready'); bounds()
  }).catch(e => { if (!disposed) onError(String(e)) })
  return () => {
    disposed = true; off(); resize.disconnect(); mutation.disconnect()
    window.removeEventListener('resize', bounds); window.removeEventListener('scroll', bounds, true)
    if (created) void call('browser:close').catch(() => {})
  }
}
