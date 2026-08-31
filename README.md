# Renault Reader

API Bun + Express para generar exportaciones de ASMDOR y almacenarlas en S3 compatible.

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

### Parts

Los códigos soportados son `REF01`, `REF02`, `REF03`, `REF04`, `REF05`, `PR03`, `PR05`, `PR06` y `PR08`.
Consulta `POST /parts/options` con `{ "exportType": "PR08", "range": "active" }` y después crea el job con `POST /parts`.
`format` y `language` son opcionales cuando el export no los requiere. `axCode`, `epc` y `manufacturer` se conservan como contexto del proceso. Para `REF05`, `previousRequestId` genera las hojas `New` y `Deleted` del Excel TAPV. Los archivos se almacenan bajo `S3_PARTS_PREFIX/{exportType}/` y el reporte final bajo `reports/`.

En `REF04`, `modelIds` permite replicar la selección de modelos del Access. Si no se indica `epc`, se genera automáticamente como `MMYY`. El mapeo código/descripción de fabricante se configura con `RENAULT_MANUFACTURER_DESCRIPTIONS` en formato JSON.

Además del archivo original, el worker guarda `structured/{requestId}.json` con los registros parseados, hashes MD5 de ilustraciones PR03 y los resultados de preprocessing/comparación disponibles.

### Procesamiento completo de modelos

`POST /models` replica el flujo de Access: procesa `REF04` y `REF05`, filtra el powertrain por los `modelIds`, deriva las familias de vehículo, motor, caja y batería, y procesa `PR08`/`PR03` por cada familia. También puede activar `REF01`, `REF02`, `REF03`, `PR05` y `PR06` mediante `exports`.

```json
{
  "axCode": "5208",
  "edition": "02/0",
  "manufacturer": "DACIA",
  "description": "Bigster (SVA)",
  "family": "X1310",
  "modelIds": ["MODEL-0013", "MODEL-0014"],
  "range": "active",
  "language": "en",
  "exports": { "REF01": true, "REF02": true, "REF03": true, "PR05": true, "PR06": true, "PR08": true, "PR03": true }
}
```

Consulta `GET /models/:requestId`; al completar, `GET /models/:requestId/download` descarga el ZIP con el Excel TAPV filtrado y `structured.json` del procesamiento.

## Verificación

```powershell
bun test
bun run typecheck
```

Los tests no usan credenciales ni llaman a Renault.
