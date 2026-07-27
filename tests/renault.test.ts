import { describe, expect, test } from "bun:test";
import { buildLabourObjectKey } from "../src/jobs.js";
import { buildFileName, getEditorFamilies, getPartnerFamilies } from "../src/renault.js";
import { normalizeUploadContentType } from "../src/storage.js";

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
});
