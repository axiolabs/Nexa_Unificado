# Decisiones de autenticacion, sesion y roles (Slice A)

Todo lo de abajo se ejecuto y se midio contra Postgres 17.11 real, no quedo como
intencion. Donde hubo un error mio, esta escrito el error y como se detecto.

## 1. Onde vive cada cosa

| Concern | Archivo | Nota |
|---|---|---|
| Prisma Client (con adapter) | `lib/db.ts` | factory + cache en `globalThis` |
| Crypto de sesion, sin Next | `lib/auth/token.ts` | lo importa el middleware |
| Cookie, `getSession`, `requireUser` | `lib/auth/session.ts` | solo route handlers |
| Hashing de contrasena | `lib/auth/password.ts` | argon2id |
| Verificacion de rol en API | `lib/auth/guard.ts` | `requireRole` |
| Tabla de roles y rutas | `lib/authz.ts` | **fuente unica de verdad** |
| Gate de rol de paginas | `middleware.ts` | corre antes de resolver la ruta |

La division de `token.ts` y `session.ts` no es estetica: `middleware.ts` corre
en un runtime propio y no debe arrastrar `next/headers`.

## 2. argon2id, no bcrypt

| | argon2id | bcrypt |
|---|---|---|
| Inputs > 72 bytes | losHashea entero | **se trunca en silencio** |
| Resistencia | memory-hard | solo CPU |

El truncado de bcrypt es el problema serio: no da error, ignora el resto del
input, asi que dos contrasenas que difieren despues del byte 72 dan el mismo
hash. Con argon2 se eligio `m=65536, t=3, p=4` (OWASP pide >= 19 MiB), fijados
en codigo para que subirlos sea un cambio reviewable y no una actualizacion
silenciosa de la libreria.

Los parametros van embebidos en el string del hash, asi que `verify` los lee
de ahi y no de las constantes. Endurecer el costo no invalida las contrasenas
existentes: solo hay que re-hashear en el login siguiente de cada usuario.

## 3. Sesion: cookie firmada, sin tabla

Formato `<base64url(payload)>.<base64url(HMAC-SHA256)>`, payload
`{uid, ver, iat, exp}`. Es un JWT escrito a mano en ~40 lineas, a proposito:
no hay campo `alg` que un atacante pueda mutar a `none` ni confusion de
algoritmos, que es el historial real de vulnerabilidades de JWT.

Cookie: `HttpOnly`, `SameSite=Lax`, `Secure` en produccion, 30 dias.
`Lax` y no `Strict` porque `Strict` rompe la navegacion desde un link de email,
que es exactamente el flujo de "te invitaron a un plan".

### La limitacion, dicha fuerte

**No se puede revocar una sesion individual.** Hay dos palancas globales
(subir `SESSION_VERSION`, o rotar `SESSION_SECRET`) y ninguna es "cerrar
sesion en este dispositivo".

Se mitiga en parte con `requireUser`, que relee el usuario de la base en cada
peticion para que `isActive`, `suspendedAt` y `deletedAt` sirvan de algo. Con
cookie puramente stateless, un usuario suspendido seguiria operando 30 dias.
Verificado: suspender la cuenta corto `/admin` a 403 en el acto, sin tocar la
cookie.

**Cuando va la tabla `Session`:** el dia que aparezca "cerrar otras sesiones",
o cuando revocar una sola sesion robada sea un requisito y no unaniceidad.

## 4. Roles: route groups, y el gate NO es el boton

`UserRoleAssignment` es una tabla con roles por usuario, no tablas por rol. El
frontend refleja lo mismo: un Next con route groups, no servicios separados.

```
app/(user)/        -> /           home, registro
app/(host)/host/   -> /host       placeholder
app/(admin)/admin/ -> /admin      placeholder
app/(curation)/curacion/ -> /curacion  placeholder
```

Los grupos `(host)`, `(admin)` y `(curation)` **no estan en el alcance de A**:
son la carpeta, el layout y el placeholder. Agregar el panel real es escribir
la pagina, sin reestructurar.

`lib/authz.ts` es la fuente unica: `middleware.ts` y `requireRole` leen la misma
tabla, asi que no pueden divergir en que rol habilita que.

### Que se verifico, y como

Todos los casos de abajo se ejecutaron contra la app corriendo. Lo relevante
es el **recorte de rol y la suspension con el mismo cookie**, sin re-loguear:

| Escenario | Resultado |
|---|---|
| `USER` contra `/admin`, `/host`, `/curacion` | **403** en los tres |
| `USER` contra `/` | 200 |
| Otorgar `ADMIN` en la base, mismo cookie | **200** en los tres |
| Revocar `ADMIN`, mismo cookie | **403** al instante |
| Cuenta suspendida con `ADMIN` vigente | **403** (y el login tambien 403) |
| Reactivar la cuenta | 200 |
| Sin cookie | 401 |
| Cookie con firma falsificada | 401 |
| `Origin` distinto al configurado | 403 |

Que el mismo cookie cambie de 403 a 200 segun lo que haya en la base es la
prueba de que el gate consulta `UserRoleAssignment` en cada request y no
confia en nada que venga del cliente.

Ocultar un boton nunca fue el control. El cliente puede no mostrar lo que no
corresponde por UX; el rechazo es siempre del servidor.

### API: el middleware no la cubre, a proposito

El matcher de `middleware.ts` excluye `/api`. Que la autorizacion de una API
dependa de que el matcher siga cubriendo la ruta es fragile: un path mal
escrito se cuela y no hay test que lo detecte. En vez de eso cada handler
declara que rol necesita con `requireRole`, que es explicito y local a la ruta
que protege.

## 5. El bug que casi se va

La mitigacion de timing del login **no funcionaba, y el codigo parecia correcto.**

La primera version comparaba contra un hash argon2 **escrito a mano** en el
codigo. El `catch { return false }` de `verifyPassword` se tragaba el error, asi
que el flujo parecia correcto y en realidad argon2 estaba haciendo esto:

```
verify sobre el DUMMY_HASH lanza: pchstr must contain a $ as first char
tarda 0.29 ms          <-- no hashea nada
verify sobre un hash VALIDO tarda 83.5 ms
```

La medicion en el endpoint, no la lectura del codigo, es lo que lo delato:

```
antes:  email inexistente  10.0 ms   |  password incorrecta  95.4 ms   (9.5x, fuga abierta)
despues: email inexistente 102.2 ms  |  password incorrecta  97.0 ms   (dentro del ruido)
```

El arreglo fue generar el hash con `hashPassword` en vez de hardcodearlo, y
memoizar la promesa porque argon2 es caro por definicion. Un string de hash
escrito a mano es fragil en un lugar que parece que no importa.

## 6. Otros bordes verificados

| Caso | Resultado |
|---|---|
| Contrasena de 11 / 12 / 128 / 129 | 400 / 201 / 201 / 400 |
| `SeCtA-...` vs `secta-...` | distintas: la contrasena **no** se transforma |
| Email `Ana.Ruiz@Example.COM` | guardado como `ana.ruiz@example.com` |
| Mismo email en otra caja | **409**, no dos usuarios |
| Email inexistente vs password mala | mismo mensaje y mismo tiempo |
| Email en claro en la base | `passwordHash` es `$argon2id$v=19$m=65536,p=4,t=3` |

El email se normaliza a minusculas al escribir, porque el `@unique` de Postgres
distingue mayusculas y sin normalizar `Ana@x.com` y `ana@x.com` serian dos
usuarios. La contrasena **no** se toca: ni trim ni minusculas, porque cualquier
transformacion destruye entropia.

## 7. Gotchas de infraestructura que costaron tiempo

**`localhost` contra puerto de Docker publicado.** Node en Windows resuelve
`localhost` a `::1` **primero**, y el puerto de compose esta bound a IPv4, asi
que `prisma migrate` fallaba con `P1001` aunque el contenedor estuviera
healthy y `psql` anduviera bien por dentro. La base esta bound a
`127.0.0.1:5433` a proposito (no a la red) y `DATABASE_URL` dice `127.0.0.1`,
**no** `localhost`. Si alguien "arregla" la URL poniendole `localhost`, rompe.

**El mismo par host/IP, pero al reves, para el navegador.** Las dos reglas son
de la misma familia y la solucion es **opuesta**, asi que van juntas para que
nadie generalice "siempre `127.0.0.1`":

- Node -> Postgres: `DATABASE_URL` usa `127.0.0.1` (IPv4), nunca `localhost`.
- Navegador -> server: la pasada manual abre `http://localhost:3000`, nunca
  `http://127.0.0.1:3000`. `APP_ORIGIN` esta fijado exactamente a
  `http://localhost:3000`, y `assertSameOrigin` devuelve **403** a cualquier
  `Origin` distinto. El sintoma despista: el `POST` muere por CORS-ish antes de
  llegar al handler, y parece un bug de la accion y no del host tipeado.

**Prisma 7 exige driver adapter.** `new PrismaClient()` sin adapter ya no es
valido. Ademas eso obliga a `runtime = 'nodejs'` en el middleware, porque el
runtime Edge no tiene `node:crypto` completo ni puede abrir conexiones TCP. Por
eso el control de rol no puede ser una simple verificacion de firma.

**Prisma 7 no auto-carga `.env`.** Se resolvio con `process.loadEnvFile()` en
`prisma.config.ts`, en vez de sumar `dotenv-cli`. Sirve tambien para `npx prisma`
directo, no solo para los scripts de npm.

**`@prisma/client` no es solo `prisma`.** El adapter agrega `pg` como dependencia
de runtime.

## 8. Deuda conocida, anotada a proposito

- **Sin tabla de sesion** (ver 3). Es la deuda mas grande.
- **Sin blocklist de contrasenas.** Hoy es "minimo 12 caracteres". Falta un
  chequeo contra contrasenas comunes antes de produccion.
- **El 409 de registro revela que el email existe.** Decision consciente: el
  mensaje "ya tenes cuenta, entra" evita crear una cuenta inutil. Si molesta
  mas de lo que ayuda, el compromiso es devolver 201 siempre y avisar por email.
- **`npm audit` reporta 4 vulnerabilidades altas** (`mysql2`, `deepmerge-ts`).
  Son **transitivas del CLI de Prisma**, no del runtime de la app, y `mysql2` es
  driver de MySQL mientras la app usa Postgres. El "fix" que ofrece npm es
  **bajar a `prisma@6.19.3`**, que deshace el trabajo de Prisma 7. No se corrio.
  Reevaluar si Prisma publica version con `deepmerge-ts` al dia.
- **Sin blocklist de contrasenas** (ver arriba).
- **`middleware.ts` esta deprecado en Next 16** y renombrado a `proxy.ts`
  (tambien el export `middleware` pasa a `proxy`). Sigue funcionando, asi que no
  es bloqueante. Cuando se agrupe con otras migraciones menores:
  `npx @next/codemod middleware-to-proxy`. Es mecanico y sin riesgo de logica
  porque `proxy` corre en `nodejs` fijo y no configurable, que es exactamente
  el runtime que el archivo ya declara. Revisar el matcher y el `deny()` al
  migrar, que son lo unico que no es un renombre.
- **Sin tests automatizados.** Todo lo de este documento se ejecuto con scripts
  de PowerShell contra la app real, y quedan en el historial de la sesion, no
  en el repo. El paso siguiente de A es convertir esto en una suite.

> **Actualizado despues:** la suite existe (ver §9), y la disponibilidad de
> lugares tiene ademas su propio capitulo (§12) y el de la pantalla de creacion
> (§13). Este bloque queda como el estado del punto en que se escribio; lo de
> arriba que ya se resolvio sigue en pie, lo de tests ya no.

## 9. Suite automatizada

Los 9 escenarios de la seccion 4 estan en `tests/auth/authorization.test.ts`.
No son copia del guion: la asercion central es que **el mismo cliente, con el
mismo cookie, cambia de veredicto segun lo que hay en `UserRoleAssignment`**. Eso
distingue un gate que consulta la base de uno que confia en el cliente.

Los tests corren contra `next start` real, por HTTP, en el puerto 3100, contra
una base propia (`nexa_test`) que cualquier helper se niega a truncar si el
nombre no termina en `_test`.

### 9.1 Que se verifico, y como

Una suite verde no prueba nada por si sola: probaba que los asserts existen.
Se hizo **mutation testing** sobre el codigo de produccion: se rompio cada
proteccion a proposito, se recompilo, y se confirmo que la suite se pone roja.

| Mutacion | Detectada |
|---|---|
| La condicion de rol siempre deniega | si, 7 tests |
| La regla de ruta nunca resuelve (sin chequeo de rol) | si, 4 tests |
| El matcher deja de cubrir `/admin`, `/host`, `/curacion` | si, 9 tests |
| El rol se acepta desde un header del cliente | si, 4 tests |
| La cookie no verifica firma | si, 6 tests |
| Se ignora `suspendedAt` | si, 2 tests |
| Se ignora `isActive` | **no, al principio** |
| Se ignora `deletedAt` | **no, al principio** |
| Se ignora la expiracion del token | si |
| Se ignora `SESSION_VERSION` | si |
| Vuelve el `DUMMY_HASH` hardcodeado malformado (el bug original) | si, 2 tests |

Las dos filas marcadas estaban **verdaderas al empezar**: el middleware
comprueba `isActive` y `deletedAt`, y ningun test las tocaba. Borrar cualquiera
de las dos comprobaciones dejaba la suite en verde. Se agregaron los tres tests
correspondientes y se reverificaron.

**Lo que un test funcional no puede detectar:** que la comparacion de la firma
use `timingSafeEqual` y no `===`. Ningun test de caja negra puede distinguirlo,
porque el comportamiento observable es identico. Queda como revision de codigo,
no como asercion.

### 9.2 El bug que casi deja la suite inutil

La primera version de la suite daba **verde con el middleware completamente
roto**. La causa: los tests corren contra `next start`, que sirve el bundle de
`.next`, y mutar `middleware.ts` no cambia el bundle. La suite verificaba el
codigo de ayer.

