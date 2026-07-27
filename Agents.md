# ASMDOR Renault API Findings

## Scope

La aplicación pública es `https://asmdor.renault.com`. El backend observado en el bundle actual usa:

```text
https://opeeu.a5m.opeeu.asdh.aws.renault.com/api/
```

Este documento contiene rutas y contratos observados. Los valores concretos de una cuenta no deben guardarse aquí.

## Authentication

### External/Gigya flow

1. `POST https://accounts.eu1.gigya.com/accounts.login` con formulario `apiKey`, `loginID`, `password`, `sessionExpiration=600` y `pageURL`.
2. La respuesta debe contener `UID`, `UIDSignature`, `signatureTimestamp`, `isActive=true` y `errorCode=0`.
3. Intercambio:

```text
POST /api/v1/user/gigya/accessToken
Content-Type: application/json
```

```json
{
  "UID": "...",
  "UIDSignature": "...",
  "signatureTimestamp": "..."
}
```

La respuesta contiene `accessToken`. Las peticiones posteriores usan `Authorization: Bearer <accessToken>`.

No enviar la contraseña a ASMDOR ni guardar tokens en logs.

### ARCA flow

ARCA inicia una navegación OIDC desde:

```text
GET /api/oidc/authorize
```

Redirige a Okta/SSO y no debe tratarse como login REST de correo y contraseña.

## Identity and profile

```text
POST /api/v1/apigee/partnerApplicability/GIGYAUSER/{email}
```

La respuesta esperada contiene `status=Success`, `commercialName`, `accountType`, `allfamilyList`, `vehicleFamilyList`, `powertrainFamilyList`, `applicabilitiesLanguage` y datos de suscripción.

Después:

```text
GET /api/rest/v1/profile/getProfileData/{commercialName}
```

El frontend toma un perfil de `responseData`, con campos como `user`, `value`, `role`, `brand`, `asosSolido` e `interpretModEvent`.

## Query configuration

```text
POST /api/rest/v1/query/get/profile/{profile.value}
```

El body observado es el role del usuario. La respuesta contiene definiciones de queries. Para Labour Times se busca `queryCode === "TM01"`.

Campos dinámicos importantes:

```text
id
queryCode
queryDesc
queryService
queryDownloadPath
familyFilter
familyType
language
formatList
contentFormat
additionalFilter
currentDateRequired
```

No asumir valores de `queryService`, `queryDownloadPath`, idiomas o familias: llegan del upstream autenticado.

## Authorized options

Para Partner, `familyType` selecciona la colección:

```text
All        -> responseData.allfamilyList[range]
VEHICLE    -> responseData.vehicleFamilyList[range]
POWERTRAIN -> responseData.powertrainFamilyList[range]
```

La UI elimina objetos con `label === "All"` y ordena por `value`. Cada familia puede contener `label`, `value`, `criteria`, `brand` y `ecuId`.

Los idiomas visibles son la unión de `query.language` y `applicabilitiesLanguage` normalizados a minúsculas. Los formatos de exportación observados son `csv` y `json`; `contentFormat` es un concepto separado.

## Labour Times flow

### Status check

```text
POST /api/rest/v1/requestquery/get/status
```

Payload base:

```json
{
  "queryLabel": "TM01 - Labour Times (TM)",
  "queryid": "<TM01.id>",
  "family": "<selectedFamily.value>",
  "criteria": "<selectedFamily.criteria>",
  "exportType": "F|P",
  "exportFormat": "json",
  "profile": "<profile.value lowercase>",
  "commercialName": "<profile.user>",
  "brand": "<selected brand>",
  "applicabilityFilter": [],
  "editorApplicabilityFilter": [],
  "contentFormat": "<TM01 value>",
  "language": "<language>",
  "publishedDate": "YYYYMMDD or empty",
  "countryCode": null,
  "userFilterId": null,
  "range": "active",
  "role": null,
  "ecu": null,
  "fileName": "<framed file name>"
}
```

The frontend recognizes:

```text
AVAILABLE   -> obtain URL and download
EXECUTE     -> use requestQueryId and call queryService
PENDING     -> schedule/launch flow
INPROGRESS  -> wait
```

### Launch

```text
POST /api/{TM01.queryService}
```

The body uses the status payload plus `queryRequestId` and `interpretModEvent`. `queryService` is dynamic and must come from the authenticated TM01 object.

### History

```text
POST /api/rest/v1/history/get/{userEmail}
```

The response is `{responseData: HistoryRecord[]}`. Download is enabled when:

```text
exportStatus === "Completed" || exportStatus === "Unlocked"
```

and `fileName !== null`. Relevant fields include `requestedQueryId`, `queryLabel`, `fileName`, `filePath`, `exportStatus` and `userMailId`.

### Presigned URL and ZIP

```text
POST /api/rest/s3/get/downloadURL
```

```json
{
  "filePath": "<filePath without trailing slash, biz/ removed>",
  "fileName": "<history.fileName>",
  "queryCode": "TM01"
}
```

Response:

```json
{
  "status": "Success",
  "responseData": { "downloadUrl": "<presigned URL>" }
}
```

The ZIP is downloaded with a direct `GET` to `downloadUrl` and must not receive the ASMDOR bearer header. URLs may be AWS presigned URLs with `X-Amz-Date` and `X-Amz-Expires`.

## Local implementation decisions

- Redis stores job state with a TTL and BullMQ queue data.
- Renault credentials are loaded only from the worker/API environment (`RENAULT_EMAIL` and `RENAULT_PASSWORD`); they are never accepted over HTTP or stored in Redis.
- ZIPs are streamed to S3 under `S3_LABOURS_PREFIX/renault_{requestId}_{fileName}`.
- The Renault default prefix is `RENAULT_GROUP/files_datasource/RENAULT/Labour_Time`.
- There is no API authentication in the MVP; the server binds to loopback by default.
- `POST /parts` is intentionally a `501` placeholder.

## Known uncertainties

- Exact TM01 `queryService`, `queryDownloadPath`, `familyType`, formats and language list are account/profile-dependent.
- `getProfileDataByUser` is observed as a frontend service but its server-side authorization semantics must be preserved.
- The frontend does not implement a reliable automatic polling loop; this project polls History conservatively.
- `contentFormat` and `exportFormat` must not be conflated.
