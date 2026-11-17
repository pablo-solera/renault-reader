# Access vs API: Renault business-rule alignment

Date: 2026-09-07

Source inspected: `DataReaderRenault_v1.00_dev.accdb`, exported with Access COM automation. The raw export is intentionally outside the repository because the database contains internal configuration and operational code.

## Executive Summary

The API reproduces the broad workflow and several Access algorithms, but it is not behaviorally equivalent yet.

The highest-risk gaps are in the data transformation delivered to Acciona, not in the Renault download orchestration:

1. Access handles `MOD` applicability dates as the first day of the month; the API only parses eight-digit dates.
2. Access expands section applicability into labelled `From:`/`To:` text; the API currently emits the raw cleaned applicability string.
3. Access follows supersession chains recursively and marks multi-target replacements; the API maps only direct replacement targets.
4. The API's standalone `PR08` structured output is only normalized, while Access evaluates HTC applicability, sets `ActiveSection`/`ActivePartsNumber`, cleans HTC expressions and creates the Access hash. The model-to-Acciona path does this later, but a direct `POST /parts` PR08 result is not Access-equivalent.
5. `Audatex_TOYOTA` metadata differs: Access writes the two-digit year and `AccesoMex=0`; the API writes a four-digit year and `AccesoMex=null`.

The Renault transport layer is conceptually aligned with the observed ASMDOR flow, but Access uses Selenium against the portal and has a roughly ten-minute general-file timeout, whereas the API uses the Gigya/API flow and permits a configurable default timeout of 24 hours. These are implementation differences with operational consequences.

## Matrix

