import { randomBytes } from 'crypto'
import { createServer, IncomingMessage, Server, ServerResponse } from 'http'
import type { AddressInfo } from 'net'

// Servidor MCP mínimo (transporte HTTP «streamable» respondiendo en JSON) para dar herramientas propias de la app
// a Claude Code y Codex durante un turno. Solo escucha en 127.0.0.1 y cada turno tiene su clave, que deja de valer
// al terminar. Rechaza peticiones con cabecera Origin (las haría una página web) y con un Host que no sea el suyo.

export interface McpTool<C> {
  name: string
  description: string
  inputSchema: object
  run: (args: any, ctx: C) => Promise<McpContent[]>
}

export type McpContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

export class ToolError extends Error {}

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']
const MAX_BODY = 1024 * 1024

export class McpServer<C> {
  private server?: Server
  private port = 0
  private grants = new Map<string, C>()

  constructor(
    private name: string,
    private tools: McpTool<C>[]
  ) {}

  async start(): Promise<number> {
    if (this.server) return this.port
    this.server = createServer((req, res) => this.handle(req, res))
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r))
    this.port = (this.server.address() as AddressInfo).port
    return this.port
  }

  stop() {
    this.server?.close()
    this.server = undefined
    this.grants.clear()
  }

  get started() {
    return !!this.server && this.port > 0
  }

  get url() {
    return `http://127.0.0.1:${this.port}/mcp`
  }

  // una clave para un turno; `revoke` la anula (al terminar o si el usuario quita el control)
  grant(ctx: C): string {
    const token = randomBytes(24).toString('base64url')
    this.grants.set(token, ctx)
    return token
  }

  revoke(token: string) {
    this.grants.delete(token)
  }

  revokeWhere(pred: (ctx: C) => boolean) {
    for (const [t, c] of this.grants) if (pred(c)) this.grants.delete(t)
  }

  private send(res: ServerResponse, status: number, body?: unknown) {
    res.statusCode = status
    if (body === undefined) return res.end()
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(body))
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    if (req.headers.origin || req.headers.host !== `127.0.0.1:${this.port}` || (req.url ?? '').split('?')[0] !== '/mcp') return this.send(res, 403)
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
    const ctx = this.grants.get(token)
    if (!ctx) return this.send(res, 401, { error: 'El turno terminó o el usuario retiró el control' })
    // sin flujo de eventos: todo se responde en la propia petición
    if (req.method === 'GET') return this.send(res, 405)
    if (req.method === 'DELETE') return this.send(res, 200)
    if (req.method !== 'POST') return this.send(res, 405)
    let raw = ''
    for await (const chunk of req) {
      raw += chunk
      if (raw.length > MAX_BODY) return this.send(res, 413)
    }
    let msg: any
    try {
      msg = JSON.parse(raw)
    } catch {
      return this.send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON no válido' } })
    }
    const batch = Array.isArray(msg)
    const replies = (await Promise.all((batch ? msg : [msg]).map((m: any) => this.rpc(m, ctx)))).filter(Boolean)
    if (!replies.length) return this.send(res, 202)
    this.send(res, 200, batch ? replies : replies[0])
  }

  private async rpc(m: any, ctx: C): Promise<object | null> {
    const id = m?.id
    // notificaciones (sin id): no llevan respuesta
    if (id === undefined || id === null) return null
    const ok = (result: object) => ({ jsonrpc: '2.0', id, result })
    const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } })
    switch (m.method) {
      case 'initialize': {
        const asked = m.params?.protocolVersion
        return ok({
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: this.name, version: '1.0.0' }
        })
      }
      case 'ping':
        return ok({})
      case 'tools/list':
        return ok({ tools: this.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
      case 'tools/call': {
        const tool = this.tools.find((t) => t.name === m.params?.name)
        if (!tool) return fail(-32602, `Herramienta desconocida: ${m.params?.name}`)
        try {
          return ok({ content: await tool.run(m.params?.arguments ?? {}, ctx) })
        } catch (e) {
          // los fallos de la herramienta se le cuentan al agente para que lo intente de otra forma
          return ok({ content: [{ type: 'text', text: (e as Error).message }], isError: true })
        }
      }
      default:
        return fail(-32601, `Método no soportado: ${m.method}`)
    }
  }
}
