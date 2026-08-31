import { describe, expect, test } from "bun:test";
import { buildLabourObjectKey, buildPartsBaseKey, buildPartsObjectKey } from "../src/jobs.js";
import { buildFileName, buildPartsFileName, getEditorFamilies, getPartnerFamilies } from "../src/renault.js";
import { normalizeUploadContentType } from "../src/storage.js";
import { compareCatalogRecords, compareImageHashes, compareTapv, currentEpc, normalizeAxCode, normalizeDescription, normalizeEdition, normalizeManufacturer, parsePartsArchive, preprocessCatalogRecords, preprocessModelVehicleRecords } from "../src/parts.js";
import { zipSync, strToU8 } from "fflate";
import { deriveFamilies, selectPowertrain } from "../src/powertrain.js";

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
  });

  test("builds the Access-compatible Parts path", () => {
    const input = { exportType: "REF04", manufacturer: "BRAND DACIA", description: "Big ster/SVA", family: "X1310", axCode: "5208 ", edition: "02/0", range: "active" } as any;
    expect(buildPartsBaseKey(input, new Date("2026-08-31T12:00:00Z"))).toBe("RENAULT_GROUP/files_datasource/DACIA/Parts/5208_Bigster-SVA_X1310/02-0/20260831");
    expect(buildPartsObjectKey("request-3", "REF04", "model_vehicle.zip", input)).toContain("/DACIA/Parts/5208_Bigster-SVA_X1310/02-0/20260831/REF04/");
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
});