| Area | Access rule | API status | Evidence |
|---|---|---|---|
| Model selection | Filter selected model IDs and use selected model attributes to select powertrain rows | Aligned for family/body/engine matching | Access `Form_WebDownloadFileRequest` and `powertrain.ts:15-29` |
| Powertrain family order | Distinct families in vehicle, engine, gearbox, battery field order | Aligned | Access `RenaultWeb` flow; `src/powertrain.ts:31-39` |
| HTC criteria codes | Criteria 7/8/18/999/998/997/996/968/966 plus `BRA## -> 336` | Aligned in the model-to-Acciona path | Access `ComparePreprocessing` lines 367-442; `src/preprocessing/applicability.ts:10-29` |
| HTC boolean semantics | Slash groups are AND; comma tokens are OR; unknown criteria do not invalidate the expression | Mostly aligned | Access `ComparePreprocessing` lines 621-912; `src/preprocessing/applicability.ts:31-49` |
| Active flags | Evaluate section, then part applicability; `ActiveSection=1`, and parts are active only when both pass | Aligned in Acciona rebuild, missing from standalone PR08 output | Access `Preprocessing` lines 28-134; `src/preprocessing/catalog.ts:22-27`; `src/jobs.ts:246-257` |
| HTC cleaning | Remove non-matching supported tokens, preserve unknown tokens, collapse separators | Aligned in model-to-Acciona path | Access `ComparePreprocessing` lines 1060 onward; `src/preprocessing/applicability.ts:40-50` |
| Navigation path | Resolve labels by level, exclude `N-21347`, join with CRLF and `>> ` | Aligned in model-to-Acciona path; old helper differs | Access `ComparePreprocessing` lines 153-272; `src/preprocessing/tree.ts:9-13`; `src/parts.ts:125-139` |
| Catalog hash | HMAC-SHA1 where key and message are the same, with 14 selected fields and spaces removed | Aligned | Access `Hash` lines 4-21 and `ComparePreprocessing` lines 1003-1044; `src/preprocessing/hash.ts:3-11` |
| Hash matching | Equal hash rows are marked unchanged before comparison | Aligned | Access `Compare` lines 21-25; `src/preprocessing/compare-catalog.ts:39-48` |
| Comparison priority | Illustration, PNC, part number, applicability, replacement, section applicability, description, additional parts, kit | Aligned in the model comparison implementation | Access `Compare` lines 99-110 and 154-253; `src/preprocessing/compare-catalog.ts:19-32` |
| Image equality | First two underscore-separated filename segments or equal MD5 | Aligned | Access `Compare` lines 126-151; `src/preprocessing/compare-catalog.ts:11-16` |
| New/deleted sections | Classify by section presence; rows become `NewSection`, `DeletedSection`, etc. | Aligned with minor output-shape differences | Access `Compare` lines 43-76; `src/preprocessing/compare-catalog.ts:49-80` |
| Model input validation | AxCode length 3-4; one manufacturer and one family; edition format; development/completion dates; first edition cannot use previous comparison | Partially aligned | Access `Form_WebDownloadFileRequest` lines 90-122, 130-265, 273-341; `src/app.ts:68-88` |
| Edition | `NN/N`, uppercase/space normalization, no previous comparison for `01/0` | Aligned | Access `Form_WebDownloadFileRequest` lines 205-265; `src/app.ts:50,64` |
| Manufacturer normalization | Remove `BRAND` and `TRUCKS` | Aligned | Access `Form_WebDownloadFileRequest` lines 282-286; `src/parts.ts:38-40` |
| Download set | General files and parts information can be enabled/disabled by UI; REF04/REF05 are core inputs | Different defaults | Access `RenaultWeb` lines 318-837 and form lines 343-359; `src/jobs.ts:293-340` enables most exports by default and always runs REF04/REF05 |
| Remote orchestration | Selenium clicks, checks local Downloads, polls every 30 seconds, general flow stops after 20 cycles | Different implementation/timeout | Access `RenaultWeb` lines 303-314 and 835-862; `src/jobs.ts:133-144` and config default 24h |
| Parts applicability dates | `YYYYMMDD` converted to `DD/MM/YYYY`; `MODMMYY` converted to day 01 | **Divergent** | Access `AdapterAcciona` lines 404-425; `src/acciona/transform.ts:65-69,90-97` |
| Reference applicability text | Prefix codified signs, then MTC/product area; retain line breaks | Aligned | Access `AdapterAcciona` lines 427-485; `src/acciona/transform.ts:78-99` |
| Section description | Render every applicability component as `Applicability:`, `From:`, `To:`, then navigation | **Divergent** | Access `AdapterAcciona` lines 128-170; `src/acciona/transform.ts:142-164` |
| Section filter order | Sort `DesSecciones` by `Navigation_path`, use first navigation line, distinct ordinal | Partially aligned; API keeps input order | Access `AdapterAcciona` lines 287-304; `src/acciona/transform.ts:167-172` |
| Supersessions | Follow replacement chain recursively; write every target; return `Multi` when more than one target | **Divergent** | Access `AdapterAcciona` lines 557-610; `src/acciona/transform.ts:179-192` |
| Reference replacement value | `Multi.` for multi-target chain, otherwise final replacement | Partially aligned | Access `AdapterAcciona` lines 390-398; `src/acciona/transform.ts:71-77` |
| Parts descriptions | Resolve active PR06 descriptions, then create `A_<model>_<part>` records | Mostly aligned | Access `AdapterAcciona` lines 630-683; `src/acciona/transform.ts:174-177` |
| CriteriaLabels | Insert labels and deactivate older duplicates, keep newest active row | API does not perform the same deduplication step | Access `AdapterAcciona` lines 691-755; `src/acciona/transform.ts:38-44` |
| Audatex metadata | `CodPais=GEN`, `Activo=0`, `AccesoMex=0`, `Mes=MM`, `Ano=YY` | **Divergent** | Access `AdapterAcciona` lines 63-74; `src/acciona/load-model.ts:84` |
| Section image path | Convert `.png` to `.jpeg` in Acciona output | API keeps source extension | Access `AdapterAcciona` lines 174-188; `src/acciona/transform.ts:160` |
| Comparison cleanup | Remove unchanged PartsApplicability rows and retain section rows linked to non-deleted references | Aligned conceptually | Access `CompareAdapterAcciona` and `src/acciona/transform.ts:112-140` |

