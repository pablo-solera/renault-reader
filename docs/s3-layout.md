# Layout de S3 y manifiesto v2

El reader guarda **sin transformar** lo que entrega ASMDOR y escribe el manifiesto **al final** de cada unidad. Si
`{unidad}_completed.json` existe, la unidad está completa. El contrato del manifiesto está en `reader-core`
(`docs/contract-transformer.md`); el transformer de Renault lo consume.

## Carpetas

```text
{S3_PREFIX}/RENAULT/{fabricante}/labour/{familia}/{YYYYMMDD}/{unidad}/
{S3_PREFIX}/RENAULT/{fabricante}/parts/{axCode}_{descripción}_{familia}/{edición NN-N}/{YYYYMMDD}/{unidad}/
```

- `{fabricante}`: el de la petición sin `BRAND`/`TRUCKS` (por ejemplo `RENAULT`, `DACIA`).
- `{YYYYMMDD}`: día en que se creó la petición; no cambia si se reanuda otro día.
- Los segmentos pasan por `pathSegment` de core (`Bigster (SVA)` -> `Bigster-SVA-`).
- `S3_PREFIX` es vacío por defecto; el legacy usaba `RENAULT_GROUP/files_datasource`, que puede configurarse ahí.

## Unidades

| Recurso | Unidad | Contenido |
|---|---|---|
| `labour` | `TM01_{idioma}_{rango}_{formato}[_after{YYYYMMDD}]` | El export TM01 |
| `parts` | `REF04`, `REF05`, `REF01`, `REF02`, `REF03`, `PR05`, `PR06` | Un export cada una |
| `parts` | `PR08_{familia}`, `PR03_{familia}` | Un export por familia derivada de REF04 x REF05 |

`REF04` y `REF05` se extraen siempre. Las familias son las de vehículo, motor, caja y batería de las filas de REF05 que
cumplen los predicados de los modelos de REF04 seleccionados (`modelIds`), con las reglas de Access.

## Ficheros de una unidad

- El archivo original tal cual lo descargó ASMDOR (`zip`, `json.zip` o `tar.gz`), con el nombre que le da ASMDOR (`{base}_{familia}_{perfil}[_{idioma}][_after{fecha}]{formato}`). Sin abrir ni modificar.
- `{unidad}_completed.json`: manifiesto v2.

## Manifiesto

`schemaVersion: 2`, `manufacturer`, `resource` (`labour` o `parts`), `unit`, `path`, `date`, `requestId`, `axCode?`, `edition?`, `language?`,
`dataVersion: null` (ASMDOR no informa versión), `startedAt`, `completedAt`, `durationMs`,
`files: [{ name, role: "export", unit: queryCode }]`, `counts: { files: 1, bytes }` y `details`:

| `details` | Significado |
|---|---|
| `queryCode`, `queryDesc` | Export de ASMDOR (`TM01`, `REF04`...) |
| `fileName`, `contentType`, `size` | Fichero guardado |
| `range`, `family`, `format`, `language`, `publishedAfter` | Parámetros enviados a ASMDOR |
| `remoteRequestId`, `remoteStatus` | Id de la petición en ASMDOR (`available` si ya existía) y estado inicial (`EXECUTE`, `AVAILABLE`...) |
| `profile` | Perfil AUDATEX usado |
| `modelIds`, `families` | Solo `parts`: modelos de REF04 pedidos y familias derivadas (en las unidades que se piden una vez conocidas) |

## Lo que ya no está en S3

`structured/{id}.json`, el preprocesado de PR08, los hashes MD5 de ilustraciones, el Excel TAPV, el ZIP del informe del
modelo y las comparaciones entre ediciones: son transformación y los produce `renault-transformer`.
