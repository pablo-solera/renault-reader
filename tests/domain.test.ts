import { describe, expect, test } from "bun:test";
import { ValidationError } from "@pablosla/core-reader/domain/errors";
import { buildFileName, getEditorFamilies, getPartnerFamilies } from "../src/domain/renault-query.js";
import { normalizeAxCode, normalizeContentType, normalizeDescription, normalizeEdition, normalizeManufacturer } from "../src/domain/normalize.js";
import { validateLabourInput, validatePartsInput } from "../src/domain/validation.js";
import { familyUnits, initialUnits, labourUnitName, lockPaths, scopeFolder, unitFolder } from "../src/domain/units.js";
import { deriveFamilies, selectPowertrain } from "../src/domain/powertrain.js";
import { requestProgress, resumableUnitIndex } from "../src/domain/progress.js";
import { buildUnitManifest } from "../src/domain/manifest.js";
import { parseExtractionManifest } from "@pablosla/core-reader/contract/manifest";
import type { PartsInput, UnitSummary } from "../src/domain/request.js";

const now = new Date("2026-11-17T10:00:00Z");
const labourRaw = { manufacturer: "RENAULT", language: "EN", selection: { family: "CLIO", format: "json.zip", range: "active", publishedAfter: "2026-05-01" } };
const partsRaw = { manufacturer: "BRAND DACIA", axCode: "5208 ", edition: "02/0", selection: { description: "Big ster/SVA", family: "X1310", modelIds: ["M1", "M2"], range: "active" } };

describe("Renault Labour helpers", () => {
  test("filters and sorts authorized partner families", () => {
    const result = getPartnerFamilies({ responseData: { allfamilyList: { active: [{ label: "All", value: "All" }, { label: "Zeta", value: "Z" }, { label: "Alpha", value: "A" }] } } }, { familyType: "All" } as any, "active");
    expect(result.map(item => item.value)).toEqual(["A", "All", "Z"]);
  });

  test("uses non-confidential families for editor accounts", () => {
    const result = getEditorFamilies({ responseData: [{ label: "Beta", value: "B", criteria: "beta/1" }, { label: "Alpha", value: "A", criteria: "alpha/2" }] }, { familyType: "All" } as any);
    expect(result[0]).toEqual({ label: "Alpha", value: "A", criteria: "alpha/2" });
  });

  test("reports missing ranges instead of hiding the response shape", () => {
    expect(() => getPartnerFamilies({ responseData: { allfamilyList: { old: [] } } }, { familyType: "All" } as any, "active")).toThrow("allfamilyList has no active range");
  });

  test("frames a Labour filename without exposing credentials", () => {
    const file = buildFileName({ queryDownloadPath: "TM01/labours.zip", familyFilter: true, language: ["en"] } as any, { family: "All", format: "_json.zip", language: "en", publishedAfter: "2026-05-01" }, "AUDATEX");
    expect(file).toBe("labours_All_audatex_en_after20260501_json.zip");
  });

  test("builds Parts filenames from the upstream download path", () => {
    const file = buildFileName({ queryCode: "PR03", queryDownloadPath: "PR/plate_illustrations.tar.gz", familyFilter: true, language: null } as any, { family: "CLIO", format: "tar.gz" }, "AUDATEX");
    expect(file).toBe("plate_illustrations_CLIO_audatex.tar.gz");
  });

  test("normalizes Renault's non-MIME ZIP content type", () => {
    expect(normalizeContentType("zip")).toBe("application/zip");
    expect(normalizeContentType(null)).toBe("application/zip");
    expect(normalizeContentType("application/gzip")).toBe("application/gzip");
  });
});

describe("normalization", () => {
  test("follows the Access rules", () => {
    expect(normalizeAxCode("5208 02/0")).toBe("520802/0");
    expect(normalizeManufacturer("BRAND DACIA TRUCKS")).toBe("DACIA");
    expect(normalizeDescription("Big ster/SVA&%")).toBe("Bigster-SVA__");
    expect(normalizeEdition(" 02/0 ")).toBe("02/0");
    expect(() => normalizeEdition("0200")).toThrow();
  });
});

describe("request validation", () => {
  test("normalizes a labour request and stamps the date", () => {
    expect(validateLabourInput(labourRaw, now)).toEqual({ resource: "labours", manufacturer: "RENAULT", date: "20261117", language: "en", family: "CLIO", format: "json.zip", range: "active", publishedAfter: "2026-05-01" });
  });

  test("rejects unknown selection keys such as credentials, bad dates and a missing language", () => {
    expect(() => validateLabourInput({ ...labourRaw, selection: { ...labourRaw.selection, password: "x" } }, now)).toThrow(ValidationError);
    expect(() => validateLabourInput({ ...labourRaw, selection: { ...labourRaw.selection, publishedAfter: "01/05/2026" } }, now)).toThrow("publishedAfter");
    expect(() => validateLabourInput({ manufacturer: "RENAULT", selection: labourRaw.selection }, now)).toThrow("language");
  });

  test("normalizes a parts request like the Access model form", () => {
    const input = validatePartsInput(partsRaw, now);
    expect(input).toMatchObject({ resource: "parts", manufacturer: "DACIA", axCode: "5208", edition: "02/0", family: "X1310", modelIds: ["M1", "M2"], date: "20261117" });
  });

  test("requires axCode (3-4 characters), edition and models for parts", () => {
    expect(() => validatePartsInput({ ...partsRaw, axCode: undefined }, now)).toThrow("axCode");
    expect(() => validatePartsInput({ ...partsRaw, axCode: "12" }, now)).toThrow("3 to 4");
    expect(() => validatePartsInput({ ...partsRaw, edition: "0200" }, now)).toThrow(ValidationError);
    expect(() => validatePartsInput({ ...partsRaw, selection: { ...partsRaw.selection, modelIds: [] } }, now)).toThrow(ValidationError);
    expect(() => validatePartsInput({ ...partsRaw, selection: { ...partsRaw.selection, exports: { REF99: true } } }, now)).toThrow(ValidationError);
  });
});