Por eso `npm test` tiene `pretest: npm run build`. Un build extra de ~30s es
barato frente a un verde falso en el gate de seguridad: es el mismo modo de
fallar que la suite que existia antes en PowerShell, que no fallaba nunca.

### 9.3 Detalles que costaron tiempo, para no volver a tropezar

- **El orden de los parametros argon2 es `m,p,t`**, no `m,t,p`. Un regex con el
  orden fijo falla por formato y manda a buscar un bug que no existe. Los tests
  parsean los parametros en vez de fijarlos.
- **`cuid()` y `@updatedAt` son defaults de Prisma, no de Postgres.** Las
  columnas quedan `NOT NULL` sin `DEFAULT`, asi que un `INSERT` crudo sin `id` ni
  timestamps falla con `null value ... violates not-null constraint`. Importa
  para cualquier SQL crudo del proyecto, no solo para los tests.
- **No namesakear `URL`.** Una constante `const URL = process.env.DATABASE_URL`
  tapa la clase global y produce `TypeError: URL is not a constructor`, a
  kilometers de la causa.
- **No confiar en `test.env` de Vitest para propagar variables a los workers.**
  Cuando esa propagacion falla, el error aparece en el archivo de test como
  "DATABASE_URL no esta definido". `tests/helpers/env.ts` carga `.env.test` en
  el propio proceso del test.

## 10. Mapa publico y aprobacion de planes

### 10.1 Que es publico y que no

El mapa y los lugares son publicos a proposito: son la superficie de
adquisicion. El detalle de un plan no lo es. Un plan lleva hora, lugar,
organizador y participantes, y publicarlo sin sesion arma una agenda de la vida
social de gente que no publico nada.

El corte esta en el servidor, no en el cliente. Ocultar el link no alcanza.

| Endpoint | Sin sesion | Con sesion |
|---|---|---|
| `GET /api/places` | lugares `APPROVED` | curador tambien ve `PENDING` |
| `GET /api/plans/[id]` | **401** | detalle completo |
| `GET /api/plans/[id]/requests` | **401** | **403**: solo el organizador |
| `POST /api/plans/[id]/join` | **401** | crea peticion `REQUESTED` |
| `POST /api/plans/[id]/requests` | **401** | **403**: solo el organizador |
| `POST /api/plans` | **401** | **403** sin rol `HOST`/`ADMIN` |

`GET /api/places` responde `cache-control: private, no-store`. No es
paranoico: el curador ve mas que el anonimo, y una cache compartida serviria los
`PENDING` de uno al otro.

### 10.2 La reliability no va en el detalle

El historial de presentismo (`ATTENDED` vs `NO_SHOW`) se calcula en
`lib/reliability.ts` y se expone **solo** en `/requests`, que exige ser el
creador del plan. Meterlo en el detalle lo publicaria a cualquier usuario con
sesion, que es justo lo que el corte de 10.1 evita.

`Rating` no se usa para reliability a proposito: es una calificacion **del plan**
(`@@unique([planId, authorId])`), no de una persona. No tiene ningun campo que
apunte al planificado, asi que promediarlo por usuario no mediria nada
relevante. Cuando exista calificacion entre personas, el lugar natural es
`lib/reliability.ts`.

`showUpRate` es `null` cuando no hay historial, nunca `0`: "sin datos" y "no se
presento nunca" son cosas distintas y el organizador tiene que poder
distinguirlas.

### 10.3 Unirse es pedir, no entrar

`POST /api/plans/[id]/join` crea `PlanParticipant` con `status: 'REQUESTED'` y
`expiresAt = now() + 24h`. **No sube `acceptedCount`.** La entrada la decide el
organizador desde `POST /api/plans/[id]/requests`.

Esto no es una eleccion nueva: el schema ya lo decia. `status` tiene
`@default(REQUESTED)`, existe `expiresAt`, `respondedAt`, `reminderSentAt`, y un
`@@index([status, expiresAt])` que solo tiene sentido para un barrido de
vencidas.

Pedir en un plan lleno se permite, pero la respuesta trae
`planIsFull: true` y `remainingSpots: 0`. Cancelar en el peor momento libera el
lugar para otro; lo que no se puede es fingir que hay cupo.

El barrido de vencidas vive en `resolveExpired()` dentro de
`app/api/plans/[planId]/requests/route.ts` y corre de forma **perezosa**: se
ejecuta cuando alguien mira la pantalla del organizador, antes de listar. El
indice `[status, expiresAt]` queda disponible para el cron cuando exista.

