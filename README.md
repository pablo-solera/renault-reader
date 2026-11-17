# Renault Reader

Reader de Renault Group (ASMDOR): descubre qué puede extraer la cuenta, pide los exports a ASMDOR, los descarga y los guarda
**sin transformar** en un S3 compatible, con un manifiesto v2 que se escribe el último. Toda la transformación (reglas de Access,
Acciona SQL, Excel, comparaciones) vive en `renault-transformer`.

Sigue la misma estructura que `mercedes-reader` y usa `@pablosla/core-reader` (contrato HTTP v1, routers, errores, Redis,
worker único, BullMQ, S3).

## Requisitos

- Bun 1.4+
- Redis 7+ (compartido con el resto de readers; todas las claves llevan el prefijo `renault-reader`)
- Un bucket S3 compatible

## Arranque local

```powershell
Copy-Item .env.example .env
docker compose up -d redis
bun install
bun run start     # API
bun run worker    # worker (otra terminal)
```

Las credenciales de Renault se configuran **solo** en `.env`: `RENAULT_EMAIL`, `RENAULT_PASSWORD` y `GIGYA_API_KEY`. No se aceptan en
las peticiones HTTP, no se guardan en Redis y no se escriben en logs. Las credenciales del Access original están expuestas: hay que rotarlas.

La API escucha en `127.0.0.1:3000` y no tiene autenticación propia: no la expongas fuera de una red de confianza.
Documentación: `GET /docs` (Swagger) y `GET /openapi.json`. El worker no arranca si ya hay otro activo (lock singleton con heartbeat).

## API v1

Rutas de sistema: `/health`, `/ready`, `/openapi.json`, `/docs`. Los errores siguen el contrato: `{ "error": { "code", "message", "details" } }`.

| Ruta | Descripción |
|---|---|
| `GET /v1/info` | Reader, versión, fabricantes (`RENAULT_MANUFACTURERS`) y capacidades |
| `GET /v1/models/options` | Familias autorizadas, formatos e idiomas. Filtros: `range` (`active`, `old`, `future`), `exportType` (`TM01` por defecto o un código de Parts), `manufacturer`, `includeRaw` |
| `POST /v1/labours` | Un export TM01 |
| `POST /v1/parts` | Extracción de un modelo (antiguo `POST /models`) |
| `GET /v1/{labours,parts}` | Listado con cursor y filtros (`status`, `manufacturer`, `axCode`, `edition`) |
| `GET /v1/{recurso}/{id}` | Estado, unidades y artifacts |
| `GET /v1/{recurso}/{id}/download` | 307 a una URL firmada; `?artifact=nombre`. En labours el export es el artifact principal |
| `POST /v1/{recurso}/{id}/cancel` | Cancela (200) o pide parar (202) |
| `POST /v1/{recurso}/{id}/resume` | Reanuda desde la primera unidad incompleta (`{ "force": true }` salta la comprobación de heartbeat) |

Las rutas sin versión (`/labours`, `/parts`, `/models`, `/labours/options`, `/parts/options`) se retiraron sin alias.

### Labours

```json
{ "manufacturer": "RENAULT", "language": "en", "selection": { "family": "X1310", "format": "json.zip", "range": "active", "publishedAfter": "2026-05-01" } }
```

Usa `GET /v1/models/options` para obtener familias, formatos e idiomas autorizados; cada familia trae su `selection` lista para usar.

### Parts

```json
{
  "manufacturer": "DACIA", "axCode": "5208", "edition": "02/0", "language": "en",
  "selection": { "description": "Bigster (SVA)", "family": "X1310", "modelIds": ["MODEL-0013"], "range": "active",
                 "exports": { "REF01": true, "REF02": true, "REF03": true, "PR05": true, "PR06": true, "PR08": true, "PR03": true } }
}
```

Extrae `REF04` y `REF05` (siempre), los exports opcionales activados (todos por defecto) y después `PR08` y `PR03` por cada familia
derivada de los modelos elegidos. `axCode` tiene 3 o 4 caracteres y `edition` el formato `NN/N`.
La antigua exportación suelta (`POST /parts` con `exportType`) se sustituye por `exports` y la comparación entre ediciones, el
informe TAPV y la carga en Acciona pasan a `renault-transformer`.

## Salida en S3

```text
RENAULT/{fabricante}/labour/{familia}/{YYYYMMDD}/{unidad}/{archivo original} + {unidad}_completed.json
RENAULT/{fabricante}/parts/{axCode}_{descripción}_{familia}/{edición}/{YYYYMMDD}/{unidad}/...
```

Detalle de unidades, ficheros y manifiesto en [`docs/s3-layout.md`](docs/s3-layout.md). Una unidad con manifiesto no se vuelve a pedir
a Renault; por eso reanudar o repetir una petición del mismo día es barato. Cancelar no borra nada.

## Redis

| Clave o cola | Contenido |
|---|---|
| `renault-reader:request:{id}` | Estado de cada petición (labours y parts) |
| `renault-reader:{labours,parts}:index` | Índice paginado por recurso |
| `renault-reader:scope-lock:{hash}` | Una petición por carpeta de S3 |
| `renault-reader:request:{id}:cancel` / `:heartbeat` | Bandera de cancelación y latido del job |
| `bull:renault-extractions:*` | Cola de BullMQ: un job es una unidad |

Las peticiones y colas anteriores (`renault-reader:job:*`, `renault-labours`, `renault-parts`, `renault-models`) no se migran.

## Configuración

Ver `.env.example`. Valores que conservan la semántica anterior: `POLL_INTERVAL_MS` (30 s entre consultas al History),
`JOB_TIMEOUT_MS` (24 h de espera máxima), `JOB_CONCURRENCY`. `RENAULT_TOKEN_TTL_SECONDS` indica cuánto se reutiliza el token
de ASMDOR (no informa su caducidad); un 401 lo renueva antes.

## Docker

```powershell
docker compose up --build
```

`api` y `worker` comparten imagen; el worker tiene healthcheck propio y `stop_grace_period` de 90 s.

## Verificación

```powershell
bun test                  # unitarios y HTTP (fakes, sin Redis ni S3)
bun run typecheck
bun run test:integration  # Redis y RustFS en Docker (puertos 46379 y 49000) contra un ASMDOR simulado
```

Los tests no usan credenciales ni llaman a Renault.
