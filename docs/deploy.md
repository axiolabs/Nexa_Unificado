# Nexa - Deploy (vertical slice)

Estado: **deploy de prueba activo (privado).**

## Plataformas

- **App:** Vercel, proyecto `stivliives-projects/nexa-unificado`.
  - Production URL: https://nexa-unificado.vercel.app
  - Repo conectado: https://github.com/axiolabs/Nexa_Unificado (auto-deploy en push a `main`).
  - Deployment Protection (Vercel Authentication) **activo**: la URL pide login de Vercel.
    Para un link publico, apagarlo en Project > Settings > Deployment Protection.
- **DB:** Neon (Postgres gestionado), project `dry-cake-04689529` (org `AxioLabs`),
  region `aws-us-east-2`, branch `production` (`br-odd-poetry-b5dyzt8w`).
  - La app usa la connection string **pooled** (hostname `-pooler`, `pgbouncer=true`).
  - Las migraciones usan la **directa** (sin `-pooler`).
  - `neon link` guarda el contexto en `.neon` (git-ignored).

## Variables de entorno (Vercel, Production)

| Var | Origen |
| --- | --- |
| `DATABASE_URL` | Neon pooled: `neon connection-string production --pooled --prisma` |
| `SESSION_SECRET` | generado para prod (`node -e "crypto.randomBytes(48).toString('base64url')"`) |
| `SESSION_VERSION` | `1` |
| `APP_ORIGIN` | `https://nexa-unificado.vercel.app` (fail-closed: sin esto, toda mutacion da 403/500) |

Nota: las variables estan solo en **Production**. Los **Preview** deployments
(cada push a otra rama) no las tienen y quedaran sin DB.

## Migraciones

```
neon link --project-id dry-cake-04689529 --branch production --no-env-pull
$env:DATABASE_URL = "<Neon directa>"   # NO tocar .env local (apunta a docker 5433)
npx prisma migrate deploy
```

## Pendiente antes del lanzamiento real

- [ ] **Produccion no debe quedar con datos demo.** Hoy la branch `production`
      de Neon tiene el seed (`npm run db:seed`: 8 lugares + test de personalidad
      v1). Antes de lanzar: limpiar esos datos o, preferible, mover las pruebas a
      una branch de Neon separada (ej. `preview`) y dejar `production` limpia.
- [ ] Revisar Deployment Protection (hoy privado).
- [ ] Definir si los Preview deployments necesitan env vars.
