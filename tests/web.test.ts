import { describe, expect, it } from 'vitest'
import { findLinks, isLocalUrl, isWebUrl, normalizeAddress, shortUrl } from '../src/shared/web'

describe('visor web', () => {
  it('normaliza lo que se escribe en la barra de direcciones', () => {
    expect(normalizeAddress('google.es')).toBe('https://google.es')
    expect(normalizeAddress('https://www.google.es/maps')).toBe('https://www.google.es/maps')
    expect(normalizeAddress('localhost:5173')).toBe('http://localhost:5173')
    expect(normalizeAddress('127.0.0.1:8080/api')).toBe('http://127.0.0.1:8080/api')
    expect(normalizeAddress('mi-app.local')).toBe('http://mi-app.local')
    expect(normalizeAddress('como centrar un div')).toBe('https://www.google.com/search?q=como%20centrar%20un%20div')
    expect(normalizeAddress('  ')).toBe('about:blank')
  })

  it('nunca convierte otros esquemas en una navegación', () => {
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hola', 'vscode://abrir']) {
      expect(normalizeAddress(bad)).toMatch(/^https:\/\/www\.google\.com\/search\?q=/)
      expect(isWebUrl(bad)).toBe(false)
    }
    expect(isWebUrl('http://localhost:3000')).toBe(true)
    expect(isWebUrl('about:blank')).toBe(true)
  })

  it('reconoce direcciones locales', () => {
    expect(isLocalUrl('http://localhost:5173/')).toBe(true)
    expect(isLocalUrl('http://127.0.0.1:8000')).toBe(true)
    expect(isLocalUrl('https://google.es')).toBe(false)
    expect(isLocalUrl('https://localhost.evil.com')).toBe(false)
  })

  it('encuentra enlaces en el texto de los agentes sin la puntuación de la frase', () => {
    const t = 'Aquí tienes: https://www.google.es. El servidor está en localhost:5173/admin, y la doc (https://es.wikipedia.org/wiki/Foo_(bar)).'
    expect(findLinks(t).map((l) => l.url)).toEqual(['https://www.google.es', 'http://localhost:5173/admin', 'https://es.wikipedia.org/wiki/Foo_(bar)'])
    const [g] = findLinks(t)
    expect(t.slice(g.start, g.end)).toBe('https://www.google.es')
    expect(findLinks('sin enlaces aquí')).toEqual([])
  })

  it('da un nombre corto a la pestaña', () => {
    expect(shortUrl('https://www.google.es/')).toBe('google.es')
    expect(shortUrl('http://localhost:5173/admin')).toBe('localhost:5173/admin')
    expect(shortUrl('about:blank')).toBe('Nueva pestaña')
  })
})
