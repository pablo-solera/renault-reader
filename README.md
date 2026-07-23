# Renault Reader

API Bun + Express para generar exportaciones Labour Times (`TM01`) de ASMDOR y almacenar el ZIP en S3/MinIO.

## Requisitos

- Bun 1.3+
- Redis 7+
- S3 compatible, o MinIO local

## Arranque local

```powershell
Copy-Item .env.example .env
docker compose up -d redis minio
```

`CREDENTIAL_ENCRYPTION_KEY` es una clave local AES-256 usada para cifrar temporalmente
las contraseñas antes de guardarlas en Redis. Debe ser Base64 de exactamente 32 bytes.
Genérala así y añádela al `.env`:

```powershell
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$env:CREDENTIAL_ENCRYPTION_KEY = [Convert]::ToBase64String($bytes)
bun install
bun run start
```

La misma clave debe estar disponible para la API y el worker. No la cambies mientras
haya jobs pendientes y no la subas al repositorio.

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
  "email": "usuario@example.com",
  "password": "...",
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
  "email": "usuario@example.com",
  "password": "...",
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
