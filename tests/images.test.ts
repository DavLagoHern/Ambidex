import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { claudeAdapter } from '../src/main/agents/claude'
import { createCodexAdapter } from '../src/main/agents/codex'
import { cleanFileRef, toolImages } from '../src/shared/images'
import { collapseTurn } from '../src/shared/turn-layout'
import { requestsImageGeneration } from '../src/shared/router'

describe('images in agent conversations', () => {
  it('scans long non-image paths without blocking conversation restoration', () => {
    // A subprocess timeout also catches a synchronous regexp hang (a test timeout cannot).
    const moduleUrl = pathToFileURL(resolve('src/shared/images.ts')).href
    const result = execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `
      import { toolImages } from ${JSON.stringify(moduleUrl)};
      const output = ('/Users/me/project/' + 'directory/'.repeat(80) + 'source.ts:42\\n').repeat(1000);
      process.stdout.write(JSON.stringify(toolImages(output + 'Saved to /tmp/result.png')));
    `], { encoding: 'utf8', timeout: 3000 })
    expect(JSON.parse(result)).toEqual(['/tmp/result.png'])
  })
  it('extracts quoted paths with punctuation and stops at twenty images', () => {
    expect(toolImages('Saved " /tmp/a.png", then `/tmp/b.webp`.')).toEqual(['/tmp/a.png', '/tmp/b.webp'])
    expect(toolImages(Array.from({ length: 30 }, (_, i) => `Saved /tmp/${i}.png`).join('\n'))).toHaveLength(20)
  })
  it('cleans angle-bracket and URI paths without changing spaces', () => {
    expect(cleanFileRef('<file:///Users/me/My%20Image.png>')).toBe('/Users/me/My Image.png')
  })
  it('preserves Claude and MCP image content and generated file paths', () => {
    expect(toolImages([{ type: 'image', source: { media_type: 'image/png', data: 'AAAA' } }])).toContain('data:image/png;base64,AAAA')
    expect(toolImages({ content: [{ type: 'image', mimeType: 'image/jpeg', data: 'BBBB' }] })).toContain('data:image/jpeg;base64,BBBB')
    expect(toolImages('Saved to /Users/me/.codex/generated_images/run/image.png')).toEqual(['/Users/me/.codex/generated_images/run/image.png'])
  })
  it('carries images through both CLI parsers', () => {
    const claude = claudeAdapter.createParser()
    const result = claude.onLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'img', content: [{ type: 'image', source: { media_type: 'image/png', data: 'AAAA' } }] }] } }))
    expect(result[0]).toMatchObject({ kind: 'tool', images: ['data:image/png;base64,AAAA'] })
    const codex = createCodexAdapter('/tmp').createParser()
    expect(codex.onLine(JSON.stringify({ type: 'item.completed', item: { id: 'img', type: 'image_generation', result: 'AAAA' } }))[0]).toMatchObject({ kind: 'tool', images: ['data:image/png;base64,AAAA'] })
    expect(toolImages('/tmp/My Picture.png')).toEqual(['/tmp/My Picture.png'])
  })
  it('folds tool images with actions while keeping response images visible', () => {
    const image = { id: '1', type: 'tool' as const, toolId: '1', name: 'Read', input: '/tmp/a.png', output: '[image]', status: 'done' as const }
    const answer = { id: '2', type: 'assistant' as const, text: 'Listo' }
    expect(collapseTurn([image, answer], true)[0]).toMatchObject({ kind: 'steps', steps: [image] })
    expect(collapseTurn([image, answer], false)[0]).toMatchObject({ kind: 'steps', steps: [image] })
    const responseImage = { id: '3', type: 'assistant' as const, text: '![Resultado](/tmp/result.png)' }
    expect(collapseTurn([image, responseImage, answer], true)[1]).toEqual({ kind: 'item', item: responseImage })
  })
  it('routes generation requests without treating display bugs as generation', () => {
    for (const text of ['créame una imagen', 'creame una imagen', 'genera una imagen', 'edita esta foto', 'create an image']) {
      expect(requestsImageGeneration(text.normalize('NFD').replace(/\p{Diacritic}/gu, ''))).toBe(true)
    }
    expect(requestsImageGeneration('quiero ver la imagen en el chat')).toBe(false)
    expect(requestsImageGeneration('por qué no se ve la imagen')).toBe(false)
  })
})
