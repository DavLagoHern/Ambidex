import { EventEmitter } from 'events'
import type { WebContents } from '../main/web-agent'
import type { WebIssue } from '@shared/types'

type Host = (channel: string, ...args: unknown[]) => Promise<any>
class Page extends EventEmitter implements WebContents {
  constructor(readonly id: number, private host: Host, public state: any) { super() }
  isDestroyed() { return !!this.state.destroyed }
  isLoading() { return !!this.state.loading }
  getURL() { return this.state.url || 'about:blank' }
  async loadURL(url: string) { await this.host('browser:navigate', this.id, url) }
  executeJavaScript(script: string, _gesture?: boolean): Promise<any> { return this.host('browser:eval', this.id, script) }
  sendInputEvent(event: Record<string, unknown>) { void this.host('browser:input', this.id, event).catch(() => {}) }
  insertText(text: string) { return this.host('browser:insertText', this.id, text) }
  navigationHistory = {
    canGoBack: () => !!this.state.back,
    goBack: () => { void this.host('browser:back', this.id) }
  }
  async capturePage() {
    const data = await this.host('browser:screenshot', this.id)
    const buf = Buffer.from(data, 'base64')
    const img = { isEmpty: () => !buf.length, getSize: () => ({ width: 0 }), resize: (_o: unknown) => img, toPNG: () => buf }
    return img
  }
}
export class NativeBrowser {
  private pages = new Map<number, Page>()
  private active = new Map<string, number>()
  constructor(private host: Host) {}
  update(data: any) {
    if (data.projectId) {
      if (data.id === null) this.active.delete(data.projectId)
      else this.active.set(data.projectId, data.id)
    }
    if (typeof data.id !== 'number') return
    const p = this.pages.get(data.id) ?? new Page(data.id, this.host, {})
    this.pages.set(data.id, p)
    p.state = { ...p.state, ...data }
    if (data.loading === false) p.emit('did-stop-loading')
    if (data.destroyed) { this.pages.delete(data.id); p.emit('destroyed') }
  }
  tab(project: string) { return this.pages.get(this.active.get(project) ?? -1) }
  async open(project: string, url: string): Promise<Page> {
    let page = this.tab(project)
    if (page) { await page.loadURL(url); return page }
    await this.host('browser:openProject', project, url)
    const end = Date.now() + 15000
    while (Date.now() < end) {
      page = this.tab(project)
      if (page) return page
      await new Promise(r => setTimeout(r, 50))
    }
    throw new Error('El visor web del proyecto no se abrió')
  }
  issues(wc: WebContents): WebIssue[] { return this.pages.get(wc.id)?.state.issues ?? [] }
}