describe("units and S3 layout", () => {
  test("labour: one unit below RENAULT/{manufacturer}/labour/{family}/{date}", () => {
    const input = validateLabourInput(labourRaw, now);
    const [unit] = initialUnits(input);
    expect(labourUnitName(input)).toBe("TM01_en_active_json-zip_after20260501");
    expect(unit!.path).toBe("RENAULT/RENAULT/labour/CLIO/20261117/TM01_en_active_json-zip_after20260501");
    expect(lockPaths(input, [unit!])).toEqual([unit!.path]);
  });

  test("parts: core units first, then the enabled optional ones; families add PR08 and PR03", () => {
    const input = validatePartsInput({ ...partsRaw, selection: { ...partsRaw.selection, exports: { REF02: false, PR03: false } } }, now) as PartsInput;
    const units = initialUnits(input);
    expect(units.map(unit => unit.unit)).toEqual(["REF04", "REF05", "REF01", "REF03", "PR05", "PR06"]);
    expect(units[0]!.path).toBe("RENAULT/DACIA/parts/5208_Bigster-SVA_X1310/02-0/20261117/REF04");
    expect(familyUnits(input, ["A", "B"]).map(unit => `${unit.unit}:${unit.queryCode}:${unit.family}`)).toEqual(["PR08_A:PR08:A", "PR08_B:PR08:B"]);
    expect(scopeFolder(input)).toBe("RENAULT/DACIA/parts/5208_Bigster-SVA_X1310/02-0/20261117");
    expect(lockPaths(input, units)).toEqual([scopeFolder(input)]);
    expect(unitFolder(input, "PR08_A")).toBe(`${scopeFolder(input)}/PR08_A`);
  });
});

describe("powertrain selection", () => {
  const powertrain = [
    { familyVehicle: "X13", bodyType: "SUV", engineType: "E1", familyEngine: "ENG", familyGearbox: "GB", familyBattery: "" },
    { familyVehicle: "X13", bodyType: "SUV", engineType: "E2", familyEngine: "ENG2", familyGearbox: "GB", familyBattery: "BAT" },
    { familyVehicle: "X99", bodyType: "SUV", engineType: "E1", familyEngine: "OTHER" },
  ];

  test("selects powertrain rows with the model predicates and derives distinct families in Access order", () => {
    const selected = selectPowertrain(powertrain, [{ familyVehicle: "X13", bodyType: "SUV", engineType: "E1, E2" }]);
    expect(selected).toHaveLength(2);
    expect(deriveFamilies(selected)).toEqual(["X13", "ENG", "ENG2", "GB", "BAT"]);
    expect(selectPowertrain(powertrain, [])).toEqual([]);
  });
});

describe("progress", () => {
  const unit = (status: UnitSummary["status"]): UnitSummary => ({ unit: status, queryCode: "REF04", family: "F", path: "p", status });
  test("counts finished units, never reaches 100 and never goes backwards", () => {
    expect(requestProgress([unit("completed"), unit("pending")])).toBe(50);
    expect(requestProgress([unit("completed"), unit("completed")])).toBe(99);
    expect(requestProgress([unit("completed"), unit("pending"), unit("pending")], 80)).toBe(80);
  });
  test("resumes at the first incomplete unit", () => {
    expect(resumableUnitIndex([unit("completed"), unit("failed"), unit("pending")])).toBe(1);
    expect(resumableUnitIndex([unit("completed")])).toBe(1);
  });
});

describe("manifest v2", () => {
  test("lists the raw archive and validates against the core schema", () => {
    const input = validateLabourInput(labourRaw, now);
    const manifest = buildUnitManifest({
      input, requestId: "00000000-0000-4000-8000-000000000001", unit: "TM01_x", path: "RENAULT/RENAULT/labour/CLIO/20261117/TM01_x", startedAt: "2026-11-17T10:00:00.000Z", completedAt: "2026-11-17T10:00:05.000Z",
      details: { queryCode: "TM01", queryDesc: "Labour", fileName: "labours.zip", contentType: "application/zip", size: 10, range: "active", family: "CLIO", format: "json.zip", language: "en", publishedAfter: null, remoteRequestId: "r1", remoteStatus: "EXECUTE", profile: "AUDATEX" },
    });
    expect(manifest).toMatchObject({ schemaVersion: 2, manufacturer: "RENAULT", resource: "labour", unit: "TM01_x", date: "20261117", durationMs: 5000, language: "en", files: [{ name: "labours.zip", role: "export", unit: "TM01" }], counts: { files: 1, bytes: 10 } });
    expect(parseExtractionManifest(manifest).ok).toBe(true);
  });
});
