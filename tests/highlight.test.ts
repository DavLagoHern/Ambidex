import { describe, expect, it } from 'vitest'
import { highlight } from '../src/renderer/src/lib/highlight'

const kinds = (code: string, lang: string) => highlight(code, lang).filter((t) => t.k).map((t) => `${t.k}:${t.v}`)

describe('resaltado del chat', () => {
  it('conserva el texto exacto', () => {
    const code = 'const a = "hola" // saludo\nif (x > 1) return `t${x}`\n'
    expect(highlight(code, 'ts').map((t) => t.v).join('')).toBe(code)
  })

  it('marca palabras clave, cadenas, números, comentarios y tipos', () => {
    expect(kinds('const n: Number = 42 // fin', 'ts')).toEqual(['k:const', 't:Number', 'n:42', 'c:// fin'])
    expect(kinds('def f(x):\n  return "a"  # nota', 'python')).toEqual(['k:def', 'k:return', 's:"a"', 'c:# nota'])
    expect(kinds('SELECT id FROM users -- todos', 'sql')).toEqual(['k:SELECT', 'k:FROM', 'c:-- todos'])
  })

  it('html y css', () => {
    expect(kinds('<a href="/x">hola</a>', 'html')).toEqual(['k:<a', 'a:href', 's:"/x"', 'k:>', 'k:</a', 'k:>'])
    expect(kinds('.b { color: #fff; margin: 4px }', 'css')).toEqual(['a:color', 'n:#fff', 'a:margin', 'n:4px'])
  })

  it('diff por líneas', () => {
    expect(kinds('@@ -1 +1 @@\n-viejo\n+nuevo\n', 'diff')).toEqual(['meta:@@ -1 +1 @@\n', 'del:-viejo\n', 'add:+nuevo\n'])
  })

  it('un lenguaje desconocido o un bloque enorme no se procesa', () => {
    expect(highlight('<script>alert(1)</script>', 'brainfuck')).toEqual([{ v: '<script>alert(1)</script>' }])
    expect(highlight('x'.repeat(90_000), 'ts')).toHaveLength(1)
  })

  it('cadenas sin cerrar mientras llega el texto no rompen nada', () => {
    const code = 'const s = "sin cerrar'
    expect(highlight(code, 'js').map((t) => t.v).join('')).toBe(code)
  })
})
