import { contextBridge, ipcRenderer, IpcRendererEvent, webUtils } from 'electron'

const PUSH = new Set(['session:items', 'session:meta', 'run:status', 'limits', 'fs:changed', 'term:data', 'term:exit', 'menu', 'focus-project', 'thread:meta', 'queue:changed', 'orch:update', 'open-path', 'web:open', 'web:key', 'web:issue', 'web:agent-open', 'web:agent', 'panel:closed', 'panel:sync', 'jev:status', 'cli:update', 'self:update'])

contextBridge.exposeInMainWorld('bridge', {
  invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
  on: (channel: string, fn: (payload: unknown) => void) => {
    if (!PUSH.has(channel)) throw new Error(`Canal no permitido: ${channel}`)
    const listener = (_e: IpcRendererEvent, payload: unknown) => fn(payload)
    ipcRenderer.on(channel, listener)
    return () => {
      ipcRenderer.removeListener(channel, listener)
    }
  },
  // ruta real de un fichero soltado desde Finder
  pathForFile: (file: File) => webUtils.getPathForFile(file)
})
