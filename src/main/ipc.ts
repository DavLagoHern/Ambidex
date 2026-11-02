import { ipcMain, IpcMainInvokeEvent } from 'electron'
import type { IpcArgs, IpcChannel, IpcResult, SenderChannel } from '@shared/ipc'
import { logger } from './logger'

// Todos los canales del contrato deben tener implementación: si falta uno, no compila
export type Handlers = {
  [K in Exclude<IpcChannel, SenderChannel>]: (...args: IpcArgs<K>) => IpcResult<K> | Promise<IpcResult<K>>
}
export type SenderHandlers = {
  [K in SenderChannel]: (e: IpcMainInvokeEvent, ...args: IpcArgs<K>) => IpcResult<K> | Promise<IpcResult<K>>
}

const QUIET = /^(fs:read|fs:list|git:status|git:numstat|git:show|git:log|git:listFiles|term:)/

export function registerHandlers(h: Handlers, withSender: SenderHandlers, isTrusted: (e: IpcMainInvokeEvent) => boolean) {
  type Fn = (e: IpcMainInvokeEvent, ...args: unknown[]) => unknown
  const all: (readonly [IpcChannel, Fn])[] = [
    ...Object.entries(h).map(([c, fn]) => [c as IpcChannel, ((_e, ...args) => (fn as (...a: unknown[]) => unknown)(...args)) as Fn] as const),
    ...Object.entries(withSender).map(([c, fn]) => [c as IpcChannel, fn as Fn] as const)
  ]
  for (const [channel, fn] of all) {
    ipcMain.handle(channel, async (e, ...args) => {
      if (!isTrusted(e)) throw new Error('Origen no permitido')
      try {
        return await fn(e, ...args)
      } catch (err) {
        if (!QUIET.test(channel)) logger.warn('ipc.error', { channel, error: (err as Error).message })
        throw err
      }
    })
  }
}
