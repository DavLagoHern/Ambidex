/// <reference types="vite/client" />

interface Window {
  bridge: {
    invoke: (channel: string, ...args: unknown[]) => Promise<any>
    on: (channel: string, fn: (payload: unknown) => void) => () => void
    pathForFile: (file: File) => string
  }
}
