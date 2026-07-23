import { describe, expect, test } from "bun:test";
import { buildFileName, getEditorFamilies, getPartnerFamilies } from "../src/renault.js";

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

  test("frames a Labour filename without exposing credentials", () => {
    const file = buildFileName({ queryDownloadPath: "TM01/labours.zip", familyFilter: true, language: ["en"] } as any, {
      email: "user@example.com", password: "secret", family: "All", format: "_json.zip", language: "en", range: "active", publishedAfter: "2026-05-01",
    }, "AUDATEX");
    expect(file).toBe("labours_All_audatex_en_after20260501_json.zip");
    expect(file).not.toContain("secret");
  });
});
