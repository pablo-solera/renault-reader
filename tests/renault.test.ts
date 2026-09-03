import { describe, expect, test } from "bun:test";
import { buildLabourObjectKey, buildPartsBaseKey, buildPartsObjectKey } from "../src/jobs.js";
import { buildFileName, buildPartsFileName, getEditorFamilies, getPartnerFamilies } from "../src/renault.js";
import { normalizeUploadContentType } from "../src/storage.js";
import { compareCatalogRecords, compareImageHashes, compareTapv, currentEpc, epcFromDate, normalizeAxCode, normalizeDescription, normalizeEdition, normalizeManufacturer, parsePartsArchive, preprocessCatalogRecords, preprocessModelVehicleRecords } from "../src/parts.js";
import { zipSync, strToU8 } from "fflate";
import { deriveFamilies, selectPowertrain } from "../src/powertrain.js";
import { buildCriteriaIndex } from "../src/preprocessing/criteria.js";
import { clearHtc, evaluateApplicability } from "../src/preprocessing/applicability.js";
import { buildTreeIndex, navigationPath } from "../src/preprocessing/tree.js";
import { createCatalogHash } from "../src/preprocessing/hash.js";
import { getAccionaConfig, extractionDatabaseName } from "../src/db/acciona.js";
import { assertAllowedDatabase, ACCIONA_TABLES } from "../src/acciona/writers.js";
import { flattenPartsCatalog, flattenRepairTree, toAccionaPartsData, toAccionaReferences } from "../src/acciona/transform.js";
import { compareReferences } from "../src/acciona/compare.js";
import { compareCatalogs } from "../src/preprocessing/compare-catalog.js";

