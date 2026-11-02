import { mkdirSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { checkImage, imageDataUrl, MAX_IMAGE, saveImage } from '../src/main/attachments'
import { claudeAdapter } from '../src/main/agents/claude'
import { createCodexAdapter } from '../src/main/agents/codex'
import { tmpDir } from './helpers'

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])

describe('Imágenes adjuntas', () => {
  it('se guardan en la carpeta de la app y se leen como data URL', () => {
    const dir = join(tmpDir('ambidex-att-'), 'attachments')
    const p = saveImage(dir, PNG, 'image/png')
    expect(p.startsWith(dir)).toBe(true)
    expect(p.endsWith('.png')).toBe(true)
    expect(imageDataUrl(dir, p)).toBe(`data:image/png;base64,${Buffer.from(PNG).toString('base64')}`)
  })

  it('no se aceptan otros tipos ni imágenes enormes', () => {
    const dir = tmpDir('ambidex-att-')
    expect(() => saveImage(dir, PNG, 'application/pdf')).toThrow(/PNG, JPEG, GIF o WebP/)
    expect(() => saveImage(dir, new Uint8Array(MAX_IMAGE + 1), 'image/png')).toThrow(/demasiado/)
  })

  it('al agente solo llegan rutas de la carpeta de adjuntos', () => {
    const base = tmpDir('ambidex-att-')
    const dir = join(base, 'attachments')
    mkdirSync(dir)
    const outside = join(base, 'secreto.png')
    writeFileSync(outside, PNG)
    expect(() => checkImage(dir, outside)).toThrow(/no es un adjunto/)
    expect(() => checkImage(dir, join(dir, '..', 'secreto.png'))).toThrow(/no es un adjunto/)
    // un enlace dentro de la carpeta que apunta fuera tampoco vale
    symlinkSync(outside, join(dir, 'enlace.png'))
    expect(() => checkImage(dir, join(dir, 'enlace.png'))).toThrow(/no es un adjunto/)
    const txt = join(dir, 'nota.txt')
    writeFileSync(txt, 'x')
    expect(() => checkImage(dir, txt)).toThrow(/no admitido/)
    expect(() => checkImage(dir, join(dir, 'no-existe.png'))).toThrow(/ya no existe/)
  })

  it('Claude recibe el mensaje como JSON con la imagen en base64', () => {
    const dir = join(tmpDir('ambidex-att-'), 'attachments')
    const img = saveImage(dir, PNG, 'image/png')
    const req = { cwd: dir, images: [img] }
    const args = claudeAdapter.buildArgs(req)
    expect(args.join(' ')).toContain('--input-format stream-json')
    expect(args.join(' ')).toContain('--output-format stream-json')
    const line = JSON.parse(claudeAdapter.stdin!('¿Qué ves?', req))
    expect(line.type).toBe('user')
    expect(line.message.content[0]).toEqual({ type: 'text', text: '¿Qué ves?' })
    expect(line.message.content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from(PNG).toString('base64') } })
    // sin imágenes no cambia nada: el texto tal cual
    expect(claudeAdapter.buildArgs({ cwd: dir })).not.toContain('--input-format')
    expect(claudeAdapter.stdin!('hola', { cwd: dir })).toBe('hola')
  })

  it('Codex recibe --image=ruta antes del «-» del prompt, también al continuar', () => {
    const codex = createCodexAdapter(tmpDir('ambidex-codexhome-'))
    const a = codex.buildArgs({ cwd: '/tmp', images: ['/a/b.png', '/a/c.jpg'] })
    expect(a.slice(-3)).toEqual(['--image=/a/b.png', '--image=/a/c.jpg', '-'])
    const r = codex.buildArgs({ cwd: '/tmp', resumeId: 'abc', images: ['/a/b.png'] })
    expect(r.slice(0, 2)).toEqual(['exec', 'resume'])
    expect(r.slice(-3)).toEqual(['--image=/a/b.png', 'abc', '-'])
  })
})
