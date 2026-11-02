// Resaltado ligero para los bloques de código del chat (sin Monaco): un solo recorrido con expresiones
// regulares por familia de lenguajes. Devuelve fragmentos de texto, nunca HTML.

export type Kind = 'c' | 's' | 'n' | 'k' | 't' | 'a' | 'add' | 'del' | 'meta'
export interface Tok {
  k?: Kind
  v: string
}

type Family = 'c' | 'hash' | 'sql' | 'markup' | 'css' | 'diff'

const FAMILY: Record<string, Family> = {}
const add = (f: Family, names: string) => names.split(' ').forEach((n) => (FAMILY[n] = f))
add('c', 'ts tsx typescript js jsx javascript mjs cjs json jsonc json5 java kotlin kt c h cpp cc hpp cs csharp go rust rs swift php dart scala groovy objc zig proto graphql gql')
add('hash', 'py python rb ruby sh bash zsh shell console terminal yaml yml toml ini conf env dockerfile docker makefile make r perl pl elixir ex exs ps1 powershell nix tf hcl')
add('sql', 'sql psql mysql sqlite postgres postgresql')
add('markup', 'html htm xml svg vue svelte astro xhtml plist')
add('css', 'css scss less sass postcss')
add('diff', 'diff patch')

const words = (s: string) => new Set(s.split(' '))
const KW_C = words(
  'abstract as async await break case catch class const continue debugger default defer delete do else enum export extends false final finally fn for from func function go guard if impl implements import in instanceof interface internal is let match mod module mut namespace new nil null override package private protected pub public readonly return self Self static struct super switch this throw throws trait true try type typeof undefined union unsafe use val var void where while with yield'
)
const KW_HASH = words(
  'and as assert async await break case class continue def del do done elif else end esac except export fi finally for from function global if import in is lambda local None not or pass raise return then True False try until while with yield echo exit set unset source alias require module begin rescue unless nil self true false null'
)
const KW_SQL = words(
  'select from where and or not insert into values update set delete create table index view drop alter add primary key foreign references join left right inner outer on group by order having limit offset as distinct union all null is like in between case when then else end returning with default unique if exists begin commit rollback'
)

const STR = String.raw`"(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?`
const NUM = String.raw`\b(?:0x[\da-fA-F]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)\b`
const RE: Record<Exclude<Family, 'diff'>, RegExp> = {
  c: new RegExp(String.raw`(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|(${STR}|\`(?:[^\`\\]|\\.)*\`?)|(${NUM})|([A-Za-z_$][\w$]*)`, 'g'),
  hash: new RegExp(String.raw`(#[^\n]*)|(${STR})|(${NUM})|([A-Za-z_][\w-]*)`, 'g'),
  sql: new RegExp(String.raw`(--[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|(${STR})|(${NUM})|([A-Za-z_]\w*)`, 'g'),
  markup: new RegExp(String.raw`(<!--[\s\S]*?(?:-->|$))|(${STR})|(<\/?[\w:-]+|\/?>)|([\w:@.-]+)(?==)`, 'g'),
  css: new RegExp(String.raw`(\/\*[\s\S]*?(?:\*\/|$))|(${STR})|(#[\da-fA-F]{3,8}\b|-?\b\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|s|ms|deg|fr)?\b)|(@[\w-]+|!important)|([\w-]+)(?=\s*:)`, 'g')
}

export function familyOf(lang: string): Family | undefined {
  return FAMILY[lang.toLowerCase()]
}

export function highlight(code: string, lang: string): Tok[] {
  const fam = familyOf(lang)
  if (!fam || code.length > 80_000) return [{ v: code }]
  if (fam === 'diff')
    return code.split(/(?<=\n)/).map((line) => ({
      v: line,
      k: line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : line.startsWith('@@') ? 'meta' : undefined
    }))
  const out: Tok[] = []
  const re = new RegExp(RE[fam])
  let last = 0
  const push = (v: string, k?: Kind) => {
    const prev = out.at(-1)
    if (!k && prev && !prev.k) prev.v += v
    else out.push(k ? { k, v } : { v })
  }
  for (let m = re.exec(code); m; m = re.exec(code)) {
    if (!m[0]) {
      re.lastIndex++
      continue
    }
    if (m.index > last) push(code.slice(last, m.index))
    last = m.index + m[0].length
    if (m[1]) push(m[0], 'c')
    else if (m[2]) push(m[0], 's')
    else if (fam === 'markup') push(m[0], m[3] ? 'k' : 'a')
    else if (fam === 'css') push(m[0], m[3] ? 'n' : m[4] ? 'k' : 'a')
    else if (m[3]) push(m[0], 'n')
    else {
      const w = m[0]
      const kw = fam === 'c' ? KW_C.has(w) : fam === 'hash' ? KW_HASH.has(w) : KW_SQL.has(w.toLowerCase())
      push(w, kw ? 'k' : fam === 'c' && /^[A-Z][a-z]\w*$/.test(w) ? 't' : undefined)
    }
  }
  if (last < code.length) push(code.slice(last))
  return out
}
