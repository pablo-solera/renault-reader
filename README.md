# Renault Reader

API Bun + Express para generar exportaciones Labour Times (`TM01`) de ASMDOR y almacenar el ZIP en S3 compatible.

## Requisitos

- Bun 1.3+
- Redis 7+
- Un bucket S3 compatible ya creado

## Arranque local

```powershell
Copy-Item .env.example .env
docker compose up -d redis
```

Configura en `.env` el endpoint, bucket, región y credenciales de S3. El bucket debe
existir previamente y `S3_AUTO_CREATE_BUCKET=false` evita que un error de permisos se
interprete como permiso para crearlo.

Las exportaciones Renault se almacenan en:

```text
s3://<S3_BUCKET>/<S3_LABOURS_PREFIX>/renault_<requestId>_<fileName>
```

El prefijo por defecto es `RENAULT_GROUP/files_datasource/RENAULT/Labour_Time`.

La variable del secreto se llama `S3_SECRET_ACCESS_KEY`. Si aparece `SignatureDoesNotMatch`,
comprueba que la access key y el secreto pertenecen al mismo par, que no incluyen comillas
ni espacios, y que la política permite acceder a `S3_BUCKET`. Rota cualquier secreto que
haya sido compartido por chat o capturas.

Las credenciales Renault se configuran exclusivamente en `.env` mediante
`RENAULT_EMAIL` y `RENAULT_PASSWORD`. No se aceptan en las peticiones HTTP ni se
guardan en Redis. La API y el worker deben usar el mismo entorno.
Si una petición incluye `email` o `password`, se rechaza con `400`.

```powershell
bun install
bun run start
```

En otra terminal, arranca el worker:

```powershell
bun run worker
```

La API escucha en `127.0.0.1:3000` y no tiene autenticación propia por decisión del MVP. No la expongas fuera de una red confiable.

Documentación Swagger:

- UI: `http://127.0.0.1:3000/docs`
- OpenAPI JSON: `http://127.0.0.1:3000/openapi.json`

## API

Descubrir opciones reales autorizadas:

```http
POST /labours/options
Content-Type: application/json
```

```json
{
  "range": "active"
}
```

Crear un job:

```http
POST /labours
Content-Type: application/json
```

```json
{
  "family": "<family.value>",
  "format": "_json.zip",
  "language": "en",
  "range": "active",
  "publishedAfter": "2026-05-01"
}
```

La respuesta es `202` con `requestId`. Consulta `GET /labours/:requestId`. Cuando el estado sea `completed`, descarga mediante `GET /labours/:requestId/download`.

`POST /parts` devuelve `501` hasta implementar ese flujo.

## Verificación

```powershell
bun test
bun run typecheck
```

Los tests no usan credenciales ni llaman a Renault.
