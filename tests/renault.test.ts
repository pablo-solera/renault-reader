import { describe, expect, test } from "bun:test";
import { buildLabourObjectKey, buildPartsBaseKey, buildPartsObjectKey } from "../src/jobs.js";
import { buildFileName, buildPartsFileName, getEditorFamilies, getPartnerFamilies } from "../src/renault.js";
import { normalizeUploadContentType } from "../src/storage.js";
import { normalizeAxCode, normalizeDescription, normalizeEdition, normalizeManufacturer } from "../src/parts.js";

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
});
