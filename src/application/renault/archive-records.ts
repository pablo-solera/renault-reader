import { unzipSync } from "fflate";

function recordsFromValue(value: any): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    for (const key of ["responseData", "data", "items", "records", "rows"]) {
      if (Array.isArray(value[key])) return value[key];
    }
  }
  return value && typeof value === "object" ? [value] : [];
}

/** Reads the JSON records of a Renault ZIP export, only to decide what else to extract; the stored archive is never modified. */
export function readZipRecords(bytes: Uint8Array): unknown[] {
  const records: unknown[] = [];
  for (const [name, content] of Object.entries(unzipSync(bytes))) {
    if (!/\.json$/i.test(name)) continue;
    try {
      records.push(...recordsFromValue(JSON.parse(new TextDecoder().decode(content))));
    } catch {
      // Some Renault archives include auxiliary JSON fragments that are not records.
    }
  }
  return records;
}
