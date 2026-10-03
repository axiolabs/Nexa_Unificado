import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/**
 * Los fuentes del bundle de UNA ruta, para poder afirmar sobre lo que la pagina
 * realmente carga.
 *
 * Por que leer el disco y no raspar el HTML: la forma de enlazar los chunks
 * depende del bundler. Con Turbopack cada chunk de pagina aparecia como
 * `/_next/static/chunks/....js` en el HTML, asi que alcanza con buscar esa
 * regexp. Con Webpack NO: los chunks de pagina se piden por un mapa de ids que
 * vive en el runtime, y el HTML solo trae el runtime y un par de comunes. La
 * regexp matchea contra el runtime, descarga el runtime, y el test falla por una
 * cadena de texto que si esta en el bundle, treinta lineas mas abajo y en otro
 * archivo.
 *
 * El error es de test, no de producto, y por eso el fix es resolver la ruta en
 * el build y no relajar la asercion. Estas asserts existen para cazar que un
 * endpoint o un texto dejo de estar en la pantalla; aflojarlas las dejaria
 * verdes y sin valor.
 *
 * Donde queda el chunk: `.next/static/chunks/app/<grupos>/<ruta>/page-<hash>.js`.
 * Los grupos entre parentesis (`(host)`, `(user)`) NO aparecen en la URL, asi
 * que se buscan por el final del path en vez de armar el path exacto.
 *
 * Lee del build, no del server: por eso estos tests corren contra `next build`
 * y no contra `next dev`, y por eso hay que re-construir antes de correr la
 * suite.
 */

const CHUNKS_APP = join(process.cwd(), '.next', 'static', 'chunks', 'app')

/**
 * Path relativo con `/`, no con `\` de Windows.
 *
 * El nombre de la carpeta de la ruta viene de la URL (con `/`) y el path relativo
 * sale del filesystem (con `\`). Compararlos crudo funciona en Linux y falla en
 * Windows, y ese tipo de fallo es el peor: el test pasa en CI y rompe en la
 * maquina de quien lo escribe. Normalizar de un lado es lo que lo evita.
 */
function aSlashes(p: string): string {
  return p.split(sep).join('/')
}

function jsFiles(dir: string): string[] {
  let out: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const e of entries) {
    const full = join(dir, e)
    if (statSync(full).isDirectory()) out = out.concat(jsFiles(full))
    else if (e.endsWith('.js')) out.push(full)
  }
  return out
}

/**
 * Los fuentes del chunk de pagina de `ruta`.
 *
 * Sin argumentos de red a proposito: si la ruta no esta en el build, el test
 * falla con un mensaje que lo dice, en vez de contraerse a un `toContain('')`
 * que siempre pasa.
 */
export function fuentesDeRuta(ruta: string): string {
  const sufijo = `${ruta.replace(/\/+$/, '').replace(/^\//, '')}/page-`

  const encontrados = jsFiles(CHUNKS_APP).filter((f) =>
    aSlashes(relative(CHUNKS_APP, f)).includes(sufijo),
  )

  if (encontrados.length === 0) {
    throw new Error(
      `No hay chunk de pagina para "${ruta}" en ${CHUNKS_APP}. ` +
        `Corre \`npm run build\` antes de la suite.`,
    )
  }
  return encontrados.map((f) => readFileSync(f, 'utf8')).join('\n')
}

/** El texto de TODOS los chunks de pagina del build. Para asserts de alcance global. */
export function fuentesDeTodasLasRutas(): string {
  return jsFiles(CHUNKS_APP)
    .filter((f) => aSlashes(relative(CHUNKS_APP, f)).includes('/page-'))
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n')
}