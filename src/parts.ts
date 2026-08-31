import { createHash } from "node:crypto";
import { zipSync, unzipSync, strToU8 } from "fflate";
import ExcelJS from "exceljs";
import type { PartsExportCode } from "./types.js";
import { config } from "./config.js";

export type ParsedParts = {
  exportType: PartsExportCode;
  files: string[];
  records: unknown[];
  images: Array<{ name: string; md5: string }>;
};

export function currentEpc(date = new Date()): string {
  return `${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getFullYear()).slice(-2)}`;
}

export function normalizeAxCode(value: string): string {
  return value.replaceAll(" ", "");
}

export function normalizeEdition(value: string): string {
  const edition = value.toUpperCase().replaceAll(" ", "");
  if (!/^\d{2}\/\d$/.test(edition)) throw new Error("La edición de IMC tiene que seguir el formato 01/0");
  return edition;
}

export function normalizeDescription(value: string): string {
  return value.replaceAll(" ", "").replaceAll("&", "_").replaceAll("/", "-").replaceAll("%", "_");
}

export function normalizeManufacturer(value: string): string {
  return value.replaceAll("BRAND", "").replaceAll("TRUCKS", "").trim();
}

export function preprocessModelVehicleRecords(records: unknown[], modelIds?: string[], manufacturerDescription?: string) {
  const selected = modelIds?.length ? new Set(modelIds) : undefined;
  return (records as any[])
    .filter((record) => !selected || selected.has(String(record.modelId)))
    .map((record) => {
      const code = String(record.manufacturerCode ?? record.manufacturer ?? "");
      return { ...record, manufacturerCode: code, manufacturer: manufacturerDescription ?? config.manufacturerDescriptions[code] ?? code };
    });
}

function recordsFromValue(value: any): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    for (const key of ["responseData", "data", "items", "records", "rows"]) {
      if (Array.isArray(value[key])) return value[key];
    }
  }
  return value && typeof value === "object" ? [value] : [];
}

function parseJsonFiles(files: Record<string, Uint8Array>) {
  const records: unknown[] = [];
  for (const [name, bytes] of Object.entries(files)) {
    if (!/\.json$/i.test(name)) continue;
    try {
      records.push(...recordsFromValue(JSON.parse(new TextDecoder().decode(bytes))));
    } catch {
      // Some Renault archives include auxiliary JSON fragments that are not records.
    }
  }
  return records;
}

function parseTar(bytes: Uint8Array): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const name = new TextDecoder().decode(header.subarray(0, 100)).replace(/\0.*$/, "");
    const sizeText = new TextDecoder().decode(header.subarray(124, 136)).replace(/\0.*$/, "").trim();
    const size = Number.parseInt(sizeText || "0", 8);
    const start = offset + 512;
    files[name] = bytes.slice(start, start + size);
    offset = start + Math.ceil(size / 512) * 512;
  }
  return files;
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Response(bytes.slice().buffer as ArrayBuffer).body!.pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function parsePartsArchive(exportType: PartsExportCode, bytes: Uint8Array): Promise<ParsedParts> {
  let archiveBytes = bytes;
  if (exportType === "PR03" && bytes[0] === 0x1f && bytes[1] === 0x8b) archiveBytes = await gunzip(bytes);
  const files = exportType === "PR03" ? parseTar(archiveBytes) : unzipSync(bytes);
  const names = Object.keys(files);
  const images = exportType === "PR03"
    ? names.filter((name) => !name.endsWith("/")).map((name) => ({ name, md5: createHash("md5").update(files[name]).digest("hex") }))
    : [];
  return { exportType, files: names, records: parseJsonFiles(files), images };
}

export function structuredBytes(parsed: ParsedParts, metadata: Record<string, unknown>): Uint8Array {
  return strToU8(JSON.stringify({ ...metadata, ...parsed }));
}

export function compareImageHashes(current: ParsedParts, previous: ParsedParts) {
  const old = new Set(previous.images.map((image) => `${image.name}:${image.md5}`));
  const next = new Set(current.images.map((image) => `${image.name}:${image.md5}`));
  return {
    newImages: current.images.filter((image) => !old.has(`${image.name}:${image.md5}`)),
    deletedImages: previous.images.filter((image) => !next.has(`${image.name}:${image.md5}`)),
  };
}

function cleanApplicability(value: unknown): string {
  if (value == null) return "";
  return String(value).split("\r\n").map((line) => line.trim()).filter(Boolean).join("\n");
}

export function preprocessCatalogRecords(records: unknown[], treeRecords: unknown[] = [], language = "EN") {
  const labels = new Map<string, string>();
  for (const item of treeRecords as any[]) {
    if (item?.nodeId) labels.set(String(item.nodeId), String(item[`label${language.toUpperCase()}`] ?? item.labelEN ?? item.nodeId));
  }
  return (records as any[]).map((record) => {
    const nodes = String(record.nodes ?? "").split(",").map((node) => node.trim()).filter(Boolean);
    const navigationPath = nodes.map((node) => labels.get(node) ?? node).join(" > ");
    return {
      ...record,
      navigation_path: record.navigation_path ?? navigationPath,
      sectionApplicabilityCleaned: cleanApplicability(record.sectionApplicability),
      partsApplicabilityCleaned: cleanApplicability(record.partsApplicability),
    };
  });
}