## Confirmed Findings

### P1: Standalone PR08 is not Access-equivalent

`processParts` calls `preprocessCatalogRecords` for PR08 (`src/jobs.ts:246-257`). That helper only cleans text and resolves a simple navigation path (`src/parts.ts:125-139`). It does not evaluate HTC against selected powertrain rows, set `ActiveSection`/`ActivePartsNumber`, clean supported expressions, or create the Access hash.

The later `buildAccionaDataset` path rebuilds the catalog through `preprocessRenaultCatalog` (`src/acciona/load-model.ts:50-62`), so the final Acciona load receives the richer representation. This leaves the direct PR08 API artifact and any consumer of its `structured.json` with different business semantics from Access.

### P1: Acciona section descriptions lose business formatting

Access parses each `sectionApplicabilityCleaned` line and emits labelled values (`Applicability:`, `From:`, `To:`), including the special `MOD` date behavior, before appending navigation. The API emits one literal `Applicability:` prefix followed by the unrendered cleaned value. This changes user-visible `DesSecciones.Descripcion` and can affect downstream consumers.

### P1: Supersession chains are incomplete

Access recursively follows `PartsSuperssesion` from each target and writes all resulting rows. The API emits only the `replacement.target` array currently attached to the input record. A multi-level chain can therefore produce missing `Sustituciones` rows and an incorrect `Dato5`.

### P1: MOD dates are not handled

Access maps `MOD0126`-style values to the first day of the relevant month. `dateValue` returns `null` for any value not matching eight digits. This drops dates from `Dato8`, `Dato9`, `DatoFecha` and `DatoFecha1` for valid Access inputs.

### P2: Audatex metadata differs

The Access module writes `Ano = Right(Epc, 2)` and `AccesoMex = 0`. The API writes `ano = 2000 + Number(epc.slice(2))` and `AccesoMex: null`. Verify the target SQL schema's intended representation before changing it, but this is a confirmed rule mismatch.

### P2: Access UI validation is not represented in the model API

Access rejects mixed manufacturers and mixed families, constrains AxCode to 3-4 characters, and requires/validates development and completion dates. The API accepts a free-form AxCode length and does not expose those date fields. If those dates are only UI metadata and not persisted downstream, this is a missing validation rather than a data mapping issue.

### P2: Criteria label deduplication is missing

Access deactivates previous duplicate `CriteriaLabels` rows and activates the newest matching row. The API creates all flattened records with `active: true`. Repeated loads can therefore leave multiple active versions.

### P3: Image extension and section ordering differ

Access stores Acciona image paths with `.png` replaced by `.jpeg` and sorts section filters by navigation path. The API preserves the source extension and derives filter order from input order.

## Recommended Changes

1. Move the full Access-compatible catalog preprocessing into the PR08 worker, or explicitly document that PR08 `structured.json` is raw-normalized and only `/models/:id/acciona` is business-processed.
2. Add a shared Access date parser for `YYYYMMDD` and `MODMMYY`, and use it for both reference and section transformations.
3. Render `DesSecciones.Descripcion` from the same applicability components as Access, rather than serializing the cleaned source string.
4. Normalize replacement data into a transitive closure before generating `Sustituciones` and `Dato5`.
5. Match Access `Audatex_TOYOTA` metadata exactly after checking the SQL column types.
6. Deduplicate CriteriaLabels by `(HTC, labels, lang)` and mark only the newest row active.
7. Add fixture tests for `MOD` dates, section rendering, recursive supersession, metadata year/flags, and direct PR08 structured output.
8. Keep `src/parts.ts:142-160` out of the production comparison path or delete/align it; it is a second comparison implementation and does not implement the Access algorithm as completely as `src/preprocessing/compare-catalog.ts`.

## Verification Status

The existing unit suite covers the broad Access ports and hash/comparison examples, but it does not cover the confirmed gaps above. The database extraction itself was read-only and performed against a temporary copy of the Access file.
