# Nexa - Deploy (vertical slice)

Estado: **deploy de prueba activo (privado), con Preview funcionando.**

## Plataformas

- **App:** Vercel, proyecto `stivliives-projects/nexa-unificado`.
  - Production URL: https://nexa-unificado.vercel.app
  - Repo conectado: https://github.com/axiolabs/Nexa_Unificado (auto-deploy en push a `main`).
  - Deployment Protection (Vercel Authentication) **activo**: la URL pide login de Vercel.
    Para un link publico, apagarlo en Project > Settings > Deployment Protection.
- **DB:** Neon (Postgres gestionado), project `dry-cake-04689529` (org `AxioLabs`),
  region `aws-us-east-2`.
  - La app usa la connection string **pooled** (hostname `-pooler`, `pgbouncer=true`).
  - Las migraciones usan la **directa** (sin `-pooler`).
  - `neon link` guarda el contexto en `.neon` (git-ignored).

## Mapa de ramas de la base

| Entorno | Base | Como se prepara |
| --- | --- | --- |
| local (dev) | docker `nexa` en `127.0.0.1:5433` (`.env`) | `npm run db:migrate` |
| tests local | docker `nexa_test` en `127.0.0.1:5433` (`.env.test`) | `npm run test:db:setup` |
| tests en CI | `postgres:17-alpine` del service, `127.0.0.1:5432/nexa_test` | `node scripts/create-test-db.mjs` |
| **preview** (Vercel) | Neon branch `preview` (`br-billowing-credit-b55d4lfw`) | clon COW de `production` |
| **production** (Vercel) | Neon branch `production` (`br-odd-poetry-b5dyzt8w`, default) | `npx prisma migrate deploy` |

Reglas del mapa, que son la parte que hay que recordar:

- **Una rama de Neon por entorno desplegado.** `preview` y `production` son
  clones copy-on-write: probar contra `preview` no escribe en `production`. Es
  lo que hace falta para poder desplegar previews sin que un PRInvite a datos.
- **`preview` se crea desde `production`**, asi que hereda migraciones y seed.
  Cuando haya migraciones nuevas hay que correr `prisma migrate deploy` contra
  `preview` tambien, o el preview queda con el schema viejo.
- **Los tests nunca tocan ni `nexa` ni `nexa_test` de Neon**: corren contra
  docker, y `create-test-db.mjs` se niega a tocar una base que no termine en
  `_test`.
- **`.env` nunca sale de la maquina.** Ver la seccion de `.vercelignore`.

## Variables de entorno

**Production:**

| Var | Valor |
| --- | --- |
| `DATABASE_URL` | Neon `production` pooled |
| `SESSION_SECRET` | generado para prod (`node -e "crypto.randomBytes(48).toString('base64url')"`) |
| `SESSION_VERSION` | `1` |
| `APP_ORIGIN` | `https://nexa-unificado.vercel.app` |

**Preview:** `DATABASE_URL` (Neon `preview` pooled), `SESSION_SECRET` (uno
distinto al de prod, para que una sesion de preview no valida en prod) y
`SESSION_VERSION`. **Sin `APP_ORIGIN`, a proposito.**

Por que sin `APP_ORIGIN`: cada preview tiene su propio dominio
(`<proyecto>-<hash>-<team>.vercel.app`), asi que un unico valor fijo solo seria
el dominio del preview mas viejo y todo preview nuevo daria 403 en cada
mutacion. `assertSameOrigin` (`lib/http.ts`) usa `https://$VERCEL_URL` como
respaldo cuando `APP_ORIGIN` no esta, y **ese respaldo nunca aplica si
`VERCEL_ENV=production`**: sin ese filtro, un `APP_ORIGIN` olvidado se
reemplazaria en silencio por el dominio del deployment y se perderia el
fail-closed. Cubierto por `tests/auth/same-origin.test.ts`.

Consecuencia aceptada: un preview abierto por su alias de rama
(`VERCEL_BRANCH_URL`) tiene otro `Origin` y daria 403. El enlace que muestran
Vercel y GitHub en cada PR es el del deployment, que es el camino normal.

## El `.vercelignore` no es opcional

`vercel deploy` sube el directorio de trabajo tal cual. Sin `.vercelignore`, el
`.env` local -- con la password de la base de desarrollo y el `SESSION_SECRET`
local -- viaja dentro del deployment y Next lo carga en runtime. Como las
variables de Vercel ya estan definidas, nada se pisa, el sitio funciona
normal y el secreto filtrado no se nota.

Los deploys que salen de GitHub no tienen el problema (clonan el repo, y ahi
`.env` esta git-ignored), pero los de la CLI si.

Se encontro verificando que `APP_ORIGIN` valia `http://localhost:3000` en un
preview al que nunca se le habia cargado esa variable.

## Migraciones

```
neon link --project-id dry-cake-04689529 --branch production --no-env-pull
$env:DATABASE_URL = "<Neon directa>"   # NO tocar .env local (apunta a docker 5433)
npx prisma migrate deploy
```

## Pendiente antes del lanzamiento real

- [ ] **Produccion no debe quedar con datos demo.** Hoy la branch `production`
      de Neon tiene el seed (`npm run db:seed`: 8 lugares + test de personalidad
      v1). Antes de lanzar: limpiar esos datos.
- [ ] **Promover los previews reales a una branch propia** si se quiere que un
      PRInvite a datos sin tocar `production`. Hoy `preview` esta preparado y
      verificado; falta decidir si se usa para pruebas de integracion o solo
      para revisar UI.
- [ ] Revisar Deployment Protection (hoy privado).
- [ ] `SESSION_SECRET` de produccion generado una vez y guardado en un
      administrador de secretos; hoy vive solo como secret de Vercel, y rotarlo
      invalida todas las sesiones.