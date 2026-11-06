import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWebview } from '@tauri-apps/api/webview'

const listeners = new Map<string, Set<(payload: any) => void>>()
export function nativeOn(channel: string, fn: (payload: any) => void) {
  const set = listeners.get(channel) ?? new Set()
  set.add(fn); listeners.set(channel, set)
  return () => { set.delete(fn); if (!set.size) listeners.delete(channel) }
}
export function nativeInvoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  // Keep image bytes out of JSON: millions of numeric values would inflate both JS and Rust heaps.
  if (channel === 'attachments:save') {
    const data = args[0] instanceof Uint8Array ? args[0] : new Uint8Array(args[0] as number[])
    return tauriInvoke<T>('save_attachment', data, { headers: { 'x-ambidex-mime': String(args[1]) } })
  }
  return tauriInvoke<T>('dispatch', { channel, args: args.map(arg => arg instanceof Uint8Array ? Array.from(arg) : arg) })
}
let installed: Promise<void> | undefined
export function installNativeBridge() {
  return installed ??= (async () => {
    await listen<{ channel: string; payload: unknown }>('ambidex:push', ({ payload }) => {
      for (const fn of [...(listeners.get(payload.channel) ?? [])]) fn(payload.payload)
      if (payload.channel === 'native:drop') window.dispatchEvent(new CustomEvent('native-drop', { detail: { ...(payload.payload as object), claimed: false } }))
      if (payload.channel === 'native:error') window.dispatchEvent(new CustomEvent('native-error', { detail: payload.payload }))
    }, { target: { kind: 'Webview', label: getCurrentWebview().label } })
    window.bridge = { invoke: nativeInvoke, on: nativeOn, pathForFile: (file: File) => (file as File & { path?: string }).path || file.webkitRelativePath || file.name }
    // Tauri owns title-bar gestures, including macOS mouse-up handling on double click.
    // Closing the last tab of a floating viewer closes the native window.
    window.close = () => { void nativeInvoke('window:close') }
  })()
}
