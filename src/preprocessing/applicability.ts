import { criteriaCode } from "./criteria.js";

export type PowertrainRow = Record<string, unknown>;
export type ApplicabilityResult = { valid: boolean; cleaned: string; comparison: string };

const text = (value: unknown) => String(value ?? "").trim();
const values = (value: unknown) => text(value).split(",").map((item) => item.trim()).filter(Boolean);

function fieldForCode(code: number, familyType: string): string | undefined {
  const type = familyType.toUpperCase();
  if (code === 7) {
    if (type === "VEHICLE") return "familyVehicle";
    if (type === "ENGINE" || type === "POWERTRAIN") return "familyEngine";
    if (type === "GEARBOX") return "familyGearbox";
    if (type === "BATTERY") return "familyBattery";
    return "familyVehicle";
  }
  return ({ 8: "bodyType", 18: "engineLevel", 999: "engineType", 998: "engineIndex", 997: "gearboxType", 996: "gearboxIndex", 968: "batteryType", 966: "batteryIndex" } as Record<number, string>)[code];
}

function tokenMatches(token: string, index: Map<string, number>, row: PowertrainRow, familyType: string, model: PowertrainRow): boolean {
  const code = criteriaCode(token, index);
  if (code === undefined) return false;
  if (code === 336) return values(model.manufacturerCode ?? model.manufacturer).includes(token);
  const field = fieldForCode(code, familyType);
  if (!field) return false;
  return values(row[field]).includes(token);
}

export function isApplicable(expression: string, index: Map<string, number>, row: PowertrainRow, model: PowertrainRow = row, familyType = "POWERTRAIN"): boolean {
  const groups = expression.split("/").map((group) => group.trim()).filter(Boolean);
  return groups.every((group) => {
    const tokens = group.split(",").map((token) => token.trim()).filter(Boolean);
    const supported = tokens.filter((token) => fieldForCode(criteriaCode(token, index) ?? -1, familyType) || criteriaCode(token, index) === 336);
    return supported.length === 0 || supported.some((token) => tokenMatches(token, index, row, familyType, model));
  });
}

export function clearHtc(value: unknown, index: Map<string, number>, row: PowertrainRow, model?: PowertrainRow, familyType = "POWERTRAIN"): string {
  return text(value).split(/\r?\n/).map((line) => {
    const [expression, ...tail] = line.split("|");
    const kept = expression.split("/").map((group) => group.split(",").filter((token) => {
      const code = criteriaCode(token, index);
      const supported = fieldForCode(code ?? -1, familyType) || code === 336;
      return !supported || tokenMatches(token, index, row, familyType, model ?? row);
    }).join(",")).filter(Boolean).join("/");
    return kept ? [kept, ...tail].join("|") : "";
  }).filter(Boolean).join("\r\n").replaceAll("//", "/").replaceAll(",/", "/").replaceAll("/,", "/").replaceAll(",,", ",").replace(/^[/,]+|[/,]+$/g, "");
}

export function evaluateApplicability(value: unknown, index: Map<string, number>, rows: PowertrainRow[], model?: PowertrainRow, familyType = "POWERTRAIN"): ApplicabilityResult {
  const lines = text(value).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const valid = lines.filter((line) => rows.some((row) => isApplicable(line.split("|")[0], index, row, model ?? row, familyType)));
  const cleaned = valid.map((line) => {
    const row = rows.find((candidate) => isApplicable(line.split("|")[0], index, candidate, model ?? candidate, familyType)) ?? rows[0] ?? {};
    return clearHtc(line, index, row, model, familyType);
  }).filter(Boolean).join("\r\n");
  return { valid: valid.length > 0, cleaned, comparison: cleaned.replaceAll(" ", "") };
}
