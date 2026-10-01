import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const roots = ['tests', 'lib', 'app', 'prisma', 'scripts', 'docs', '.github']
const exts = ['.ts', '.tsx', '.mjs', '.md', '.yml', '.json']

/**
 * El proyecto escribe espanol ASCII a proposito, asi que cualquier cosa fuera de
 * ahi es una senal de defecto, no de estilo.
 *
 * Los rangos CJK estaban porque un texto de ejemplo en japones o chino se colaba
 * en un mensaje de error y se podia leer como cualquier cosa. El cirilico se
 * colo dos veces en el mismo trabajo y de la misma forma: en `Pediste`, una `e` y
 * una `d` copiadas de otro teclado. Compila, se ve bien, y en pantalla queda con
 * dos letras de otro alfabeto pegadas. Ningun aviso: ni el editor, ni TypeScript,
 * ni el scan de CJK. Griego y las IPA entran por lo mismo.
 *
 * Griego y demas NO se escriben en este archivo ni en el codigo, ni siquiera
 * para nombrarlos: se nombran por su code point. Un scanner que se dispara a si
 * mismo teach que se lo apague.
 *
 * Los rangos de derecha a izquierda y los de Asia del sur estan por la misma
 * razon que el cirilico, y con el agravante de que en pantalla se leen igual de
 * bien. Un texto arabe o hebreo pegado en un mensaje de error es el mismo
 * defecto que una `d` cirilica en `Pediste`, solo que en otra direccion.
 */
const badCodigo =
  /[\u0250-\u02AF\u0370-\u03FF\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\u0900-\u097F\u0E00-\u0E7F\u3000-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uFB50-\uFDFF\uFE70-\uFEFF\uFF00-\uFFEF]/u

/**
 * Griego en `docs/`, y solo ahi.
 *
 * `docs/modelo-datos.md` usa la alfa (U+03B1) en la formula del score: es
 * matematica real, escrita asi a proposito. Prohibirla en todas partes daria dos
 * falsos positivos en cada corrida, y un scanner al que hay que silenciar cada
 * dos commits es un scanner que nadie mira cuando aparece algo de verdad.
 *
 * En codigo el griego sigue prohibido, y ahi si es un riesgo: omicron (U+03BF) y
 * rho (U+03C1) son indistinguibles de `o` y `p`. La excepcion es por directorio,
 * no global, justamente para que el codigo no la pueda usar.
 */
const badDocs = /[\u0250-\u02AF\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\u0900-\u097F\u0E00-\u0E7F\u3000-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uFB50-\uFDFF\uFE70-\uFEFF\uFF00-\uFFEF]/u

/** `docs/` usa la version sin griego; el codigo, la que lo incluye. */
const regexPara = (f) => (f.startsWith('docs') ? badDocs : badCodigo)

/** Nombres legibles para el mensaje, en vez de repetir el rango en el codigo. */
const RANGOS = [
  ['cirilico', '\\u0400-\\u04FF'],
  ['griego', '\\u0370-\\u03FF'],
  ['IPA', '\\u0250-\\u02AF'],
  ['hebreo', '\\u0590-\\u05FF'],
  ['arabe', '\\u0600-\\u06FF'],
  ['arabe suppl', '\\u0750-\\u077F'],
  ['arabe ext-A', '\\u08A0-\\u08FF'],
  ['devanagari', '\\u0900-\\u097F'],
  ['thai', '\\u0E00-\\u0E7F'],
  ['CJK/hiragana/katakana', '\\u3000-\\u30FF'],
  ['CJK ext', '\\u3400-\\u4DBF'],
  ['han', '\\u4E00-\\u9FFF'],
  ['hangul', '\\uAC00-\\uD7AF'],
  ['arabe presentacion', '\\uFB50-\\uFDFF'],
  ['arabe presentacion B', '\\uFE70-\\uFEFF'],
  ['fullwidth', '\\uFF00-\\uFFEF'],
]

/** Decir "cirilico: U+0435" vale mas que un rango suelto. */
function queEs(texto, f) {
  const nombres = []
  for (const [nombre, rango] of RANGOS) {
    if (!regexPara(f).test(texto)) break
    const re = new RegExp(`[${rango}]`, 'u')
    if (re.test(texto)) nombres.push(nombre)
  }
  const unicas = [...new Set([...texto].filter((c) => regexPara(f).test(c)))]
  return `${nombres.join(' + ')}: ${unicas.map((c) => 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join(' ')}`
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(p, out)
    else if (exts.some((x) => p.endsWith(x))) out.push(p)
  }
  return out
}

let found = 0
for (const root of roots) {
  let files
  try {
    files = walk(root)
  } catch {
    continue
  }
  for (const f of files) {
    // node_modules dentro de la raiz no se escanea
    if (f.includes('node_modules')) continue
    readFileSync(f, 'utf8')
      .split(/\r?\n/)
      .forEach((line, i) => {
        if (regexPara(f).test(line)) {
          console.log(`  ${f}:${i + 1}  [${queEs(line, f)}]  ${line.trim()}`)
          found++
        }
      })
  }
}
console.log(
  found === 0
    ? '  limpio: sin cirilico, CJK, IPA, fullwidth, hebreo, arabe, devanagari ni thai'
    : `  ${found} linea(s) suspectas`,
)