describe("Renault Labour helpers", () => {
  test("filters and sorts authorized partner families", () => {
    const result = getPartnerFamilies({ responseData: { allfamilyList: { active: [
      { label: "All", value: "All" },
      { label: "Zeta", value: "Z" },
      { label: "Alpha", value: "A" },
    ] } } }, { familyType: "All" } as any, "active");
    expect(result.map((item) => item.value)).toEqual(["A", "All", "Z"]);
  });

  test("uses non-confidential families for editor accounts", () => {
    const result = getEditorFamilies({ responseData: [
      { label: "Beta", value: "B", criteria: "beta/1" },
      { label: "Alpha", value: "A", criteria: "alpha/2" },
    ] }, { familyType: "All" } as any);
    expect(result[0]).toEqual({ label: "Alpha", value: "A", criteria: "alpha/2" });
  });

  test("reports missing ranges instead of hiding the response shape", () => {
    expect(() => getPartnerFamilies({ responseData: { allfamilyList: { old: [] } } }, { familyType: "All" } as any, "active"))
      .toThrow("allfamilyList has no active range");
  });

  test("stores Labour files under the Renault datasource prefix", () => {
    const key = buildLabourObjectKey("request-1", "tm_data_X06/editor.zip");
    expect(key).toBe("RENAULT_GROUP/files_datasource/RENAULT/Labour_Time/renault_request-1_tm_data_X06_editor.zip");
    expect(key).not.toContain("/request-1/");
  });

  test("normalizes Renault's non-MIME ZIP content type", () => {
    expect(normalizeUploadContentType("zip")).toBe("application/zip");
    expect(normalizeUploadContentType("application/zip")).toBe("application/zip");
  });

  test("frames a Labour filename without exposing credentials", () => {
    const file = buildFileName({ queryDownloadPath: "TM01/labours.zip", familyFilter: true, language: ["en"] } as any, {
      family: "All", format: "_json.zip", language: "en", range: "active", publishedAfter: "2026-05-01",
    }, "AUDATEX");
    expect(file).toBe("labours_All_audatex_en_after20260501_json.zip");
  });

  test("builds Parts filenames from the upstream download path", () => {
    const file = buildPartsFileName({ queryCode: "PR03", queryDownloadPath: "PR/plate_illustrations.tar.gz", familyFilter: true, language: null } as any, {
      exportType: "PR03", family: "CLIO", format: "tar.gz", range: "active",
    }, "AUDATEX");
    expect(file).toBe("plate_illustrations_CLIO_audatex.tar.gz");
  });

  test("stores Parts files below an export-specific prefix", () => {
    const key = buildPartsObjectKey("request-2", "PR08", "partsInCatalog_CLIO_editor_json.zip");
    expect(key).toBe("RENAULT_GROUP/files_datasource/RENAULT/Parts/PR08/renault_request-2_partsInCatalog_CLIO_editor_json.zip");
  });

  test("parses JSON records from a Renault ZIP", async () => {
    const archive = zipSync({ "powertrain.json": strToU8(JSON.stringify([{ TAPV: "A", familyVehicle: "CLIO" }])) });
    const parsed = await parsePartsArchive("REF05", archive);
    expect(parsed.records).toEqual([{ TAPV: "A", familyVehicle: "CLIO" }]);
  });

  test("compares TAPV rows and illustration hashes", () => {
    const diff = compareTapv([{ TAPV: "new" }], [{ TAPV: "old" }]);
    expect(diff.newRows).toHaveLength(1);
    expect(diff.deletedRows).toHaveLength(1);
    const images = compareImageHashes({ exportType: "PR03", files: [], records: [], images: [{ name: "a.png", md5: "1" }] }, { exportType: "PR03", files: [], records: [], images: [{ name: "a.png", md5: "2" }] });
    expect(images.newImages).toHaveLength(1);
    expect(images.deletedImages).toHaveLength(1);
  });

  test("preprocesses catalog navigation and classifies catalog changes", () => {
    const current = preprocessCatalogRecords([{ plateId: "P1", hotSpotNumber: "1", nodes: "N1,N2", partsApplicability: " A " }], [{ nodeId: "N1", labelEN: "Body" }, { nodeId: "N2", labelEN: "Door" }]);
    expect(current[0].navigation_path).toBe("Body > Door");
    const diff = compareCatalogRecords(current, [{ plateId: "P1", hotSpotNumber: "1", nodes: "N1,N2", partNumber: "old" }]);
    expect(diff.records[0].typeCompare).toBe("PartNumberCode");
  });

  test("selects and normalizes ModelVehicle records like Access", () => {
    const models = preprocessModelVehicleRecords([
      { modelId: "M1", manufacturer: "RENAULT" },
      { modelId: "M2", manufacturer: "UNKNOWN" },
    ], ["M2"]);
    expect(models).toEqual([{ modelId: "M2", manufacturer: "UNKNOWN", manufacturerCode: "UNKNOWN" }]);
    expect(preprocessModelVehicleRecords([{ modelId: "M1", manufacturer: "APL03" }], undefined, "Dacia")[0].manufacturer).toBe("Dacia");
    expect(currentEpc(new Date(2026, 7, 31))).toBe("0826");
    expect(epcFromDate("2026-08-31T15:21:59.678Z")).toBe("0826");
  });

  test("builds the Access-compatible Parts path", () => {
    const input = { exportType: "REF04", manufacturer: "BRAND DACIA", description: "Big ster/SVA", family: "X1310", axCode: "5208 ", edition: "02/0", range: "active" } as any;
    expect(buildPartsBaseKey(input, new Date("2026-08-31T12:00:00Z"))).toBe("RENAULT_GROUP/files_datasource/DACIA/Parts/5208_Bigster-SVA_X1310/02-0/20260831");
    expect(buildPartsObjectKey("request-3", "REF04", "model_vehicle.zip", input, new Date("2026-08-31T12:00:00Z"))).toContain("/DACIA/Parts/5208_Bigster-SVA_X1310/02-0/20260831/REF04/");
    expect(normalizeAxCode("5208 02/0")).toBe("520802/0");
    expect(normalizeManufacturer("BRAND DACIA TRUCKS")).toBe("DACIA");
    expect(normalizeDescription("Big ster/SVA&%" )).toBe("Bigster-SVA__");
    expect(normalizeEdition(" 02/0 ")).toBe("02/0");
    expect(() => normalizeEdition("0200")).toThrow();
  });

  test("selects powertrain rows using Access model predicates", () => {
    const records = [
      { TAPV: "A", familyVehicle: "X1310", bodyType: "SVA", engineType: "H4M" },
      { TAPV: "B", familyVehicle: "X1310", bodyType: "SVA", engineType: "K9K" },
      { TAPV: "C", familyVehicle: "X1310", bodyType: "SUV", engineType: "H4M" },
    ];
    expect(selectPowertrain(records, [{ familyVehicle: "X1310", bodyType: "SVA", engineType: "H4M,K9K" }])).toEqual(records.slice(0, 2));
  });

  test("derives the distinct Access families from selected powertrain", () => {
    expect(deriveFamilies([
      { familyVehicle: "X1310", familyEngine: "HXX", familyGearbox: "KXX", familyBattery: "DBX" },
      { familyVehicle: "X1310", familyEngine: "HXX", familyGearbox: "DCX", familyBattery: "TLX" },
      { familyVehicle: "", familyEngine: "BT7", familyGearbox: "BTA", familyBattery: "" },
    ])).toEqual(["X1310", "HXX", "BT7", "KXX", "DCX", "BTA", "DBX", "TLX"]);
  });

  test("evaluates Access HTC applicability across all selected TAPV rows", () => {
    const criteria = buildCriteriaIndex([{ HTC: "X1310", objectOriginCode: 7 }, { HTC: "SVA", objectOriginCode: 8 }]);
    const rows = [{ familyVehicle: "X1310", bodyType: "SVA" }, { familyVehicle: "X1310", bodyType: "SUV" }];
    expect(evaluateApplicability("X1310/SVA/M2024|AREA", criteria, rows, rows[0], "vehicle")).toEqual({ valid: true, cleaned: "X1310/SVA/M2024|AREA", comparison: "X1310/SVA/M2024|AREA" });
    expect(clearHtc("UNKNOWN/X1310", criteria, rows[0], rows[0], "VEHICLE")).toBe("UNKNOWN/X1310");
  });

  test("builds Access navigation paths and excludes the ignored node", () => {
    const index = buildTreeIndex([{ nodeId: "N1", labelEN: "Body" }, { nodeId: "N-21347", labelEN: "Ignored" }, { nodeId: "N2", labelEN: "Door" }]);
    expect(navigationPath(["N1", "N-21347", "N2"], index)).toBe("Body\r\n>> Door");
  });

  test("creates stable Access-compatible catalog hashes", () => {
    const record = { plateId: "P1", illustrationFile: "a.png", sectionApplicabilityCleanedComparison: "A", hotSpotNumber: "1", partNumber: "123" };
    expect(createCatalogHash(record)).toBe(createCatalogHash({ ...record }));
  });

  test("loads Acciona connection settings only from environment", () => {
    const cfg = getAccionaConfig({ ACCIONA_SQL_HOST: "staging", ACCIONA_SQL_USER: "user", ACCIONA_SQL_PASSWORD: "secret", ACCIONA_IMAGES_ROOT: "C:/images" });
    expect(extractionDatabaseName(cfg, "DACIA", "0826")).toBe("Extraccion_DACIA0826");
  });

  test("restricts Acciona writers to explicitly allowlisted databases", () => {
    expect(() => assertAllowedDatabase("_MOK_MOK", ["_MOK_MOK"])).not.toThrow();
    expect(() => assertAllowedDatabase("Extraccion_DACIA0826", ["_MOK_MOK"])).toThrow();
    expect(() => assertAllowedDatabase("Extraccion_DACIA0826", ["Extraccion_DACIA0826"])).toThrow("explicit confirmation");
    expect(() => assertAllowedDatabase("Extraccion_DACIA0826", ["Extraccion_DACIA0826"], false, true)).not.toThrow();
    expect(ACCIONA_TABLES.referencias).toBe("Referencias");
  });

  test("flattens Renault PR08 plates into Access catalog rows", () => {
    const rows = flattenPartsCatalog([{ plateId: "X_1", nodes: ["N1"], applicability: [{ mtc: "X" }], lines: [{ partNumber: "P", applicability: [{ mtc: "X/SVA", startDate: "20260101", endDate: "20261231" }] }] }]);
    expect(rows[0]).toMatchObject({ plateId: "X_1", nodes: "N1", sectionApplicability: "X", partNumber: "P", partsApplicability: "X/SVA|||20260101|20261231" });
  });

  test("flattens nested REF03 repair trees", () => {
    const rows = flattenRepairTree({ REPAIR_TREE: [{ nodeId: "N1", level: 1, label: [{ language: "EN", longLabel: "Body" }], childNodes: [{ nodeId: "N2", level: 2, label: [{ language: "EN", longLabel: "Door" }], childNodes: [] }] }] });
    expect(rows).toHaveLength(2);
    expect(rows[1].labelEN).toBe("Door");
  });

  test("maps active catalog applicability to Acciona reference rows", () => {
    const rows = toAccionaReferences([{ ActivePartsNumber: 1, plateId: "X_123", hotSpotNumber: 4, genericPart: "G", partNumber: "P", partsApplicabilityCleaned: "X/SVA|A|(Plant)|20260102|20261203" }], "5208", "X1310");
    expect(rows[0]).toMatchObject({ IdModeloAudatex: "5208", IdSeccion: "123", Dato8: "02/01/2026", Dato9: "03/12/2026" });
    expect(rows[0].DatoFecha).toBeInstanceOf(Date);
  });

  test("maps PR06 rows to PartsData without losing the source fields", () => {
    expect(toAccionaPartsData([{ partNumber: "P", brandCode: "01", designation: "Part" }])[0]).toMatchObject({ partNumber: "P", brandCode: "01", designation: "Part", active: true });
  });

  test("compares references approximately by stable applicability key", () => {
    const before = [{ Dato12: "P", Dato1: "1", Dato3: "OLD", Dato8: "01", Dato9: "02", Dato17: "a" }];
    const after = [{ ...before[0], Dato3: "NEW" }, { Dato12: "P", Dato1: "2", Dato3: "ADD", Dato8: "01", Dato9: "02" }];
    const result = compareReferences(after, before);
    expect(result.changed).toHaveLength(1);
    expect(result.added).toHaveLength(1);
    expect(result.deleted).toHaveLength(0);
  });

  test("matches unchanged catalog rows by hash", () => {
    const row = { id: 1, plateId: "P_1", hotSpotNumber: "1", partNumber: "A", ActiveSection: 1, ActivePartsNumber: 1, Hash: "same" };
    const result = compareCatalogs([row], [{ ...row, id: 2 }]);
    expect(result.newRows).toHaveLength(0);
    expect(result.deletedRows).toHaveLength(0);
  });

  test("classifies Access comparison changes by priority", () => {
    const previous = { id: 1, plateId: "P_1", hotSpotNumber: "1", partNumber: "OLD", ActiveSection: 1, ActivePartsNumber: 1, Hash: "old", partsApplicabilityCleanedComparison: "A", partCodifiedSigns: "", latestReplacementPart: "", sectionApplicabilityCleanedComparison: "S", designationEN: "old", additionalParts: "", sourcing: "Internal", partKitList: "" };
    const current = { ...previous, id: 2, partNumber: "NEW", Hash: "new" };
    const result = compareCatalogs([current], [previous]);
    expect(result.current[0].TypeCompare).toBe("PartNumberCode");
  });

  test("classifies new and deleted sections separately", () => {
    const row = (plateId: string) => ({ plateId, hotSpotNumber: "1", partNumber: plateId, ActiveSection: 1, ActivePartsNumber: 1, Hash: plateId });
    const result = compareCatalogs([row("NEW")], [row("OLD")]);
    expect(result.current[0].TypeCompare).toBe("NewSection");
    expect(result.previous[0].TypeCompare).toBe("DeletedSection");
  });
});