**Una solicitud a la vez.** El spec (`modelo-datos.md` §8, riesgo #1) avisa que
resolver en lote acepta a ciegas: un plan de 4 con 15 solicitudes vencidas
termina con 15 aceptados. Por eso el bucle abre una transaccion por solicitud,
con la comparacion de cupo en el mismo `WHERE` del incremento. No hace falta
`SELECT ... FOR UPDATE` como propone el spec: el `updateMany` condicional da la
misma garantia sin bloquear la fila.

El invariante que hay que auditar (spec §8) es
`acceptedCount = COUNT(status IN (ACCEPTED, ATTENDED))`, y hay un test que lo
verifica despues de un barrido de 7 solicitudes vencidas sobre un plan de cupo 3.

### 10.3-bis Cuatro desviaciones del spec que estaban en el codigo

`docs/modelo-datos.md` §5.8 ya especificaba todo esto. Estaba escrito y no se
habia aplicado:

| Spec | Lo que estaba implementado |
|---|---|
| `ACCEPTED` si hay cupo, `DECLINED` si lleno | `CANCELLED` siempre |
| `respondedAt = now()` | no se escribia |
| `expiresAt` **se conserva** como evidencia | se ponia en `null` |
| **una solicitud a la vez** con la fila del Plan bloqueada | `updateMany` en **lote** |
| `expiresAt = min(now()+24h, plan.startsAt)` | `now()+24h` a secas |

La cuarta era la grave: el lote convertia el riesgo #1 del spec en un bug real.
La quinta dejaba solicitudes `REQUESTED` para siempre en planes que empiezan
antes de las 24h, porque un plan ya empezado no se puede volver a abrir para
aprobar a nadie.

`M10` y `M11` atacan esa regla desde los dos lados: si el barrido acepta
siempre, o si rechaza siempre, la suite muere. `M12` mata el lote.

### 10.3-ter La trampa de la zona horaria en los fixtures

A mitad de camino aparecio un fallo de 19h en vez de 24h en el calculo de
`expiresAt`. El sintoma apuntaba a la app y el bug estaba en el test.

Las columnas de fecha son `timestamp WITHOUT TIME ZONE`, y hay dos clientes
hablando con la misma base: Prisma y el `pg` crudo de los fixtures. Prisma
escribe y lee el reloj de pared en UTC. `pg` serializa un `Date` a cadena en la
**zona local del proceso**, asi que en America/Bogota (UTC-5) un fixture queda
5 horas corrido respecto de lo que Prisma espera al leer.

Dos correcciones, y las dos hacen falta:

- `SET TIME ZONE 'UTC'` en la sesion, para que el `now()` de los SQL crudos
  coincida con el `new Date()` de la app.
- Normalizar cada `Date` a ISO UTC **antes** de mandarlo, porque
  node-postgres serializa en local del lado del cliente y la zona de la sesion no
  llega a intervenir.

Prisma solo (crear y leer con Prisma) no tiene deriva. La asercion minima es
que un `timestamp without time zone` no puede depender de la zona de la maquina:
`tests/map/timezone-drift.test.ts` la fija.

### 10.4 Donde esta el overbooking

En la **aprobacion**, no en el join. El `updateMany` lleva la comparacion y el
incremento en la misma sentencia:

```
updateMany({ where: { id, acceptedCount: { lt: capacity } }, data: { increment } })
```

Postgres evalua el `WHERE` y el `UPDATE` en un solo paso, asi que dos
aprobaciones simultaneas no pueden leer ambas "queda 1" y escribir 2.

Cuando el cupo se lleno entre que se listo la pantalla y se aprobo, la
peticion queda `REQUESTED` y se devuelve 409. Perderla automaticamente seria
peor que dejar la decision en manos de quien tiene el contexto.

### 10.5 Mutation testing: `scripts/mutate-approval.mjs`

| Mutacion | Resultado |
|---|---|
| M1 el join acepta directo | kill |
| M2 el join no pone `expiresAt` | kill |
| M3 aprobar no incrementa `acceptedCount` | kill |
| M4 aprobar ignora la expiracion | **equivalente esperado** |
| M5 aprobar ignora el cupo | kill |
| M6 `/requests` abre a cualquiera | kill |
| M7 responder abre a cualquiera | kill |
| M8 la reliability se filtra al detalle | kill |
| M9 el barrido no corrige a `DECLINED` | kill |
| M10 el barrido acepta siempre, ignora el cupo lleno | kill |
| M11 el barrido rechaza siempre, ignora el cupo libre | kill |
| M12 el barrido resuelve en lote | kill |
| M13 el barrido no escribe `respondedAt` | kill |
| M14 el plazo ignora el inicio del plan | kill |

**13 matadas, 0 sobrevivientes, 1 equivalente esperado.**

M9 a M14 atacan la **regla de cupo** del barrido desde los dos lados, no el
hecho de que el status se mueva. M10 acepta siempre y M11 rechaza siempre: si
alguno de los dos sobreviviera, la suite estaria probando que "algo cambia" en
vez de que "cambia al valor correcto segun haya o no cupo".

M4 sobrevive por diseno y conviene que siga asi. El POST ya valida la
expiracion antes de abrir la transaccion, asi que quitar el
`expiresAt: { gt: now }` del `updateMany` no cambia nada observable. El guard se
mantiene porque no es redundante de verdad: cubre la carrera entre esa lectura y
la transaccion. Marcarlo equivalente esperado documenta que la suite no puede
distinguir las dos capas, no que falte cobertura.

El script **recompila por mutacion**. Los tests pegan a `next start`, o sea al
bundle: mutar el fuente sin rebuild hace que los tests corran contra el codigo
viejo y den verde por el motivo equivocado. Es el mismo motivo por el que
`pretest` compila antes de testear.

### 10.6 Dos correcciones sobre lo que se suponia

- **La validacion de rango del `bbox` no era un bug de correccion.** Parecia que
  `minLat < -90` dejaba pasar una caja entera sobre el polo, pero `maxLat > 90`
  la atiene igual, y una longitud imposible en el extremo del antimeridiano cae
  en el tope de amplitud. Lo que si era cierto: el mensaje de error era
  enganoso, decia "abarca demasiado" cuando el problema era una longitud
  inexistente. La validacion quedo simetrica en los cuatro valores.
- **`Rating` no sirve para reliability por persona.** Ver 10.2.

## 11. Deuda anotada a proposito

| # | Deuda | Por que esta anotada | Dispara migracion cuando |
|---|---|---|---|
| 1 | `middleware.ts` -> `proxy.ts` | Next 16 lo deprecia. Migracion mecanica con `npx @next/codemod middleware-to-proxy`, no es un riesgo de diseno. | Next saque el soporte, o toquemos el matcher |
| 2 | **Notificacion al organizador** (push al pedir + recordatorio a mitad de plazo) | Ver 11.1. Depende de una decision de canal que no esta tomada. | Hay decision de canal |
| 3 | `acceptedCount` desnormalizado | El spec §8 lo justifica: hace el check de cupo en O(1) dentro de la transaccion. Cuesta una invariante que hay que auditar, no un Atajo. | El plan se vuelva grande y el `COUNT` deje de doler |
| 4 | 4 vulnerabilidades altas del CLI de Prisma | Transitivas, sin parche upstream. `npm audit fix --force` romperia Prisma. | Prisma las arregle |
| 5 | Barrido perezoso en vez de cron | `resolveExpired()` corre cuando alguien mira la pantalla. Correcto, pero un plan sin visitas acumula solicitudes `REQUESTED` hasta que alguien mire. | Un plan no se mira en 24h y las solicitudes se acumulan |
| 6 | **No hay interfaz de Curaduria** | Ver 12.4. La decision de producto (12) es "intervencion humana, no cancelacion automatica", pero no hay endpoint ni pantalla: hoy un lugar se aprueba o se rechaza por SQL. | Se necesite ajustar `verificationStatus` o `isActive` desde la app |
| 7 | `Place` no tiene motivo de rechazo | Sin el, no se distingue "lo bajamos porque es inseguro" de "era un duplicado", y por lo tanto no se puede automatizar la cancelacion de planes aunque hubiera notificacion. Ver 12.4. | Se defina la cancelacion automatica por lugar inseguro |

### 11.1 Notificaciones: PENDIENTE, no descartada

**No esta implementada.** Y el timeout de 24h **no** la vuelve innecesaria: la
hace mas necesaria, porque el timeout ahora RESUELVE por defecto. Sin avisarle al
organizador, las solicitudes se auto-aceptan a las 24h sin que el organizador
nunca se entere de que existieron. El recordatorio a mitad de plazo es
precisamente lo que le da la chance de responder antes de que la auto-resolucion
actue.

Lo que el spec pide (`modelo-datos.md` §5.8, lineas 308-312):

- **Push al organizador en el `INSERT` de la solicitud.**
- **Recordatorio en el punto medio entre `joinedAt` y `expiresAt`**, escribiendo
  `reminderSentAt` para ser idempotente. Sin esa columna, un reintento del job
  reenvia el recordatorio en cada ciclo.
- Las de aceptacion/rechazo, cuando la hay.

Por que sigue afuera: `Notification` quedo deliberadamente sin modelar
(`modelo-datos.md` §7) porque falta la decision de **canal y proveedor** (web
push/VAPID, FCM, APNs, email). Esa decision determina si hacen falta columnas de
destino y si el envio es sincrono o encolado. Un recordatorio agendado a 12 horas
tiene que sobrevivir a un reinicio, asi que no alcanza con tirar un evento a
Redis sin rastro.

`reminderSentAt` ya existe en el schema y hoy no lo escribe nadie: es el
recordatorio sin implementar. La columna esta puesta y la logica no.

## 12. Cuando un lugar deja de estar disponible

Un `Place` es `APPROVED` / `REJECTED` / `PENDING`, y aparte tiene `isActive` y
`deletedAt`. Cualquiera de las tres puede cambiar con planes ya publicados. La
decision es que **el plan no se cancela, pero se cierra la puerta**.

### 12.1 Las dos mitades, y por que van en sentidos opuestos

| | Que pasa con los planes que ya existen | Que pasa con los joiners nuevos |
|---|---|---|
| Lugar deja de estar disponible | **No se toca.** Siguen `OPEN`, con su gente y su `acceptedCount` | **`join` responde 409** |

Cancelar automaticamente seria peor que no hacer nada: un plan es una promesa con
hora y lugar adentro, y la mayoria son kay. Sin canal de notificacion (ver 11.1,
no implementado) un cancel silencioso deja a gente que se presento igual a un plan
que ya no existe, y no hay forma de avisarles. Peor: seria el sistema el que
decide por el organizador, sin que el organizador pueda hacer nada.

Seguir admitiendo gente es el problema de verdad. Curaduria existe para controlar
que lugares son seguros y vigentes; un lugar curado que sigue reclutando
desconocidos deja la curaduria vacia de contenido. Y el riesgo es asimetrico: el
participante existente ya fue aceptado, el nuevo es un desconocido que entra a un
lugar que el equipo dijo que no.

Por eso no es "no hacer nada" ni "cancelar": es **conservar lo compromisingo y
cerrar lo que entra**.

### 12.1-bis Alcance: la decision tambien aplica a `join`, y eso es una extension

La decision se tomo primero para **crear** planes: un lugar que deja de estar
disponible no habilita planes nuevos. Ese era el texto aprobado.

**Bloquear tambien `join` es una extension que se decidio al implementar**, no
algo que estuviera en la decision original, y queda escrito aca para que no haya
que deducirlo del diff: **nueva gente no puede sumarse a un plan existente si su
lugar dejo de estar disponible, aunque el plan en si no se cancele.**

Por que se extendio: es la misma exposicion no controlada. Si el plan siguiera
admitiendo joiners, sacar un lugar de circulacion no impediria que ese lugar
siguiera siendo donde se conoce gente nueva, que es justo lo que la curaduria
existe para evitar. La aceptacion previa del participante existente no es
analoga a la de uno nuevo: a este ultimo se lo expone al lugar por primera vez.

Y por que no contradice la parte de "no cancelar": no son la misma operacion.
Cancelar le rompe la promesa a gente que ya la acepto. Dejar de admitir no le
rompe nada a esa gente; solo deja de crecer el plan.

### 12.2 Donde se aplica

La regla vive en una sola funcion, `planablePlaceWhere()` (`lib/places.ts`), y es
**mas estricta** que `visiblePlaceWhere()` a proposito. Las dos responden preguntas
distintas:

- `visiblePlaceWhere(isCurator)` responde a **descubrimiento**: un curador ve los
  `PENDING` porque para revisarlos los necesita ver. Da visibilidad, no permiso.
- `planablePlaceWhere()` responde a **compromiso**: un plan es una cita con gente,
  asi que el lugar tiene que estar aprobado. Un `CURATOR` con `HOST` tampoco
  puede crear un plan en un lugar `PENDING`: ver un lugar y garantizar por el un
  plan son cosas distintas.

Los dos caminos que escriben usan el mismo predicado:

- `POST /api/plans`: un chequeo rapido antes de la transaccion (para no abrirla si
  el lugar no sirve) y una **revalidacion DENTRO de la transaccion**.
- `POST /api/plans/[planId]/join`: lee el lugar en la misma consulta del plan y
  corta con 409.

La revalidacion interna existe por una ventana concreta: entre el chequeo y el
`create` un curador puede rechazar o desactivar el lugar, y el plan nace en un
lugar que ya no sirve. No es teorico, es la ventana entre dos queries. Es la misma
razon por la que el check de cupo va adentro de la transaccion (ver 10.4).

En `join` la lectura alcanza y no hace falta transaccion: la consecuencia de
perder esa carrera es acotada (queda una fila `REQUESTED` que el organizador puede
rechazar), mientras que en la creacion el plan ya seria publico.

### 12.3 Descubribilidad: el plan desaparece sin dejar de existir

Un plan cuyo lugar deja de estar disponible **no aparece** en `GET /api/plans` ni
en el mapa publico, porque ambos filtran por visibilidad del lugar. Ese filtro ya
existia y no se toco. Lo que se garantizo con tests es que desaparecer del listado
**no** es cancelar: el plan sigue en la base con su gente, y el detalle por id
sigue respondiendo para quien ya lo tenia.

### 12.4 Lo que esta decision NO incluye

- **No hay automatismo de re-aprobacion.** Volver a `APPROVED` reabre el plan
  tal cual estaba; no dispara nada.
- **No hay interfaz de Curaduria.** No existe endpoint para aprobar, rechazar ni
  desactivar un lugar: hoy solo se cambia por SQL. La decision "intervencion
  humana" es coherente con eso, pero mientras no exista la pantalla, "intervenir"
  significa que alguien entra a una consola. Ver deuda 6.
- **No hay cancelacion por lugar inseguro.** La razon se dio mas arriba (no hay
  notificacion), pero tambien falta el dato: `PlaceVerificationStatus` no tiene
  motivo de rechazo, asi que no se puede distinguir "lo bajamos por unsafe" de
  "era un duplicado". Ese campo es la precondicion para revertir esta decision
  cuando exista el canal de notificacion. Ver deuda 7.

### 12.5 Clasificacion de errores de base: 503 no es 404

Corolario del mismo tipo de razon: un error de infraestructura no puede
responderse con un mensaje de negocio. El bug concreto era un `catch { }` pelado
en `join` que contestaba "Ya participas de este plan" a **cualquier** error,
incluida una base caida: el usuario creia que habia entrado y no habia escrito
nada, y en el log el incidente quedaba escondido detras de un 409.

Ahora los errores de conexion y de conflicto transaccional (P1001, P1002, P1008,
P1017, P2028, P2034) se clasifican en `lib/prisma-errors.ts` y se traducen a 503,
que le dice al cliente que **reintente**. Los de constraint (P2002, P2003) los
traduce cada route con su propio mensaje, porque "ya participas de este plan" y
"el lugar no existe" no son el mismo error. Cualquier otro error se propaga.

La distincion entre un `503` y un `404` con mensaje de negocio no es cosmetica: sin
ella, una base caida produce "el lugar no existe" en toda la app, nadie reintenta y
nadie se entera de que la base esta caida.

### 12.6 Que se verifico, y que NO se pudo verificar

Verificado por tests (`tests/map/plans-api.test.ts`, 63 tests):

- No se crea un plan en un lugar `PENDING`, `REJECTED`, desactivado o borrado.
- Un `CURATOR` con `HOST` tampoco puede (rol da visibilidad, no permiso).
- Un plan existente **no** se cancela: sigue `OPEN`, con `acceptedCount` y sus dos
  participantes intactos, y el plan no se borra del `Plan`.
- `join` responde 409 mencionando el lugar, y **no** escribe la fila.
- El mismo `join` con el lugar disponible responde 201 (control negativo, para que
  el 409 de arriba no venga del PK compuesto por error).
- Volver a `APPROVED` reabre el plan sin tocar los participantes.
- El plan desaparece del listado y del mapa, sin dejar de existir.
- `acceptedCount = COUNT(ACCEPTED | ATTENDED)` se cumple desde el primer instante.

Verificado por unit tests (`tests/api/prisma-errors.test.ts`): la clasificacion de
errores de Prisma, incluidos los casos raros (un objeto con `code` que no es
error, `null`, simbolos).

**Lo que NO se pudo verificar, y conviene no vender como cubierto:**

- **La revalidacion dentro de la transaccion.** Sacarla del `create` deja el
  comportamiento HTTP exactamente igual, porque la carrera que previene no se
  puede provocar desde un cliente. Sobrevive al mutation testing
  (`scripts/mutate-plan.mjs`, P8 y E7) y queda como revision, no como test.
- **El cableado de `isRetryableDbError` en los routes.** El server de tests corre
  out-of-process (`tests/setup/server.ts`), asi que `vi.mock` no intercepta sus
  imports. Probario exige cortar la base compartida, lo que haria fallar a todos
  los tests que corren en serie. Se cubre la funcion; el uso, por revision.

## 13. La pantalla de creacion de plan

`/host/planes/nuevo` es la primera pantalla de producto que escribe. La
precededieron el mapa, la lista y el backend de planes, asi que la mayoria de las
decisiones de aca son consecuencia de decisiones ya tomadas; lo que es nuevo es
que por primera vez hay un formulario donde el usuario puede equivocarse, y
donde un error de contrato se ve en pantalla en vez de aparecer en un test.

### 13.1 El selector de lugares pega a un endpoint nuevo, no al publico

La regla de §12 ya estava escrita antes de que existiera el formulario: solo se
puede hacer un plan en un lugar `APPROVED`, activo y no borrado. El selector
tenia dos endpoints disponibles y solo uno servia:

- `GET /api/places?q=` es publico y responde a **"que lugares puedo ver"**. Le
  muestra los `PENDING` a un `CURATOR`, porque verlos es parte de su trabajo.
- `GET /api/host/places?q=` responde a **"donde puedo hacer un plan"**, exige
  `HOST` o `ADMIN`, y aplica `planablePlaceWhere()`.

Se implemento el segundo, y no un parametro `?planable=1` sobre el primero, por
una razon concreta: un `CURATOR` que tambien es `HOST` hubiera visto lugares
`PENDING` en el selector, completado el formulario entero, y el `POST /api/plans`
le hubiera respondido 404 al final. El 404 del servidor habria sido correcto, y
aun asi el error llega tarde y sin decir cual de los dos lados estaba equivocado.
Mostrar solo lo que se puede usar convierte el error en algo que no puede llegar
a ocurrir.

El rol se verifica **dentro del handler**, no en el middleware: el middleware
cubre paginas por prefijo, y una API que se apoyara en el seria un agujero. Es la
misma regla de §4, aplicada a una API nueva.

El `POST` sigue siendo la autoridad. El selector no es una garantia: es una
evitacion del error annoyance. Si un lugar se despublica entre que el host elige
y que envia, el `POST` responde 404 y el formulario lo muestra.

### 13.2 El tope se declara. El `bbox` todavia no

`GET /api/places?q=` y `GET /api/host/places?q=` devuelven `places`, `total` y
`truncated`, con un tope de 20. El formulario escribe "Mostrando 20 de 63" en vez
de dejar que el host escriba "bar" tres veces y concluya que hay dos bares en la
ciudad.

El limite es el mismo, pero **declarado**: es la diferencia entre una app que
trunca y una app que dice que trunca. `findPlacesInBbox` sigue con `take: 500`
sin ningun `total`, que es el defecto original. No se toco porque el mapa ya
funciona y cambiarlo rompe el contrato del cliente del mapa sin gain asociado.

`q` y `bbox` no se combinan en una misma llamada: son modos alternativos de la
misma consulta, y mezclarlos en silencio daria un `AND` que el usuario no pidio
(un `bbox` con la caja del mapa y un `q` de "bar" devolveria la interseccion, que
se ve como "no hay lugares"). Los dos juntos, o ninguno, dan 400 con el motivo.

La busqueda es por subcadena, sin distinguir mayusculas, y ordena alfabeticamente
porque es lo que Prisma ordena sin SQL crudo. **No es insensible a acentos**:
"panaderia" no encuentra "panadería", y no hay indice trigram. Queda como deuda,
no como decision.

### 13.3 La zona horaria, y un bug de las 12 horas que aparecio en el camino

`<input type="datetime-local">` entrega una hora de pared sin zona. El modulo
`lib/plan-dates.ts` la convierte con `toApiDate`, que devuelve `null` ante una
fecha invalida en vez de dejar que `.toISOString()` tire un `RangeError` que
tumba el render del componente entero.

La conversion vive en un modulo sin React, con sus propios tests, y no dentro del
componente: los bugs de zona horaria se testearon de verdad y no los cubre ni
`tsc` ni por el build. Tres casos que estan cubiertos a proposito:

- El round-trip entre los dos formatters del modulo (`toLocalInputValue` y
  `toApiDate` son independientes, asi que probarlos juntos no es tautologico).
- `nextQuarterHour` redondea **hacia arriba** y nunca devuelve un instante
  pasado. Con redondeo al mas cercano, `19:07` daba `19:00`, que ya habia
  pasado, y el `min` del input invalidaba el valor que el modulo acababa de
  calcular.
- Los tests no dependen de la zona del proceso. Corren en UTC; comparar contra
  horas de Buenos Aires escritas a mano probaria la maquina, no el codigo.

**No se fija `America/Argentina/Buenos_Aires` en ninguna parte, y es
deliberado.** La convencion que ya usaba el listado del explorador es "el
instante es absoluto, y la pantalla lo muestra en la zona del que mira". Fijar la
zona de la app en el formulario haria que el **mismo plan** se viera a distinta
hora en el listado y en la pantalla de confirmacion, y en cualquier superficie
renderizada en el server el HTML llegaria con una hora y el navegador calculara
otra. La consecuencia asumida, y no resuelta: un plan de Buenos Aires visto desde
Madrid aparece a la hora de Madrid. Arreglarlo de verdad es mostrar la zona del
lugar junto a la hora, y eso es una decision de producto.

Escribiendo los tests de `formatPlanMoment` aparecio un bug que no buscaba:
**`es-AR` con ICU rinde 12 horas**. Un plan de las 20:00 se mostraba como
`08:00 p. m.`, que es exactamente el dato que un horario no puede permitirse. Y
el defecto ya estaba en dos superficies del explorador, con tres
implementaciones distintas de "mostrar la hora de un plan". Se corrigieron las
tres y ahora salen de `formatPlanMoment`, con `hourCycle: 'h23'` explicito:
`hour12: false` no alcanza, porque en varias combinaciones de locale e ICU rinde
`24:00` a la medianoche en vez de `00:00`.

### 13.4 Una sola fuente de enums, por un bug que los tests no veian

`app/explore/explore-client.tsx` tenia su propia copia de los filtros con
`CHEAP`, `MODERATE`, `EXPENSIVE` y `LUXURY`. **Ninguno de esos valores existe** en
el enum, que es `FREE/LOW/MEDIUM/HIGH`. Elegir un precio mandaba
`?priceLevel=CHEAP` y recibia un 400: el filtro estaba roto y nadie lo notaba.

El motivo por el que nadie lo notaba es el que importa. Existia un test que
compara `PLACE_CATEGORIES` y `PRICE_LEVELS` contra Prisma, y estaba en verde:
las dos listas que comparaba estaban bien. **La copia que mentia era una
tercera, en el cliente, y el test no la miraba.** Un test de sincronia solo
mira las copias que conoce.

La correccion no fue actualizar los cuatro valores, fue borrar la copia: las
listas viven en `lib/enums.ts`, `lib/validation.ts` las re-exporta, y el
explorador las importa. Un filtro de precio desincronizado ya no se puede
escribir. Y se agregaron dos tests mas: toda categoria y todo precio tienen
etiqueta, y ninguna etiqueta sobra, porque un enum nuevo sin etiqueta se
renderiza como `<option>{undefined}</option>` y no rompe el build.

### 13.5 Que se verifico, y que NO

Verificado por tests:

- `tests/map/places-api.test.ts` (47): el contrato de `?q=`, el XOR con `bbox`,
  el piso de 2 caracteres medido sobre el texto recortado, la visibilidad, los
  filtros de categoria y precio **con su caso negativo**, el tope visible, y los
  valores de enum sincronizados con Prisma.
- `tests/map/host-places-api.test.ts` (13): el gate por rol, que un `PENDING` no
  aparece ni para un curador (mientras que en el endpoint publico si), que
  `REJECTED`/inactivo/borrado tampoco, que la lista de campos es cerrada y no
  incluye datos del dueno, y que un lugar que el selector ofrece es aceptado por
  el `POST` real.
- `tests/map/plans-api.test.ts` (85): el detalle, su `viewer`, la visibilidad por
  lugar, y la excepcion de §12 para quien ya esta adentro. Lo de §13.6.
- `tests/map/new-plan-page.test.ts` (8): que el middleware rechaza la pagina sin
  rol y no solo la API, que renderiza, que cada control tiene su `id` parejado
  con su `label`, que los limites del cliente coinciden con el schema, que el
  HTML inicial no trae lugares, y que el selector pega a `/api/host/places` y no
  al endpoint publico (buscado en los chunks, porque en el HTML no esta y el
  test pasaria siempre).
- `tests/api/plan-dates.test.ts` (13): las conversiones de fecha, independientes
  de la zona del proceso.

Suite completa en este punto: **15 archivos, 276 tests**.

#### Verificado a mano, sin automatizar

La accion central de la pantalla --el `onSubmit`-- es la unica pieza sin cobertura
automatizada, asi que se ejecuto **una vez de punta a punta** y quedo registrado.
El procedimiento esta versionado en `scripts/manual-plan-flow.mjs`
(`node scripts\manual-plan-flow.mjs`): levanta `next start`, siembra un lugar
aprobado y uno pendiente, se registra por la API, inicia sesion con cookie real,
abre la pagina, busca el lugar, arma el body **exactamente como lo arma el
componente** (con el `toApiDate` real del modulo, no con una copia), envia el
`POST`, y verifica en la base. Al final limpia lo que sembro. **No corre en
`npm test` y no se agrego a la suite**: no hay DOM en el harness, y agregar una
dependencia para eso es otro trabajo.

Lo que quedo verificado, con el server de produccion y el middleware reales:

- La pagina responde 200 con sesion de host y **401 sin sesion**: el gate del
  middleware frena la URL escrita a mano.
- El buscador trae el lugar aprobado y **no** trae el `PENDING`, y
  `q` de un caracter da 400 con el motivo.
- `POST /api/plans` responde 201.
- En la base: `title` y `description` exactos, `placeId` al lugar elegido,
  `capacity` 4, `status` `OPEN`, `acceptedCount` 1, `creatorId` del host, y
  **un** participante con `role` `ORGANIZER`, `status` `ACCEPTED` y `userId` del
  propio host.
- El plan recien creado aparece en el listado del mapa, y el listado devuelve el
  **mismo instante** que se guardo, como ISO y no como texto de 12 horas.
- Los tres caminos de error que el formulario tiene que pintar: lugar
  desactivado entre elegir y enviar (**404**), plan de mas de 24 horas (**400 con
  `fields.endsAt`**, que es lo que se muestra debajo del input), y lugar
  `PENDING` (**404**).

Lo que la pasada **no** cubre sigue siendo el click y el render del estado de
exito en un navegador. Lo que si cubre es todo lo demas, y antes de correrla nadie
habia ejecutado el flujo ni una vez.

**Un hallazgo que la pasada produjo y la teoria no:** la maquina de desarrollo
corre en `America/Bogota` (UTC-5), no en Buenos Aires. Un plan creado a las 20:00
desde ahi se guarda como `2026-10-09T01:00:00.000Z` y **vuelve a las 20:00 en
Bogota y a las 22:00 en Buenos Aires**. O sea: la consecuencia de §13.3 no es
hipotetica, se puede ver en una linea. Para un producto donde todos los usuarios
estan en la misma zona no importa; el dia que no esten, hay que mostrar la zona
del lugar junto a la hora.

**Lo que NO se pudo verificar, y conviene no vender como cubierto:**

- **El click y el `onSubmit` en si.** La pasada manual arma el mismo body y pega al
  mismo endpoint, pero el componente React no se ejecuta: no hay navegador. Que el
  `POST` cree el plan esta cubierto contra el endpoint; el cableado del
  componente, no. Un test de componente con DOM exigiria una dependencia que el
  proyecto no tiene.
- **La carrera del buscador.** El `AbortController` que cancela la busqueda
  anterior esta escrito y razonado, pero reproducir dos respuestas en orden
  inverso desde un test HTTP no es posible con el harness actual.
- **Que el `min` del input se vea bien.** Es un atributo renderizado, no
  comportamiento de navegador.

### 13.6 La asimetria detalle/listado: el camino que nadie prueba

Antes de construir la pagina de detalle (el paso siguiente de "unirse a un
plan") se cerro el endpoint que la va a alimentar, y aparecieron dos huecos de la
misma familia: cosas que funcionan browsing el listado y se rompen en otro
camino.

**Hueco 1: el detalle era ciego al viewer.** El listado ya traia
`viewer: { isCreator, participation }` desde la primera version de
`findPlansInBbox`, con un comentario que lo decia: "el cliente no tiene que
inferirlo de los participantes". El detalle no traia nada de eso.

No es un detalle menor: la unica forma de que el cliente supiera si ya habia
pedido era hacer el `POST /join` y leer el `409 { status }`, o sea **hacer una
accion con efecto secundario para averiguar un estado**. El propio handler del
join devuelve el status en el 409 precisamente para eso (dice "para que el
cliente pueda pintar 'esperando aprobacion'"), pero eso sirve *despues* de
intentar, no al abrir la pagina. Una pagina de detalle sin esto esta obligada a
adivinar, o a disparar una peticion con efecto secundario al abrir.

Se agrego `viewer` al detalle, con los mismos nombres y el mismo significado que
en el listado, mas `remainingSpots` e `isFull` para que el cliente no vuelva a
derivar el cupo.

**Hueco 2: el detalle no filtraba por visibilidad del lugar.** El listado usa
`visiblePlaceWhere()`; el detalle no filtraba nada. Un plan cuyo lugar paso a
`REJECTED` desaparecia del mapa pero se abria por URL, con el boton "unirme"
pintado, y el 409 de §12 ("El lugar de este plan ya no esta disponible")
aparecia recien despues del click.

El detalle ahora usa `visiblePlaceWhere(isCurator)`, la **misma** funcion que el
listado. Importa que sea la misma y no una mas restrictiva: si el detalle fuera
mas estricto, un curador veria el plan en el mapa y el link le daria 404, que es
la misma clase de link roto al reves. Coincidir con la regla de descubrimiento es
lo que hace que el link sea un link.

##### La excepcion: `OR` de tres ramas, y por que

Aplicar el filtro tal cual era **incorrecto**, aunque arreglara el link roto. §12
decidio que un lugar que deja de estar disponible NO cancela los planes que ya
tiene. Con el filtro solo, el organizador y los confirmados perdian el detalle de
su propio plan: la URL guardada daria 404, igual que si el plan nunca hubiera
existido, sin ningun mensaje que explicara por que.

Eso es el mismo dano que cancelar, pero en silencio, que es justo lo que §12
queria evitar. La contradiccion no era de este endpoint: era de aplicar una regla
de descubrimiento a un caso que no es descubrimiento.

El `where` quedo como un `OR` de tres ramas:

| Rama | A quien deja pasar |
|---|---|
| `place: visiblePlaceWhere(curator)` | descubrimiento, igual que el listado |
| `creatorId: viewerId` | el organizador, siempre |
| `participants: some { userId, status in (ACCEPTED, ATTENDED) }` | los que ya tienen lugar |

El criterio es el mismo que se uso en todo el proyecto: **proteger a quien ya
invierto algo, no a quien todavia no llego.** Quien solo PIDIO no entra, y no es
una piedad artificial: al `join` lo habria rechazado el mismo filtro, con el 409
de §12. La excepcion no mira el motivo por el que el lugar no es visible, y eso
no abre un agujero: **un plan no se puede crear en un lugar que no sea
`APPROVED`**, asi que la unica forma de que exista un plan en un lugar `PENDING` es
que el lugar estuviera `APPROVED` y lo bajaran. Es el mismo caso que `REJECTED` --
degradado despues -- y no un lugar nunca aprobado.

Deliberadamente **no** entran `REQUESTED`, `DECLINED`, `CANCELLED` ni `NO_SHOW`:

- `REQUESTED` no tiene lugar guardado todavia.
- `DECLINED` y `CANCELLED` signifieron que no va.
- `NO_SHOW` es un caso aparte. El planton sigue siendo parte de la reliability del
  organizador, que §13.5 deja en `/requests`, con su propio corte. Este detalle es
  descubrimiento, y mezclar las dos pantallas seria filtrar historial de terceros
  a cualquiera con sesion.

Y el `deletedAt` del PLAN sigue por encima del `OR`: la excepcion es sobre el
lugar, no sobre el plan. Un plan borrado logicamente le da 404 a todos, incluido el
organizador, y hay un test que lo fija.

#### Un detalle de Prisma que costo un compile fallado

`findPlansInBbox` resuelve el estado del viewer **en la misma query**, filtrando
`participants` por `userId`. No se puede copiar eso en el detalle: la respuesta
necesita tambien la lista de confirmados, o sea dos lecturas de la misma relacion
con `where` distintos, y `select` de Prisma no admite repetir una clave ni
aliasear una relacion. La primera version de esto metio un `mine` que no existe
en el modelo y no compilo (`Object literal may only specify known properties`).

Lo que quedo es una segunda consulta por `planId_userId`, que es el PK compuesto
ya indexado. Una consulta indexada mas a cambio de que la pagina no tenga que
preguntar con un POST.

#### Y un detalle del fixture, que miente sobre el invariante

`createPlan({ acceptedCount: 1 })` inserta la fila de `Plan` pero **no** crea la
`PlanParticipant` del organizador. O sea, el contador queda diciendo 1 con cero
filas de participantes. El test de invariante `acceptedCount = COUNT(ACCEPTED |
ATTENDED)` pasa igual porque crea el plan por la API, no por el fixture.

No se toco el fixture: cambiarlo altera el significado de todos los tests que lo
usan. Pero conviene saberlo, porque cualquier test futuro que afirme sobre la
**lista** de confirmados con este fixture va a obtener `[]` y va a parece un bug
del endpoint. El detalle arma esa lista desde `PlanParticipant`, no desde el
contador, que es lo correcto: el contador es un cacheo, la fila es la verdad.

#### Mutation testing de los dos guards

Ningun test nuevo sirve si no muere cuando se saca lo que verifica:

| Mutante | Tests que mueren |
|---|---|
| `place` sin filtro de lugar (todo) | 4 de 5 |
| `place` solo sin `verificationStatus` | 2 de 5 (los de `isActive` sobreviven, y deben: el mutante los conservaba) |
| `viewer.participation` forzado a `null` | 2 |
| rama de la excepcion (confirmados) eliminada | 4 |
| excepcion ampliada a `cualquier` participacion | 3 (los de `REQUESTED`, `DECLINED` y `NO_SHOW`) |

Los dos ultimos importan mas de lo que parecen. Con un `OR` de este tipo, el
peligro no es que la excepcion falte, es que **se/contamine**: que ver el plan
por estar adentro lo vuelva visible para todos. El mutante ampliado a cualquier
participacion es el que caza eso, y lo cazan los tres tests de los estados que
deliberadamente quedan afuera.

El quinto test del grupo de visibilidad no muere con ninguno de los dos: es el
caso positivo del curador con lugar `PENDING`, que da 200 con y sin filtro. No es
un test discriminante, es un **guarda contra sobre-restringir**: sin el, un
cambio futuro a `planablePlaceWhere` cerraria el detalle a los curadores y
volveria a romper el link. Se deja a proposito.

Suite completa en §13.6: **15 archivos, 298 tests** (85 en `plans-api.test.ts`: los 63
de antes, +22 de §13.6, 11 de los cuales son la excepcion de §12).


### 13.7 Mutation testing del contrato de busqueda

`scripts/mutate-search.mjs`, 12 mutantes sobre `?q=`: 11 matados, 0
sobrevivientes, 1 sin compilar.

Los dos primeros sobrevivientes fueron **tests que pasaban por la razon
equivocada**, y por eso vale la pena contarlos:

- El test de "no mandes `bbox` ni `q`" comprobaba que el mensaje contenga
  "Falta". `parseBbox` tambien responde 400 cuando no recibe caja, con un
  mensaje de formato. El test pasaba con el error equivocado. Ahora verifica que
  el mensaje nombra las dos opciones **y** que no es el de formato.
- El test de filtro por categoria buscaba la categoria **correcta**. Con el
  filtro eliminado, el unico lugar de la fixture era de esa categoria y
  coincidia igual. Le faltaba el caso negativo: buscar una categoria que
  *deberia* excluirlo.

Los dos casos que se agregaron son los que hacen que el filtro se verifique de
verdad. Los dos que quedan en el otro lado de la ecuacion --"esta asercion prueba
lo que creo" y "este test pasa por el motivo correcto"-- no tienen forma
automatica todavia. Quedan como revision.

El mutante Q12 (quitar el filtro de `isActive`) no compila porque el array de
`in` se infiere como `string[]` y no es asignable al enum. Se dejo desactivado y
anotado: `isActive` y `deletedAt` salen del mismo `visibleWhere` que Q7 ya
mata, y estan cubiertos por el test HTTP. Un mutante que prueba lo mismo por
otra ruta no agrega cobertura, agrega tiempo.

### 13.8 La pagina de detalle, y por que unirse no es un boton del mapa

`app/(user)/planes/[planId]/page.tsx` es un Server Component que pasa el id y
nada mas. No consulta la base. Es la continuacion de §13.6: si el server
consultara el plan, la regla de visibilidad de §12 estaria escrita dos veces, y
las dos copias se separan en el primer cambio de una de las dos.

Eso no es una preferencia: hay un test que **falla** si el HTML trae el titulo, el
lugar o el organizador. Si aparecen, es que el Server Component empezo a
consultar.

#### El tipo de la respuesta no esta duplicado

`PlanDetail` vive en `lib/plans.ts` y es `PlanSummary` con un campo mas,
`participants`. El endpoint **anota** lo que devuelve con ese tipo:

```ts
const body: { plan: PlanDetail } = { plan: { ... } }
```

y el cliente importa el mismo tipo. Antes de esto, el cliente declaraba su propia
copia de la forma y el comentario de arriba de ese archivo decia, textual,
"no hay un tipo propio que re-declare los campos: si el endpoint agrega o saca
algo, el compilado avisa". Era falso: `res.json()` es `any` y una copia local no
avisa de nada. El comentario describia la propiedad que faltaba.

Verificado por mutacion: sacar `isFull` de la respuesta rompe `tsc` con
`TS2322 ... not assignable to type 'PlanDetail'`.

Los unions de `PlaceCategoryValue` y `PlacePriceValue` se exportan desde
`lib/enums.ts` por el mismo motivo, y con el mismo argumento de §13.4: un
`category: string` hace que `CATEGORY_LABELS[categoria]` compile y devuelva
`undefined` en pantalla. Al revisarlos aparecieron **dos copias locales** de esos
unions, y una de ellas estaba debajo de un comentario que decia que los uniones
venian de `lib/enums`. Las dos se importan ahora. Un comentario que afirma una
propiedad de las lineas de al lado vale exactamente lo que valen esas lineas.

#### Unirse es desde el detalle, y por que

La tarjeta del mapa no ofrece "unirme", y el motivo no es la cantidad de clics:
es que la tarjeta no alcanza para decidir. Ahi se ve el plan, el lugar y la hora.
Lo que hace falta antes de comprometerte con alguien --que escribe la descripcion,
quien organiza, cuanta gente va, si el organizador cumple-- no esta, y
desplegarlo ahi seria la pantalla que el mapa no es. La peticion ademas requiere
aprobacion explicita: entrar es un compromiso con una persona, no una reserva de
butaca.

Por eso el detalle muestra, y por eso no muestra reliability de terceros (§13.2):
es informacion del organizador y solo el organizador la ve, en `/requests`.

#### Un enlace adentro de un boton

El `li` del plan tiene dos elementos, no uno: el `button` que mueve el mapa y el
`Link` al detalle. No se pueden combinar. Un enlace dentro de un boton es HTML
invalido, el teclado lo recorre como un elemento solo y el click se dispara dos
veces.

#### Un test verde por la razon equivocada

El primer test de esta pagina afirmaba que el HTML contenia `/explore`. Fallaba:
`Link` es un Client Component y no se renderiza en el servidor. El test se
arreglo para buscar en el chunk, que es donde vive. Se deja anotado porque el
sintoma era el de un producto roto y la causa era del test, y esa confusion es
justa la que hace que un test verde no valga nada sin saber por que.

Los guards se comprobaron con mutantes, como en §13.7:

| Mutante | Muertos |
| --- | --- |
| `AUTHENTICATED_PREFIXES` sin `/planes` | 3 |
| Sin el enlace al detalle en el listado | 2 |
| `isFull` fuera de la respuesta | `tsc` (no hay test que lo detecte) |

#### Lo que NO hay

Sin DOM, no hay forma de clickear "Pedir unirte" desde los tests. La decision que
gobierna el boton se extrajo a `lib/plan-join.ts` -- pura, y con los diez estados
tableados en `tests/map/plan-join.test.ts` (21 tests) -- asi que lo que queda sin
cubrir es **solo** el cableado: que el `onClick` llegue al `fetch`. Ese es el
hueco, y es chico a proposito: antes cubria la decision y el cableado, y no
cubria ninguno de los dos con evidencia.

Mutantes de esa funcion:

| Mutante | Muertos |
| --- | --- |
| `CANCELLED` evaluado antes de "ya empezo" | 1 |
| `isCreator` evaluado despues de "ya empezo" y de `CANCELLED` | 2 |

El segundo **sobrevivio** a la primera tanda de tests. Con `isCreator` movido
abajo, el organizador de un plan ya empezado leia "este plan ya empezo", que es
un mensaje para invitados, y ningun test lo notaba porque todos los casos de
organizador usaban un plan futuro. Los dos tests que lo matan existen por eso, y
no por cobertura en general.

`POST /join` con exito, con 409 y con plan lleno ya tienen sus propios tests en
`plans-api.test.ts`. La pasada manual de §13.5 cubre el resto del camino de
creacion por HTTP, pero **no** puede cubrir este: un GET no ejecuta JavaScript.

Ese hueco se cerro el 2026-09-28, sin agregar un harness de DOM. Se manejo un
**Edge real headless** por DevTools Protocol (WebSocket nativo de Node, sin
Playwright ni Puppeteer) contra `next dev`, con la cookie de sesion firmada por
el mismo `createSessionToken` del server -- el proyecto no tiene pantalla de
login. El navegador ejecuto el `onClick` de verdad y se observo:

- `201 POST /api/plans/<id>/join` en la red, no un GET.
- El boton desaparecio y quedo el estado: "Pediste unirte. Esperando que el
  organizador responda."
- Tras recargar, el estado persistio, y la base lo confirma: la fila
  `PlanParticipant` del joiner quedo `REQUESTED`, con `expiresAt` puesto.

Es mas fuerte que "un humano miro", porque es un Chromium real corriendo el React
real. Pero **no** entra a la suite: sin dependencia de navegador y con la decision
ya extraida a `lib/plan-join.ts`, un harness de DOM permanente no paga su costo.
Se reproduce con `scripts/manual-join-setup.mjs` mas el driver ad-hoc. Ojo con el
host: la URL tiene que ser `localhost` (ver seccion 7).

Suite completa: **17 archivos, 335 tests** (16 de §13.8 + 21 de `plan-join.test.ts`).

#### El scan de caracteres: ahora mira mas que CJK

Escribiendo esta pagina se colaron dos veces las letras `e` y `d` en cirilico
dentro de la palabra `Pediste`, y el scan de CJK no las veia. Compilaba, los tests
pasaban, y en pantalla quedaba con dos letras de otro alfabeto pegadas: ni el
editor ni TypeScript lo salen, y un string asi se ve bien en el codigo.

El rango cirilico esta ahora en `scripts/scan-nonlatin.mjs`, con el griego y las
IPA. Griego se permite **solo en `docs/`**: `docs/modelo-datos.md` usa la alfa en
la formula del score, y dos falsos positivos por corrida son la forma segura de
que un scanner se apague. En codigo el griego sigue prohibido, porque omicron y
rho son indistinguibles de `o` y `p`.

Verificado: el scan detecta `U+0435 U+0434` en una linea de codigo, que es
exactamente lo que no detectaba.

`npm run check` corre el scan y el typecheck juntos. El scan estaba como un
comando suelto que alguien tiene que acordarse de correr, y lo que no esta en un
script no se ejecuta siempre.

### 13.9 Deuda que dejo este trabajo

- El listado de "mis planes", la revision de solicitudes y la cola de reportes
  siguen sin existir. La pagina de gestion ahora lo dice en vez de seguir siendo
  un placeholder que se lee como terminado.
- `address` y `city` existen en el modelo `Place` pero no estan en
  `PLACE_SELECT`, asi que el selector no puede mostrarlos. Agregarlos cambia la
  forma de la respuesta **publica** de `/api/places`, y eso no se cambia de
  pasada.
- La busqueda no es insensible a acentos y ordena alfabeticamente. Un indice
  trigram, o un ranking por prefijo, son trabajo de DB. La sensibilidad a acentos
  se **vio en vivo** en la pasada manual: `Cafetería` y `Cafeteria` son cadenas
  distintas para Postgres, y el host que escriba sin tilde no encuentra nada.
- Un plan se muestra en la zona de quien mira, no en la del lugar. Verificado
  empiricamente en la pasada manual: 20:00 en Bogota son 22:00 en Buenos Aires.
- El picker no esta en un componente propio: vive en `plan-form.tsx` con el resto
  del formulario. Se extrajo la parte pura (`describePlace`, la conversion de
  fechas) pero el estado de la busqueda sigue mezclado con el del formulario.

## 14. El test de personalidad: modelo completo, matching en otro dia

Primer paso del vertical slice que va del registro al plan. Se escriben
`Result + Answer + Score` y se muestran los rasgos. **No hay matching**: los rasgos
no cambian que planes aparecen, y la pantalla del perfil lo dice, para que nadie
crea que el test le esta filtrando el mapa.

### 14.1 Por que el scoring esta en `lib/personality.ts` y no en el endpoint

`PersonalityScore` esta en su propia tabla justamente para poder recalcular con otro
algoritmo sin perder las respuestas (§5.6 de `docs/modelo-datos.md`). Si el calculo
viviera pegado al `POST`, cambiarlo obligaria a que todos vuelvan a hacer el test, y
eso deshace la separacion de tablas que el schema ya paga.

La consecuencia practica es que el algoritmo se prueba **sin base de datos**, con
arrays, en `tests/map/personality-score.test.ts` (14 tests), y el endpoint solo tiene
que pasarle filas.

### 14.2 Se suma, no se promedia

El score de un trait es la **suma** de los `scoreDelta` de las opciones elegidas.
Un promedio daria el mismo rango para todos los traits y dejaria el `weight` de cada
pregunta sin efecto practico, que es no pesar nada disfrazado de ponderacion.

La consequence que hay que tener presente: los traits **no comparten escala**. Con el
contenido de la v1, `nueva_gente` y `charlas` (dos preguntas, pesos 1 y 0.5) llegan a
+-2.25, e `improvisar` y `ambiente_calmo` (una sola pregunta, peso 1) llegan a +1.5.

Por eso el rango se **calcula del contenido** (`rangosDeTest`) y no se hardcodea ni
se guarda en una columna: agregar una pregunta cambia el rango solo, y un rango
guardado se queda viejo sin que nada avise. Y por eso la normalizacion a 0..1 ocurre
en la lectura, no en la tabla: `PersonalityScore` guarda el numero crudo, que es el
que sirve para ordenar cuando exista el matching.

El rango es el de la **suma**, no el de una opcion suelta. Tomar el minimo y el maximo
de todas las opciones juntas daba el mismo rango para cualquier trait con una pregunta
de peso 1, y dejaba el nivel mas alto inalcanzable en los traits de dos preguntas,
sin que nada pareciera roto. Un test de `personality-page.test.ts` lo mato.

### 14.3 La integridad que la base no puede dar

`PersonalityAnswer` no tiene `questionId`: llega a la pregunta por el `optionId`, y su
unico es `@@unique([resultId, optionId])`. Ese unico impide repetir la **misma**
opcion. No impide responder dos veces a la misma pregunta con dos opciones
distintas: son filas distintas y las dos pasan.

O sea que la base acepta un resultado con las cinco opciones de la pregunta 1 y
ninguna de la 2, y un score que no representa a nadie. Por eso `verificarRespuestas`
compara el set de preguntas del test contra el set de preguntas respondidas, y exige
**exactamente** una: "al menos una" dejaria pasar el caso de la pregunta contestada
tres veces, que es justo el que el unico de la base no atrapa.

Mutante: anular el `throw` de `problemas.length > 0` mata 4 tests en
`personality-api.test.ts`.

### 14.4 `scoreDelta` no viaja al cliente

`GET /api/personality/test` devuelve preguntas y opciones **sin** el `scoreDelta`. Es
el algoritmo del servidor, y mandarlo haria que el cliente pudiera calcular el score
por su cuenta. Hoy eso no cambia nada porque no hay matching, pero el dia que lo haya,
el score guardado tiene que ser el que calculo el servidor: mandarle el dato para
que lo repita es la forma facil de que los dos dejen de coincidir sin que nada falle.

Mutante: agregar `scoreDelta` al `select` del `GET` mata 1 test, que mira el JSON
entero y no un campo puntual.

### 14.5 El 409 de version, y por que no es un 400

El cliente manda `testId` en el body aunque el servidor sepa cual es la version activa.
Sin el no hay forma de distinguir "respondio mal" de "mientras contestaba se publico
la v2": la primera se rechaza y la segunda se vuelve a empezar, y no pueden terminar
igual.

El `POST` compara contra la version activa y devuelve **409** con
`code: 'test_desactualizado'`, no 400. No es purismo de version: el score se calcula
con el `scoreDelta` de ESA version, y aceptar una v1 mientras la v2 esta publicada
guarda un score con la escala vieja. El 409 le dice a la UI "recarga y arranca de
nuevo" en vez de "mostrar formulario de errores" para algo que la persona no puede
arreglar. Mutante: anular la comprobacion de `isActive` mata 1 test.

### 14.6 Un endpoint caro y uno barato

`GET /api/personality/test` son ocho preguntas con cinco opciones, unas 40 filas.
`GET /api/personality` es un booleano mas la version. Existen los dos porque el mapa
necesita el segundo en cada visita y no tiene por que pagar el primero para averiguar
un "si".

La version que devuelve el endpoint barato es la **activa**, y el resultado se manda
aparte como `resultadoVersion`. "Tengo resultado" y "tengo resultado de la version
que te estoy mostrando" no son lo mismo: sin las dos, publicar una v2 apaga el
recordatorio para todos los que hicieron la v1 y el boton de rehacer desaparece solo.

En `explore-client.tsx` el recordatorio va en su propio `useEffect`, **no** en el
`load` que ya existe: ese se vuelve a correr en cada movimiento del mapa, y preguntar
lo mismo en cada panoramica para obtener la misma respuesta es ruido de red.

### 14.7 Saltable, con recordatorio, sin modal

El test no bloquea `/explore` ni ninguna otra pantalla. El recordatorio es una linea
en el mapa, con un enlace y una X.

La X es lo que lo hace pasivo de verdad. Un recordatorio que vuelve en cada visita
se vuelve ruido a la tercera, y el ruido enseña a ignorar el banner entero, incluido
el dia que sirva avisar de algo que si importa. Cerrarlo es una decision de la persona
y se respeta.

`/explore` es publica, asi que sin sesion no hay recordatorio: empujar al registro a
alguien que solo esta mirando lugares convierte el mapa en una puerta de registro.

### 14.8 El contenido, y por que vive en `prisma/personality-v1.mjs`

Cinco traits (`nueva_gente`, `charlas`, `actividad`, `improvisar`, `ambiente_calmo`),
ocho preguntas, cinco opciones cada una. Vive aparte de `prisma/seed.mjs` y aparte de
los tests por una razon concreta: **la misma fuente alimenta a los dos**. Un test de
API con su propio cuestionario de juguete pasaria aunque el seed este roto, que es el
bug mas caro: la pantalla muestra 404 en la base de desarrollo y los tests estan en
verde.

Las cinco opciones van de `-1.5` a `+1.5` y **la del medio vale cero de verdad**. Con
cuatro opciones no hay neutral, y alguien que genuinamente no sabe --o que no quiere
inclinarse-- tiene que mentir un poco para poder avanzar. La audiencia de Nexa tiene
ansiedad social por definicion; un test que obliga a emitir una opinion que no tiene
es un test que empieza mal. Un `scoreDelta` de cero se guarda como cero y es
distinto de "no contesto": para un filtro futuro uno es una opinion nula y el otro no
tiene dato.

El `scoreDelta` se **deriva de la posicion** de la opcion, no se escribe en las
cuarenta. Escribirlo a mano son cuarenta oportunidades de que una quede corrida, y
una sola opcion corrida cambia el resultado de todas las personas que la eligieron.

El seed es idempotente por `key` y por `version`, **no** borra y recrea: un
`deleteMany` al principio llevaria los `PersonalityResult` con el Cascade, y con
ellos las respuestas de todos los que ya lo completaron. Publicar una v2 tiene que
SER agregar filas.

### 14.9 La una transaccion

`Result + Answer + Score` se escribe en una sola transaccion. No es por prolijidad: el
schema separa las tres tablas para poder recalcular, y esa separacion deja abierto que
un `Result` quede sin `Answer`, o con `Answer` y sin `Score`. Son estados que la base
permite porque cada uno es valido por separado, y que un lector interpretaria como
"esta persona no contesto" cuando en realidad la escritura se corto a mitad. O se
escribe el set entero, o no se escribe nada.

`P2002` en `@@unique([userId, testId])` significa dos `POST` a la vez. El chequeo de
"ya lo hizo" esta adentro de la transaccion pero no bloquea una fila que todavia no
existe, asi que la carrera es real y la resuelve la base. Que llegue ahi es lo
esperado.

### 14.10 Tres bugs que encontraron los tests, no la revision

Los tres son del mismo genero: **ninguno habria exploado en dev**, y los tres se
manifiestan como "la pantalla dice algo que no es cierto", que es la clase de bug
mas dificil de reportar porque la gente la reporta como bug de producto.

1. `rangosDeTest` indexaba por `traitId` y se consultaba por `key`. El lookup fallaba
   siempre y caia al rango por defecto: la pantalla mostraba "muy alto" a un puntaje
   que no era muy alto, y no habia ningun error.
2. El rango se calculaba sobre una opcion suelta en vez de sobre la suma (§14.2). Lo
   mato un test que compara el rango de un trait de dos preguntas contra uno de una
   sola, y que no existia hasta que el perfil mostro el numero. Mutante verificado:
   volver al calculo por opcion suelta mata 1 test.
3. `tocaRecordar` comparaba `resultadoVersion !== null` pelado. Como el campo es
   opcional en el tipo, un `undefined` pasaba los dos tests y daba `true`: alguien con
   el resultado ya cargado y el campo ausente veia "hay una version nueva" sin que
   existiera. La API siempre manda el campo, asi que en produccion no habria pasado;
   lo que estaba roto era el tipo, que permitia el estado.

El primero y el segundo son del mismo origen: mismo nombre, dos cosas distintas
(`traitId` contra `key`; el delta de una opcion contra la suma de las elegidas). Los
dos se podian evitar leyendo el `select` en vez de suponerlo.

### 14.11 Lo que NO esta cubierto

- El render de las opciones del test, el estado del boton y el resaltado de la
  opcion elegida. Es codigo de cliente y no hay navegador ni Playwright en este
  proyecto: los tests de HTTP no ejecutan JavaScript.
- El recordatorio **en pantalla**. Lo que se prueba es `tocaRecordar`, la regla, en
  `tests/map/personality-reminder.test.ts` (9 tests). Que el `div` aparezca con la
  clase correcta no esta probado y no se puede probar sin navegador.
- El `error` del `fetch` de `/api/personality` en el mapa se traga a proposito: un
  recordatorio no vale romper la pantalla. No hay test de ese camino.

La logica del recordatorio estaba dentro de `explore-client.tsx` cuando se escribio
esta seccion, y por eso no tenia test: `explore-page.test.ts` solo puede afirmar por
HTTP que el mapa renderiza. Se movio a `lib/personality-reminder.ts` y ahi si se pudo
probar, que es el mismo camino que `lib/plan-join.ts`.

Suite completa: **21 archivos, 398 tests** (14 de `personality-score.test.ts`, 23 de
`personality-api.test.ts`, 17 de `personality-page.test.ts`, 9 de
`personality-reminder.test.ts`).

### 14.12 Deuda que dejo este trabajo

- El perfil no tiene forma de rehacer el test. Se decide desde el recordatorio del
  mapa, a proposito, pero es una decision de producto y no mia.
- No hay version 2 sembrada, asi que la comparacion entre versiones que pide §5.6
  **no esta probada**: solo el camino del 409 por desactualizacion, que se arma a mano
  en el test.
- `PersonalityScore` no tiene indice por `userId`, porque se llega por `resultId`.
  Cuando el matching ordene por rasgo y cross-user, va a hacer falta.
- La escala de los traits depende de cuantas preguntas tenga cada uno. Agregar una
  pregunta cambia el rango de ese trait y hay que anotarlo en §14.2.
- La pantalla del test no recuerda en que pregunta iba, asi que recargar pierde todo
  lo contestado. Como el `POST` es todo o nada, no se puede guardar a medias sin
  cambiar el modelo; queda como estuvo.
- `sembrarTestV1` recibe un cliente de Prisma sin tipo. Se hizo asi para que el
  `.mjs` del seed y los tests puedan importarlo sin tipos cruzados, pero pierde el
  chequeo: un metodo mal escrito en el seed no lo atrapa TypeScript.

---

## 15. Solicitudes y chat: el vertical que cierra el plan

Con la personalidad (§14) y los planes aprobados (§10, §12) ya andando, faltaba la
parte que hace que un plan tenga **gente adentro**: aceptar solicitudes y hablar por
dentro. Esta seccion es la de las dos pantallas.

### 15.1 El gate: el chat no se cierra por status del plan

El chat lo pueden usar `ACCEPTED`, `ATTENDED` y `NO_SHOW`, y **nadie mas**. Lo
unico que queda 403 es "no sos parte del plan": `REQUESTED`, `DECLINED` y
`CANCELLED`.

La parte que no es obvia es que **`ATTENDED` y `NO_SHOW` siguen entrando a
proposito**, y la decision es de producto, no mia. Se habia implementado al
reves (cerrar en cuanto el plan terminaba) y lo que sigue:

1. **Cerrar cuesta mas decision de la que parece.** Obliga a resolver tres cosas
   que este slice no pidio: que pasa con los mensajes ya escritos, si se puede
   leer sin escribir, y que ve el usuario cuando intenta escribir en un chat
   "cerrado". Ninguna tiene respuesta obvia, y todas se resuelven mejor cuando
   el problema exista.
2. **Cerrar cuesta producto, no solo codigo.** Un `NO_SHOW` no es el final de la
   relacion entre esas personas: el organizador quiere poder preguntarle "¿todo
   bien? no llegaste" despues, y quien asiste puede querer coordinar otro
   encuentro con el mismo grupo. Cerrar el canal en el `ATTENDED` corta
   exactamente la continuidad que el producto viene construyendo, que es
   conectar contextos y no solo eventos puntuales.

**Disparador para revisarlo**, en el mismo formato que las otras deudas: cuando
exista `ModerationReport` real, porque un chat que nunca se cierra es superficie
sin limite para reportar; o cuando el volumen de chats abiertos simultaneos se
vuelva un problema de producto, por ejemplo que haga falta archivar.

El gate vive en una constante y una funcion en `lib/chat.ts`
(`CHAT_ABIERTOS_A` y `puedeUsarChat`), no escrito en el endpoint ni en el `.tsx`,
porque es **la misma regla en los dos lados**: el `div` decide que se ve y el API
decide que se puede. Con la condicion duplicada, un cambio de estado se olvida
de uno de los dos y aparece la combinacion que no tiene que existir: ver la caja
de texto y que el POST responda 403. `tests/map/chat-gate.test.ts` (9 tests)
cubre los seis estados, el `null` de quien no participa, y que la lista sea
exactamente la que dice ser.

El endpoint conserva el 404 (y no 403) para quien no tiene fila de
`PlanParticipant`: 403 confirmaria que el plan existe, y esa distincion
filtraria la agenda de planes. La FK compuesta de `Message` no alcanza como
gate, porque se cumple con `CANCELLED` igual: hay un test que inserta el mensaje
**por la base** y despues muestra que la API lo rechaza.

### 15.2 El cursor: opaco, base64url, y sobre `(createdAt, id)`

Paginamos con `?after=<cursor>` y no con `offset`/`limit`. La razon no es de
performance: es que `offset` **se entera de los inserts**. Con dos personas
escribiendo, un `limit 50 offset 100` salta mensajes que todavia no se habian
leido, y el sintoma clasico es "aparecen duplicados y despues faltan cosas".

El cursor es `base64url(JSON de {t: createdAt ISO, i: id})`. Lleva el timestamp
porque un id solo no alcanza para ordenar, y es **opaco** a proposito: en cuanto
un detalle de implementacion pasa a ser parte de la URL, hay que poder cambiarlo
(agregar un `planId` firmado, por ejemplo) sin romper lo que la gente ya guardo.

El desempate por `id` no es cosmetico. `createdAt` es un `datetime(3)`: dos
mensajes en el mismo milisegundo son posibles, y sin desempate el orden de la base
no es total y la paginacion puede devolver dos veces la misma fila. El test lo
mete a proposito: dos mensajes con **el mismo** `createdAt`, y el cursor tiene que
saltar el segundo.

### 15.3 La invariante que casi se rompe: el cursor nunca retrocede

`avanzarCursor(previo, siguiente)` devuelve el **maximo** de los dos, y solo si el
siguiente es un cursor valido. Existe por una clase de bug que es facil de
introducir y muy dificil de ver:

```ts
// lo que se escribe sin pensar, y esta PROHIBIDO
cursor = data.nextCursor
```

Si una respuesta viene con `nextCursor: null` (no hay mas) o con `""` (algo fallo
por el otro lado), esa linea deja el cursor en el piso. El siguiente poll vuelve a
preguntar desde el inicio, el cliente deduplica por id, y **no se ve nada raro**:
lo que se ve es la lista entera recomponiendose cada 3 segundos. Con la suite HTTP
todo verde, porque cada test hace una sola pagina y nunca hace un poll detras de
otro.

Por eso el cliente solo **agrega** mensajes y el cursor se mueve con el helper.
`tests/map/chat-client-state.test.ts` (11 tests) es el que mata esto, y es un test
de funcion pura justamente para no depender de un navegador: "vino una pagina vacia"
y "vino una pagina con repetidos" se escriben en seis lineas cada uno.

### 15.4 Polling de 3 s en el cliente, no WebSockets

`setInterval` de 3000 ms con tres condiciones que no son optimizacion sino
correccion:

- **Con la pestana oculta no se consulta.** `document.hidden` corta el ciclo, y al
  volver a visible se dispara uno. Sin esto, una pestana en segundo plano consulta
  cada 3 segundos para siempre.
- **No hay solapamiento.** Un flag `pollOcupado` evita que un poll lento arranque
  el siguiente. Con dos personas escribiendo, dos polls a la vez se pisan y el
  `orderBy` con el mismo `after` los trae desordenados.
- **Se corta para siempre** con 401, 403 o 404. En los tres casos el estado de la
  participacion cambio, y reintentar cada 3 s no va a devolver la misma respuesta.
  Insistir hasta que la sesion vuelva es peor que mostrar un aviso y parar.

No hay WebSockets en el proyecto. Con un servidor de Node en una sola instancia
habria que sumar un `EventSource`, el estado en memoria por conexion, y la
persistencia de "que leyo cada quien" para reconectar sin perder mensajes. El
cursor ya resuelve la parte dificil (que mensaje me falto) sin nada de eso, y un
poll vacio cada 3 segundos es despreciable a la escala de un plan con cupos de 2 a
8 personas.

### 15.5 Sin escritura optimista, y deduplicando por `id`

El POST no mete la burbuja antes de la respuesta. Con escritura optimista, si el
POST devuelve 403, 409 o 500, en pantalla queda un mensaje que **nunca existio**, y
el usuario ya lo leyo. Se manda, se espera la respuesta real y se agrega lo que
vuelve. Cuesta una ida y vuelta de red y a cambio nunca hay que desmentir a la
pantalla.

La deduplicacion por `id` sigue haciendo falta por el otro lado: el poll puede
devolver un mensaje que el POST ya trajo, y sin filtrar aparece duplicado.

### 15.6 El bug que casi se va: `authorId` no es `User`

`Message.authorId` referencia **`PlanParticipant`**, no `User`: la FK compuesta
`(planId, authorId)` es la que garantiza que solo participantes escriben (§2.5 de
`docs/modelo-datos.md`). El primer `select` del endpoint pedia `author: { name }`
como si la relacion existiera, y **Prisma no se quejaba en typecheck**, porque el
`select` pasaba por un `as`. El error aparecia en runtime, con un 500 en el chat.

Se corrigio con `Prisma.validator<Prisma.MessageSelect>()`, que obliga a que el
`select` sea del tipo que Prisma genero. La regla que queda: **un `select` de
Prisma nunca se escribe sin el validador**, porque el typecheck es la unica barrera
antes de produccion.

Lo que si quedo bien: el `mine` de cada mensaje se calcula en el servidor contra la
participacion de la sesion, y el cliente **no decide que es suyo**. Si esa
comparacion viviera en el cliente, bastaria editar el DOM para ver los mensajes
ajenos alineados como propios, y "quien lo escribio" es justo el dato que no se
le puede pedir al navegador.

### 15.7 El scroll: pegado al fondo o no se toca

La lista hace auto-scroll al agregar mensajes **solo si el usuario ya estaba cerca
del fondo** (`pegadoRef`, medido en el `onScroll`, con 80 px de tolerancia). Si
alguien esta leyendo el historial y le llega un mensaje, la pantalla no se le
dispara bajo los ojos. No hay indicador de "hay mensajes nuevos": quedo para
despues (§15.10).

Los mensajes con `deletedAt` muestran la fila pero **no el cuerpo**: el borrado
logico existe para no destruir evidencia, asi que el `id` y el orden se conservan y
el texto deja de poder leerse. Editar y borrar **no** estan implementados, a
proposito: son otra pantalla y otra tanda de permisos.

### 15.8 `/host/requests`: la URL es la verdad

La pantalla del organizador lista las solicitudes de **todos** sus planes, con
selector. Tres cosas se corrigieron probando en Edge:

- El plan seleccionado vive en `?plan=`, no en un `useState` que se resetea al
  recargar. Sincronizar los dos con un `useEffect` se puede desincronizar en el
  primer render; la URL no.
- El componente se remonta con `key={planId}`. **Sin** eso, el click de `<Link>` en
  la tabla no cambiaba nada: la misma instancia de React reutilizada con props
  nuevas no vuelve a correr el efecto de carga. Es el bug mas tonto de los tres, y
  solo se ve en el navegador.
- Los errores de la lista de planes y los de las solicitudes van **separados**.
  Con un solo `error`, un fallo al cargar los planes tapaba el mensaje real de "no
  se pudieron cargar las solicitudes" de la columna que estabas mirando.

### 15.9 La pasada manual en Edge, y los dos tests que mentian

No hay Playwright en el proyecto, asi que la verificacion real se hizo con **dos
perfiles de Edge por CDP**: `scripts/manual-chat-flow.mjs` siembra host,
postulante, plan, solicitud pendiente y mensaje semilla, e imprime las cookies y
el `planId`. Dos perfiles porque las sesiones van en cookies: con un solo perfil
las dos pestanas serian la misma persona y el chat no tendria dos lados.

Lo verificado, en orden: el postulante `REQUESTED` **no** ve chat; el organizador
ve la solicitud y la acepta; la fila sale de la lista de pendientes y el chat
aparece para los dos; el mensaje propio sale a la derecha y el ajeno a la
izquierda con el nombre del autor; el contador baja de 1000 al escribir; un
mensaje del otro lado aparece **sin recargar** (el contador de navegaciones se
queda en 1, o sea que fue el poll y no un reload); la lista scrolleada arriba **no**
salta, y estando abajo **si**.

**Dos de esas comprobaciones fallaron, y el bug era del comprobador, no del
producto.** Se anotan porque es la parte que casi se pasa por alto:

1. "La fila del postulante sigue en pantalla" daba `true` siempre, porque buscaba
   el nombre en el `innerText` y el nombre tambien esta en el texto de
   confirmacion "Aceptaste a ...". La forma correcta es contar filas de la seccion
   de pendientes y cruzarlo con la API: `filas: 0` y `pendientes: 0`.
2. "La lista no salta al fondo" daba `false`, y el producto estaba bien. Con tres
   mensajes la lista desbordaba **6 px** sobre un alto fijo de 350: el usuario
   estaba *de verdad* al fondo, asi que el auto-scroll era la conducta correcta y
   el test no probaba nada. Se arreglo mandando 18 mensajes de relleno para que
   desborde, y se agrego el caso positivo: al fondo, el mensaje nuevo **si** trae
   la lista.

Ese par es el argumento de por que el paso manual no es opcional: los dos checks
"verde/rojo" estaban comprobando cosas que no eran las que decian.

### 15.10 Lo que NO esta cubierto, y la deuda que queda

- El chat carga **50 paginas de 100** en el montaje y despues sondea. Con mas de
  5000 mensajes, el mas viejo no aparece nunca. Es un tope de seguridad deliberado
  y **no esta avisado en pantalla**: si un plan llega a eso, el usuario no se
  entera de que le falta historial.
- Si una pagina falla a mitad de la carga inicial, **se descarta lo ya leido**: el
  `return` temprano del error se lleva por delante las paginas que si salieron
  bien y el usuario ve el chat vacio. El poll siguiente lo arregla solo en 3 s, asi que es
  un parpadeo, no una perdida de datos.
- **No hay boton de reintentar.** Con el error en pantalla, el polling sigue
  corriendo y el error desaparece en el proximo exito, asi que la recuperacion es
  invisible. Cuando se escribio esto, la pantalla ademas decía "Todavia no hay
  mensajes. Presenta vos." debajo del error, o sea que le pedia escribir el primer
  mensaje de un plan que puede tener miles. Eso se corrigio: el estado vacio no se
  muestra si hay error.
- El chat no se cierra automaticamente por status del plan, asi que **un plan
  terminado acumula toda su conversacion abierta para siempre**. Se acepta con el
  disparador de §15.1 (`ModerationReport` real, o volumen de chats abiertos).
- La pantalla de "unirse" le decia "Esta completo. Igual podes pedir..." a un
  `ATTENDED` y a un `NO_SHOW`, que tres renglones mas arriba ya habian leido "Ya
  estuviste en este plan". Dos lineas contradictorias por un `yaEsta !== 'ACCEPTED'`
  que queria decir "no confirmed". Ahora el renglon es `yaEsta === null`, que es el
  unico caso en que es cierto.
- Cualquier `ACCEPTED`, `ATTENDED` o `NO_SHOW` ve la conversacion entera del plan.
  Que el nombre del autor se vea a la izquierda es correcto, pero **la privacidad
  de "quien estuvo aqui" no se decidio aca**: no hay tabla de bloqueos ni chat
  privado. Con el gate abierto al plan terminado, el renglon es mas sensible que
  cuando solo lo veian los confirmados. Es la decision que mas conviene revisar
  antes de que haya volumen.
- El paso 8 tardo 2591 ms. El poll es de 3 s, asi que la latencia de un mensaje es
  de 0 a 3 s: 2591 ms es el caso malo del intervalo, no la media. No se midio la
  distribucion porque **el cliente, no el servidor, decide cuando pregunta**.
- No hay cobertura de dos pestanas del mismo participante, ni de la misma persona
  en dos dispositivos, ni del caso "el otro borra un mensaje mientras yo miro".
- Editar, borrar, el indicador de mensajes nuevos y "ir al mensaje nuevo" van
  juntos: son los momentos en que la lista **se mueve sola** mientras alguien la
  esta leyendo, y el que ya se resolvio (el auto-scroll condicional) es la base de
  los otros tres.

Suite completa: **35 archivos, 633 tests**.

De §15: 40 de `chat.test.ts` (gate, orden total, cursor, 403, no-store,
same-origin), 14 de `chat-cursor.test.ts`, 11 de `chat-client-state.test.ts`, 9 de
`chat-gate.test.ts`, 12 de `host-requests-page.test.ts`, 22 de
`plan-detail-page.test.ts`.

De §16: 18 de `attendance.test.ts`, 23 de `ratings.test.ts`, 12 de
`plan-detail-closing.test.ts`, 8 de `attendance.test.ts` (regla pura), 21 de
`ratings.test.ts` (regla pura), 17 de `plan-finished.test.ts`.

---

## 16. Cerrar el plan: asistencia y calificacion

### 16.1 El productor que faltaba

`ATTENDED` y `NO_SHOW` se leian en tres lugares — la reliability que se le muestra
al organizador al aprobar (§5.9 de `docs/modelo-datos.md`), el gate del chat
(§15.1) y la ventana de calificacion — y **nada en el proyecto los escribia**. Eso
no era un bug de los tres lectores: era un feature entero construido sobre datos
que no existen. La reliability devolvia "Sin historial" para todo el mundo, para
siempre, y los tests lo pasaban igual porque sembraban los estados a mano por SQL
crudo.

Un test puede probar que la query esta bien. No puede probar que algo produzca la
fila que la query resume. Por eso el primer test de `attendance.test.ts` **no mira
la respuesta**: relee el estado con `rawQuery` — un `SELECT` crudo sobre
`"PlanParticipant"`, sin pasar por la API que se esta probando — y si eso falla, el
endpoint esta mintiendo. Y el de ratings hace el circuito entero: parte de
`ACCEPTED`, verifica que el voto da 403, marca la asistencia por el endpoint de
asistencia y recien ahi el voto entra. Ese 403 sin salida era el bug.

### 16.2 "Termino" sale del reloj, no de un estado que nadie pone

`Plan.status` tiene `COMPLETED` y **nadie lo escribe**, igual que `ATTENDED` y
`NO_SHOW` antes de §16. Construir la ventana de calificacion sobre un estado sin
productor es construir algo inalcanzable, asi que la regla se deriva de la hora:
`endsAt ?? startsAt <= ahora`. No hace falta que nadie marque nada; se cumple sola
cuando pasa el tiempo, que es lo que un calendario deberia hacer.

Se separa en dos funciones porque son dos preguntas. `planTermino` es "ya
pasaron las horas". `planCerrable` es "termino **y** no fue cancelado": un plan
`CANCELLED` paso por su hora de fin como cualquier otro, pero no hubo evento, asi
que no hay a quien marcar ni experiencia que calificar. Sin esa distincion, un
plan cancelado abre la calificacion y el organizador termina aceptando dibujos de
un evento que no existio.

`porQueNoSeCierra` va aparte del booleano a proposito: si `planCerrable`
devolviera "porque no", el que llama tendria que volver a preguntar para poder
escribir el mensaje, y el texto se desincroniza del booleano en cuanto uno de los
dos cambia. Con esto, el render y el endpoint dicen lo mismo porque usan la misma
funcion.

Cuando exista el job que marque `COMPLETED`, esta funcion se apoya en el estado
**ademas** de la hora, nunca en vez de la hora.

### 16.3 Marcar asistencia

- **Solo el organizador**, y con el plan cerrable. La seccion aparece con las
  mismas dos funciones del endpoint, no con un `=== 'ORGANIZER'` y un `>`.
- **Idempotente.** Remarcar lo mismo responde `{ cambio: false }` y no falla: la
  pantalla no recarga y un doble clic no es un error.
- **No toca `acceptedCount`.** Marcar asistencia no libera ni ocupa lugar: un
  `ATTENDED` y un `NO_SHOW` ocupan un lugar igual que un `ACCEPTED`. Tocar el
  contador aca daria dos fuentes de verdad para el cupo, que hoy sostiene entero
  el endpoint de solicitudes.
- **No se vuelve a `ACCEPTED`.** El schema de la asistencia solo admite
  `ATTENDED` y `NO_SHOW`. Volver a `ACCEPTED` seria decir "no se", que el modelo
  no tiene como representar, y ademas sacaria a la persona del numerador **y** del
  denominador de la reliability de un plumazo. Entre los dos valores si se puede
  corregir, porque una lista de asistencia se arma a ojo.
- **El organizador se marca a si mismo.** Su fila de `PlanParticipant` es tan
  participante como la de cualquiera y organizando tambien se asiste. Sin esto, la
  lista que el propio organizador esta completando lo dejaria en `ACCEPTED` para
  siempre.
- **Lo escribe una persona, no un job.** La lista de quien estuvo la sabe el
  organizador: nadie vio quien entro por la puerta. Un job que pusiera `NO_SHOW` a
  quien no se presento seria una calumnia automatizada. Lo que si se puede
  automatizar es *ofrecer* la pantalla, y eso lo decide la hora.

La lista de marcables vive en `lib/attendance.ts` y la usan **el endpoint y la
pantalla**, por la misma razon que `CHAT_ABIERTOS_A` en §15.1: si cada uno tiene
la suya, un estado nuevo entra por un lado y no por el otro, y aparece la
combinacion que no tiene que existir. `resumenAsistencia` responde "falta algo" con
los `ACCEPTED` que quedan, y no con "los que no tienen boton prendido": el boton
queda prendido justamente para poder corregir.

### 16.4 La calificacion es de la experiencia, no de las personas

`Rating` no tiene `ratedUserId` y no hay forma de calificar a otro participante.
La UI no ofrece ni insinua hacerlo: una calificacion publica y permanente entre
personas seria exactamente el juicio social que el producto existe para eliminar.
El `ratingSchema` es `.strict()`, asi que mandar `ratedUserId` es un 400 y no un
campo ignorado.

**El gate tiene dos partes y no es el del chat.** Se requiere `ATTENDED` y plan
cerrable. Un `ACCEPTED` todavia no tiene una experiencia terminada que juzgar, y un
`NO_SHOW` no puede calificar la de otros aunque siga teniendo chat (§15.1): el
chat es un canal y calificar es un juicio con peso reputacional. Que sean gates
distintos es la decision, y por eso cada uno tiene su funcion. Los dos estan
fijados por tests que prueban los tres casos.

**La escala no se coercea.** A diferencia de las fechas y el cupo, que llegan de
un `<input>` y por eso usan `z.coerce`, las estrellas llegan de un click. Con
`z.coerce.number()`, `true` se guardaba como una estrella (`Number(true) === 1`) y
un array `[5]` como cinco. Un endpoint que acepta cualquier cosa convertible a
numero no esta validando: esta adivinando.

### 16.5 Editar no tiene limite, y es un upsert

`@@unique([planId, authorId])` y `updatedAt` ya estan en el schema, asi que
corregir es escribir encima. El `POST` es un `upsert` y no un `find` + `create`:
entre el find y el create, dos toques del mismo boton crean dos filas y el
`unique` hace que el segundo reviente con un 500 en vez de editar.

No hay ventana de cierre. Nadie deberia quedar atrapado con lo que escribio, y
para una audiencia con ansiedad social la correccion sin friccion es el piso, no
el extra. Un voto por persona y plan, ademas, hace que el promedio no se pueda
inflar. La respuesta distingue `201` (creo) de `200` (corrigio), y la pantalla usa
eso para decir "gracias" o "actualizada" — no puede deducirlo de su propio estado,
porque la recarga en silencio llega antes de que se pinte el exito.

### 16.6 El promedio es anonimo; la lista con nombres es del organizador

`GET /api/plans/[planId]` publica tres niveles de detalle:

| | todos | organizador |
| --- | --- | --- |
| `count` y `average` | si | si |
| `tags` (conteo agregado) | si | si |
| `mine` (estrellas y etiquetas) | el suyo | el suyo |
| `detail` (nombre y etiquetas) | **null** | si |

El promedio es de todos a proposito: es la senal de si el lugar valio la pena sin
exponer quien opto por que, y sin el la unica forma de enterarse seria abrir otro
plan. El conteo de etiquetas (`tags`) es anonimo por la misma razon y con el mismo
alcance: es el mismo dato agregado, descompuesto. Un set cerrado de ocho valores no
puede revelar a nadie —no hay nada secreto en "faltaron espacios"— y mostrarlo es lo
que hace que las etiquetas sirvan como senal en vez de quedar encerradas en la
pantalla del organizador. Lo privado es la **atribucion**, no el contenido, y por eso
la atribucion vive en un solo lugar de la respuesta: `detail`, que es `null` para
todos menos el organizador.

`average` es `null` y no `0` cuando no hay votos: cero estrellas es una
opinion, "todavia no califico nadie" no lo es. `detail` es `[]` y no `null` para
el organizador, porque `null` significa "no te toca ver la lista" y `[]` significa
"la podes ver y no hay nada".

El promedio se calcula en el servidor y se manda. El cliente **no tiene los votos**,
solo el promedio y el conteo, asi que recalcularlo en pantalla con un voto de los
dos que hay seria ver un numero distinto del que quedo. Por eso el copy vive en
`textoDelPromedioConCuenta(promedio, count)` y no en el componente.

### 16.7 Traer no es publicar

El endpoint trae el estado de los tres que tuvieron o tienen lugar, y el
`NO_SHOW` **desaparece de la lista entera** para quien no organiza. No solo se le
oculta el `status`: la persona no esta. Con el status en `null` pero la fila
presente, el nombre igual queda en el JSON y el boton se puede pintar.

El filtro va en la respuesta y no en el `where` de la query porque depende de si el
viewer organiza, y eso no se sabe hasta que la misma query devuelve el `creator`.
Se podria con dos consultas; se hace con una y un `map`, y el borrado queda en un
solo lugar visible. Tambien se saca de la lista a quien no organiza su **propio**
estado duplicado: eso sale de `viewer.participation`, que ya lo tiene.

### 16.8 La pasada manual, y los dos bugs que encontro

`scripts/manual-closing-flow.mjs` siembra un plan **ya terminado** (un instante
relativo en el pasado, no "hoy a las 20": cerca de medianoche el plan se cerraria
solo y el manual dejaria de probar el gate) con los cuatro participantes en
`ACCEPTED`. Con tres perfiles de Edge: el organizador marca, el que no vino ve la
pantalla de un `NO_SHOW`, y quien asistio califica.

La primera corrida salio en rojo, y de todo lo que fallo **solo dos cosas eran de
producto**:

- **El formulario se le veia al `NO_SHOW`.** La primera version montaba
  `RatingSection` para todo el mundo con el plan cerrable y ponia el "no podes
  calificar" en *otra* seccion al lado. El `NO_SHOW` tenia las cinco estrellas y
  un boton que respondia 403: exactamente la combinacion que los comentarios de
  este archivo dicen que no tiene que existir, y que aparecio porque el gate
  estaba en el padre y no en el componente. Ahora el formulario y el motivo de que
  no este son la misma rama del mismo ternario.
- **El mensaje de exito era incorrecto la primera vez.** Decia "actualizada" porque
  la recarga en silencio ya habia traido el voto nuevo, asi que el componente no
  podia distinguir "acabo de crear" de "acabo de corregir". Lo dice el `creado` del
  POST, que es el unico que sabe.

El resto eran del driver, y son la mitad de lo instructive:

- Un nombre mal escrito: el check buscaba `Cairo Sin Marcar` y el seed crea
  `Ciro Sin Marcar`. El check fallaba y el producto estaba bien.
- El filtro de ruido no podia ver la URL del favicon. `Log.entryAdded` trae el
  `url` por separado del `text`, y el texto de un 404 es "Failed to load
  resource: the server responded with a status of 404": no dice "favicon" en
  ningun lado. Sin el `url` en el mensaje, el filtro no puede descartarlo y el
  resumen dice "sin errores de consola" sobre un error que esta ahi.
- Un check que exigia que el `NO_SHOW` hiciera al menos un POST. Eso premia el bug
  contrario: lo que tiene que demostrar ese perfil es que **no** toca nada. Se
  cambio por un rango esperado de 0.

Y una falla mas que no era un bug sino una mentira del fixture: `acceptedCount: 0`
al lado de una lista de cuatro personas, porque el seed se saltea el endpoint de
solicitudes, que es el que lo sube. La pasada manual mostraba "0 de 6 lugares
tomados" con cuatro nombres abajo, y el revisor leia un bug donde no lo habia.

### 16.9 Lo que NO esta cubierto, y la deuda

- **El formulario no tiene cobertura automatica.** El harness no tiene DOM, asi que
  el gate de la UI lo cubrio la pasada manual, no un test. Lo que si esta fijado por
  tests es la parte que se puede: `puedeCalificar`, `planCerrable` y todo lo que
  hace el endpoint. Un `data-testid` por seccion y un test de render los dejaria
  cubiertos, y es la deuda mas chica de esta lista.
- **Marcar no es transaccional con la lista.** Se actualiza una fila por POST. Con
  dos pestanas del organizador abiertas, la ultima que responde gana: no hay
  version ni `updatedAt` en `PlanParticipant` que lo detecte. Para una lista que se
  arma a mano el riesgo es bajo, pero existe.
- **No hay forma de deshacer una marcacion equivocada.** Solo se corrige de un
  estado al otro. Volver a `ACCEPTED` esta descartado a proposito (§16.3), asi que
  "marque a alguien que si vino como no vino" se corrige, pero "marque a alguien
  que no vino como que vino" se corrige eligiendo bien la segunda vez y no
  borrando.
- **La calificacion se muestra anonima, pero el sesgo de quien califica es real.**
  El gate es `ATTENDED`, asi que solo quien estuvo califica, y los votos no se
  pueden pseudonymizar ni multiplear. Con un plan chico, un unico voto es un dato
  casi identificable para quien estuvo ahi. Averiguar si hace falta agrupar o un
  minimo de votos es pregunta de producto, no de codigo. Nota: el conteo de
  etiquetas agrega un poco mas de superficie que el promedio, porque con un plan de
  una persona "1 · Volveria" es un poco mas especifico que "5 de 5, de 1 persona".
  Sigue sin atribucion —que es lo unico que §16.6 promete— pero es el punto que
  habria que revisar si esto crece.
- **Ya no hay texto libre con nombre de persona.** Esto era la deuda mas urgente de
  §16 y se cerro en §16.10: `Rating.comment` se elimino y en su lugar hay un set
  cerrado de ocho etiquetas, con un maximo de tres por voto. No queda ningun campo
  de texto libre en `Rating`, asi que no hay moderacion que construir, ni reporte,
  ni ocultamiento, ni caminos de borrado. Si alguna vez vuelve a haberlo, esa
  deuda vuelve con el.
- El promedio del **lugar**, agregado a traves de los planes, es lo que quiere
  §5.9 y es otro corte: necesita decidir la ponderacion entre planes de 2 y de 20
  personas, y si un plan de una persona vale igual.
- **Las etiquetas no se pueden corregir sin perder el voto entero.** Como el voto es
  un `upsert` de una fila, cambiar una etiqueta manda el set completo de nuevo. Es
  coherente con la calificacion (que tampoco se pondera), pero significa que no hay
  forma de agregar "Volveria" a un voto de hace seis meses sin cambiar el resto, y
  que el "conteo" de una etiqueta mezcla votos recientes con votos de hace meses.

### 16.10 El comentario libre no se ratifica: se reemplaza por etiquetas cerradas

Este es el cierre de la deuda mas urgente de §16, y la decision es **no**: el
comentario libre de 500 caracteres no entra. Se sustituye por un set cerrado de
ocho etiquetas, hasta tres por voto.

La razon es que el problema del texto libre no era el moderacion pendiente, era el
campo mismo. `comment` era el unico texto libre con nombre de persona que quedaba
en la base, y sus propiedades eran las que lo hacian peligroso: era arbitrario, asi
que ahi iba el nombre de quien organizo, el chiste interno, o el juicio; era
pseudonimo, asi que se podia atribuir a cualquiera; y era permanente, asi que no
habia forma de deshacerlo. Un moderador llega tarde a las tres. Lo unico que
arregla las tres es no aceptar el campo, y por eso se elimino en vez de
agregarle un flag de moderacion.

La alternativa que se considero y se rechazo fue `hidden`: publicar el texto igual y
ocultarlo en la vista del organizador. Se descarto por dos razones concretas, no
por principio. Es reactivo: esconder es una accion reversible por cualquiera que
tenga la sesion del organizador, y "el moderador lo ve, el publico no" no es lo
mismo que "no existe". Y si el oculto se saca del promedio, el filtro pasa a ser
una palanca para curar la puntuacion, que es un problema peor que el que resolvia.

**El set cerrado.** Las ocho etiquetas son las que se pueden marcar:

| id | se muestra como |
| --- | --- |
| `buena_ubicacion` | Buena ubicacion |
| `ambiente_relajado` | Ambiente relajado |
| `buena_comida` | Buena comida |
| `facil_llegar` | Facil llegar |
| `grupo_chico` | Grupo chico |
| `vale_la_pena` | Vale la pena |
| `volveria` | Volveria |
| `faltaron_espacios` | Faltaron espacios |

El limite de tres es por la misma razon que el de ocho: el objetivo es que la
persona pueda señalar la experiencia sin escribir sobre nadie. Con ocho, las
opciones dicen algo del lugar. Con veinte, el conjunto empieza a ser un formulario
y el que tiene algo que decir empieza a buscar la casilla que lo diga de la forma
mas incriminatoria. Tres es el punto donde "comida buena y volveria" se escribe
antes de que la persona piense en como lo escribiria.

**La validacion vive en el borde del servidor**, no en la UI. `ratingSchema` es un
`z.enum` sobre los ocho ids, con `.max(3)` y sin duplicados, y el objeto es
`.strict()`: mandar `comment` es un 400, no un campo ignorado. Ignorarlo seria
peor que rechazarlo, porque un cliente viejo creeria que guardo lo que mando. Las
etiquetas que no se reconocen tambien son 400, y por el mismo motivo: un id
inventado es un dato que no se puede mostrar y no se puede contar.

**La escala es 1 a 5, ratificada.** No hay `0`: `0` significa "sin voto" y se
expresa con `null` en `rating`, no con un numero. Un cero guardado seria
indistinguible de una calificacion real y contaminaria el promedio, asi que el
`null` no es una comodidad del tipo, es la unica forma de que "todavia no voto" y
"voto cero" sean dos cosas distintas. Los ids de las etiquetas no llevan acento a
proposito: son claves de un enum validado en el servidor, no texto para el usuario,
y el texto con acento se arma en el momento de mostrar.

**Lo que se publico y lo que no.** El conteo agregado (`ratings.tags`) es visible
para cualquiera que abra el plan, igual que el promedio, y por el mismo motivo de
§16.6. Las etiquetas individuales con nombre (`ratings.detail`) son solo del
organizador. La atribucion no se duplico: sigue habiendo un unico lugar en la
respuesta donde un tag convive con un nombre de persona.

**Lo que se pierde.** Una persona ya no puede explicar por que le molesto el plan,
ni contar un detalle que no entra en ocho casillas, y el organizador no recibe ese
matiz. Se acepta: el `average` mas el conteo ya dan la señal, y el matiz no
compensaba el riesgo de que quedara escrito. Si alguna vez hace falta, la forma de
hacerlo es agregar dimensiones, no devolver el campo: "comida", "ambiente",
"logistica" como ejes separados, que se pueden publicar sin texto y comparar entre
planes.
