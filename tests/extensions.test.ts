import { mkdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { describe, expect, it } from 'vitest'
import { frontmatter, scanExtensions } from '../src/main/extensions'
import { parseToml } from '../src/main/toml-lite'
import { tmpDir } from './helpers'

const put = (f: string, c: string) => (mkdirSync(dirname(f), { recursive: true }), writeFileSync(f, c))

describe('Extensiones de cada CLI', () => {
  it('lee el TOML de config.toml de Codex', () => {
    const t = parseToml(`
model = "gpt-6" # comentario
[mcp_servers.godot]
command = "node"
args = [
  "server.js", # el servidor
  "--port=1"
]
enabled = false
[mcp_servers.godot.env]
TOKEN = "secreto"
[mcp_servers."con puntos.v2"]
url = "https://x/mcp"
[plugins."github@openai-curated"]
enabled = true
[projects."/Users/a/b"]
trust_level = "trusted"
inline = { a = 1, b = ["x", "y"], c = { d = true } }
`) as any
    expect(t.model).toBe('gpt-6')
    expect(t.mcp_servers.godot).toMatchObject({ command: 'node', args: ['server.js', '--port=1'], enabled: false })
    expect(t.mcp_servers['con puntos.v2'].url).toBe('https://x/mcp')
    expect(t.plugins['github@openai-curated'].enabled).toBe(true)
    expect(t.projects['/Users/a/b'].inline).toEqual({ a: 1, b: ['x', 'y'], c: { d: true } })
  })

  it('lee la cabecera de skills y agentes, también en varias líneas', () => {
    expect(frontmatter('---\nname: revisa\ndescription: >\n  Revisa el código\n  con calma\nmodel: inherit\n---\ncuerpo')).toEqual({
      name: 'revisa',
      description: 'Revisa el código con calma',
      model: 'inherit'
    })
    expect(frontmatter('sin cabecera')).toEqual({})
  })

  it('encuentra plugins, skills, agentes, comandos, MCP, hooks e instrucciones sin enseñar secretos', () => {
    const home = tmpDir('ambidex-home-')
    const project = tmpDir('ambidex-proj-')
    const plugin = join(home, '.claude', 'plugins', 'cache', 'mkt', 'tools', '1.0.0')
    put(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'tools@mkt': [{ scope: 'user', installPath: plugin, version: '1.0.0' }] } }))
    put(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'tools', description: 'Herramientas' }))
    put(join(plugin, 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: Despliega\n---\n')
    put(join(plugin, 'agents', 'revisor.md'), '---\nname: revisor\ndescription: Revisa PRs\n---\n')
    put(join(plugin, '.mcp.json'), JSON.stringify({ mcpServers: { db: { command: 'node', args: ['db.js'], env: { DB_PASSWORD: 'super-secreto' } } } }))
    put(join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'tools@mkt': false }, hooks: { PreToolUse: [{ matcher: 'Bash' }] } }))
    put(join(home, '.claude', 'skills', 'mia', 'SKILL.md'), '---\nname: mia\n---\n')
    put(join(home, '.claude', 'commands', 'git', 'pr.md'), '---\ndescription: Abre un PR\n---\n')
    put(join(home, '.claude.json'), JSON.stringify({ mcpServers: { api: { type: 'http', url: 'https://api.x/mcp?token=abc123', headers: { Authorization: 'Bearer zzz' } } } }))
    put(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { local: { command: 'python', args: ['srv.py'] } } }))
    put(join(project, 'CLAUDE.md'), '# Reglas\n')
    put(join(project, 'AGENTS.md'), '# Reglas\n')
    const codex = join(home, '.codex')
    put(join(codex, 'config.toml'), '[mcp_servers.repl]\ncommand = "node"\n[mcp_servers.repl.env]\nKEY = "otro-secreto"\n[plugins."gh@cur"]\nenabled = true\n')
    put(join(codex, 'plugins', 'cache', 'cur', 'gh', 'abc', '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'gh', version: '0.1', interface: { displayName: 'GitHub' } }))
    put(join(codex, 'plugins', 'cache', 'cur', 'otro', 'abc', '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'otro' }))
    put(join(codex, 'skills', '.system', 'imagegen', 'SKILL.md'), '---\nname: imagegen\n---\n')

    const r = scanExtensions(home, codex, project)
    const c = r.claude.map((i) => `${i.kind}:${i.name}:${i.source}`)
    expect(c).toEqual(
      expect.arrayContaining([
        'plugin:tools:Marketplace mkt',
        'skill:deploy:Plugin tools',
        'agent:revisor:Plugin tools',
        'mcp:db:Plugin tools',
        'hook:PreToolUse:Usuario',
        'skill:mia:Usuario',
        'command:/git:pr:Usuario',
        'mcp:api:Usuario',
        'mcp:local:Proyecto',
        'instructions:CLAUDE.md:Proyecto'
      ])
    )
    expect(r.claude.find((i) => i.kind === 'plugin')?.enabled).toBe(false)
    const x = r.codex.map((i) => `${i.kind}:${i.name}:${i.source}`)
    expect(x).toEqual(expect.arrayContaining(['plugin:GitHub:Marketplace cur', 'mcp:repl:Usuario', 'skill:imagegen:Sistema', 'instructions:AGENTS.md:Proyecto']))
    // la caché trae plugins del catálogo que no están instalados: no salen
    expect(x.some((i) => i.includes('otro'))).toBe(false)
    const all = JSON.stringify(r)
    for (const secret of ['super-secreto', 'otro-secreto', 'abc123', 'Bearer zzz']) expect(all).not.toContain(secret)
    expect(r.errors).toEqual([])
  })
})
