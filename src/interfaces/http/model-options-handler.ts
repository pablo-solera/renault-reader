import { z } from "zod";
import { modelOptionsSchema } from "@pablosla/core-reader/contract/v1";
import { PARTS_EXPORT_CODES, LABOUR_QUERY_CODE } from "../../domain/exports.js";
import type { ModelOptionsQuery } from "../../application/use-cases/get-model-options.js";

const modelOptionsQuerySchema = z.object({
  manufacturer: z.string().min(1).optional(),
  range: z.enum(["active", "old", "future"]).default("active"),
  exportType: z.enum([LABOUR_QUERY_CODE, ...PARTS_EXPORT_CODES]).default(LABOUR_QUERY_CODE),
  includeRaw: z.enum(["true", "false"]).default("false").transform(value => value === "true"),
});

/** Parses the raw query (unknown keys are dropped, repeated parameters are rejected) and validates the result against the shared contract. */
export function createModelOptionsHandler(build: (query: ModelOptionsQuery) => Promise<unknown>) {
  return async (query: Record<string, unknown>) => modelOptionsSchema.parse(await build(modelOptionsQuerySchema.parse(query)));
}
