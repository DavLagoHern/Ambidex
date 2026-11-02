import { request } from 'http'
import { afterEach, describe, expect, it } from 'vitest'
import { McpServer, ToolError } from '../src/main/mcp-server'

let server: McpServer<{ who: string }> | undefined
afterEach(() => server?.stop())

async function setup() {
  server = new McpServer<{ who: string }>('prueba', [
    { name: 'eco', description: 'Devuelve lo que recibe', inputSchema: { type: 'object' }, run: async (a, ctx) => [{ type: 'text', text: `${ctx.who}: ${a.texto}` }] },
    {
      name: 'falla',
      description: 'Siempre falla',
      inputSchema: { type: 'object' },
      run: async () => {
        throw new ToolError('no se puede')
      }
    }
  ])
  const port = await server.start()
  const token = server.grant({ who: 'claude' })
  const call = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, ...headers },
      body: JSON.stringify(body)
    })
  return { port, token, call }
}

describe('Servidor MCP de la app', () => {
  it('habla MCP: initialize, lista de herramientas y llamadas (también las que fallan)', async () => {
    const { call } = await setup()
    const init = (await (await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x' } } })).json()) as any
    expect(init.result).toMatchObject({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'prueba' } })
    expect((await call({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202)
    const list = (await (await call({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()) as any
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(['eco', 'falla'])
    const r = (await (await call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'eco', arguments: { texto: 'hola' } } })).json()) as any
    expect(r.result.content).toEqual([{ type: 'text', text: 'claude: hola' }])
    const f = (await (await call({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'falla', arguments: {} } })).json()) as any
    expect(f.result).toEqual({ content: [{ type: 'text', text: 'no se puede' }], isError: true })
    const u = (await (await call({ jsonrpc: '2.0', id: 5, method: 'nada' })).json()) as any
    expect(u.error.code).toBe(-32601)
  })

  it('sin la clave del turno, desde una página web o con otro Host, no responde', async () => {
    const { call, port, token } = await setup()
    expect((await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { authorization: 'Bearer otra' })).status).toBe(401)
    expect((await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { origin: 'https://evil.example' })).status).toBe(403)
    // un DNS que apunta a 127.0.0.1 (DNS rebinding) llega con otro Host
    const status = await new Promise<number>((resolve) => {
      const req = request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { host: 'evil.example', authorization: `Bearer ${token}` } }, (res) => (res.resume(), resolve(res.statusCode!)))
      req.end('{}')
    })
    expect(status).toBe(403)
    // al terminar el turno (o si el usuario quita el control) la clave deja de valer
    server!.revokeWhere((c) => c.who === 'claude')
    expect((await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(401)
  })
})