export function compareCatalogRecords(current: unknown[], previous: unknown[]) {
  const result = (current as any[]).map((record) => {
    const candidates = (previous as any[]).filter((item) => item.plateId === record.plateId);
    const old = candidates.find((item) => item.hotSpotNumber === record.hotSpotNumber);
    if (!old) return { ...record, typeCompare: "PartNumberNoFound", compare: 0 };
    let typeCompare = "";
    if (record.illustrationFile !== old.illustrationFile) typeCompare = "Illustration";
    else if (record.partNumber !== old.partNumber) typeCompare = "PartNumberCode";
    else if (record.partsApplicabilityCleaned !== old.partsApplicabilityCleaned || record.partCodifiedSigns !== old.partCodifiedSigns) typeCompare = "PartsApplicability";
    else if (record.latestReplacementPart !== old.latestReplacementPart) typeCompare = "Replacement";
    else if (record.sectionApplicabilityCleaned !== old.sectionApplicabilityCleaned) typeCompare = "SectionApplicability";
    else if (record.designationEN !== old.designationEN) typeCompare = "PartsDescription";
    else if (record.additionalParts !== old.additionalParts) typeCompare = "AdditionalParts";
    else if (record.partKitList !== old.partKitList) typeCompare = "PartKitList";
    return { ...record, typeCompare, compare: typeCompare ? 0 : 1 };
  });
  const currentKeys = new Set((current as any[]).map((item) => `${item.plateId}:${item.hotSpotNumber}`));
  const deleted = (previous as any[]).filter((item) => !currentKeys.has(`${item.plateId}:${item.hotSpotNumber}`)).map((item) => ({ ...item, typeCompare: "DeletedPartNumber", compare: 0 }));
  return { records: result, deleted };
}

function tapvRow(record: any): Record<string, unknown> {
  return {
    TAPV: record.TAPV ?? record["?TAPV"] ?? record.tapv,
    familyVehicle: record.familyVehicle,
    bodyType: record.bodyType,
    engineLevel: record.engineLevel,
    familyEngine: record.familyEngine,
    engineType: record.engineType,
    engineIndex: record.engineIndex,
    familyGearbox: record.familyGearbox,
    gearboxType: record.gearboxType,
    gearboxIndex: record.gearboxIndex,
    familyBattery: record.familyBattery,
    batteryType: record.batteryType,
    batteryIndex: record.batteryIndex,
  };
}

export function compareTapv(current: unknown[], previous: unknown[]) {
  const key = (value: unknown) => JSON.stringify(tapvRow(value));
  const previousKeys = new Set(previous.map(key));
  const currentKeys = new Set(current.map(key));
  return {
    current: current.map(tapvRow),
    newRows: current.filter((row) => !previousKeys.has(key(row))).map(tapvRow),
    deletedRows: previous.filter((row) => !currentKeys.has(key(row))).map(tapvRow),
  };
}

export async function buildTapvWorkbook(current: unknown[], previous?: unknown[]): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  const comparison = previous ? compareTapv(current, previous) : { current: current.map(tapvRow), newRows: [], deletedRows: [] };
  const addSheet = (name: string, rows: Record<string, unknown>[]) => {
    const sheet = workbook.addWorksheet(name);
    const columns = ["TAPV", "familyVehicle", "bodyType", "engineLevel", "familyEngine", "engineType", "engineIndex", "familyGearbox", "gearboxType", "gearboxIndex", "familyBattery", "batteryType", "batteryIndex"];
    sheet.columns = columns.map((key) => ({ header: key, key, width: Math.max(14, key.length + 2) }));
    for (const row of rows) sheet.addRow(row);
    const header = sheet.getRow(1);
    header.font = { name: "Arial", bold: true, color: { argb: "FFFFFFFF" } };
    header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4472C4" } };
    header.alignment = { horizontal: "center", vertical: "middle" };
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    for (const column of sheet.columns) {
      if (!column) continue;
      let width = column.width ?? 14;
      column.eachCell?.({ includeEmpty: false }, (cell) => { width = Math.min(60, Math.max(width, String(cell.value ?? "").length + 2)); });
      column.width = width;
    }
  };
  addSheet("Powertrain", comparison.current);
  if (previous) {
    addSheet("New", comparison.newRows);
    addSheet("Deleted", comparison.deletedRows);
  }
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

export function buildReportZip(fileName: string, workbook: Uint8Array, structured: Uint8Array): Uint8Array {
  return zipSync({ [fileName]: workbook, "structured.json": structured }, { level: 6 });
}
