import { z } from "zod";
import { ValidationError } from "@pablosla/core-reader/domain/errors";
import type { CreateRequest } from "@pablosla/core-reader/contract/v1";
import { PARTS_EXPORT_CODES } from "./exports.js";
import { normalizeAxCode, normalizeEdition, normalizeManufacturer, yyyymmdd } from "./normalize.js";
import type { LabourInput, PartsInput } from "./request.js";

const text = z.string().trim().min(1);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "publishedAfter must use YYYY-MM-DD");

export const labourSelectionSchema = z.object({
  family: text,
  format: text,
  range: text,
  publishedAfter: isoDate.optional(),
}).strict();

const exportSwitchesSchema = z.object(Object.fromEntries(PARTS_EXPORT_CODES.map(code => [code, z.boolean().optional()]))).strict();

export const partsSelectionSchema = z.object({
  description: text,
  family: text,
  modelIds: z.array(text).min(1),
  range: text,
  format: text.optional(),
  exports: exportSwitchesSchema.optional(),
}).strict();

const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) throw new ValidationError(result.error.issues.map(issue => `${issue.path.join(".") || "selection"}: ${issue.message}`).join("; "));
  return result.data;
};

function manufacturerOf(raw: CreateRequest) {
  const manufacturer = normalizeManufacturer(raw.manufacturer);
  if (!manufacturer) throw new ValidationError("manufacturer is required");
  return manufacturer;
}

function editionOf(value: string | undefined) {
  if (value === undefined) return undefined;
  try { return normalizeEdition(value); } catch (error) { throw new ValidationError(error instanceof Error ? error.message : "Invalid edition"); }
}

const languageOf = (value: string | undefined) => value?.trim().toLowerCase() || undefined;

export function validateLabourInput(raw: CreateRequest, now: Date = new Date()): LabourInput {
  const selection = parse(labourSelectionSchema, raw.selection);
  const language = languageOf(raw.language);
  if (!language) throw new ValidationError("language is required for labours");
  return {
    resource: "labours", manufacturer: manufacturerOf(raw), date: yyyymmdd(now), language,
    ...(raw.axCode ? { axCode: normalizeAxCode(raw.axCode) } : {}),
    ...(raw.edition ? { edition: editionOf(raw.edition) } : {}),
    family: selection.family, format: selection.format, range: selection.range,
    ...(selection.publishedAfter ? { publishedAfter: selection.publishedAfter } : {}),
  };
}

export function validatePartsInput(raw: CreateRequest, now: Date = new Date()): PartsInput {
  const selection = parse(partsSelectionSchema, raw.selection);
  if (!raw.axCode) throw new ValidationError("axCode is required for parts");
  if (!raw.edition) throw new ValidationError("edition is required for parts");
  const axCode = normalizeAxCode(raw.axCode);
  if (!/^.{3,4}$/.test(axCode)) throw new ValidationError("axCode must contain 3 to 4 characters");
  const language = languageOf(raw.language);
  return {
    resource: "parts", manufacturer: manufacturerOf(raw), date: yyyymmdd(now), axCode, edition: editionOf(raw.edition)!,
    ...(language ? { language } : {}),
    description: selection.description, family: selection.family, modelIds: selection.modelIds, range: selection.range,
    ...(selection.format ? { format: selection.format } : {}),
    ...(selection.exports ? { exports: selection.exports } : {}),
  };
}
