import { NotReadyError } from "@pablosla/core-reader/domain/errors";
import type { ArtifactStore } from "../ports/artifact-store.js";
import { deriveFamilies, selectPowertrain } from "../../domain/powertrain.js";
import type { PartsInput, UnitSummary } from "../../domain/request.js";
import { readZipRecords } from "../renault/archive-records.js";

async function records(store: ArtifactStore, units: UnitSummary[], code: string): Promise<any[]> {
  const unit = units.find(item => item.queryCode === code && item.status === "completed" && item.fileName);
  if (!unit) throw new NotReadyError(`${code} has not been stored yet`, { code });
  return readZipRecords(await store.getBytes(store.objectKey(unit.path, unit.fileName!))) as any[];
}

/**
 * Families for the PR08 and PR03 exports: the REF05 powertrain rows that match the selected REF04 models (Access rules),
 * reduced to their distinct vehicle, engine, gearbox and battery families. Both archives are only read; they stay as stored.
 */
export async function deriveFamiliesUseCase(input: PartsInput, units: UnitSummary[], store: ArtifactStore): Promise<string[]> {
  const selected = new Set(input.modelIds);
  const models = (await records(store, units, "REF04")).filter(record => selected.has(String(record.modelId)));
  const powertrain = await records(store, units, "REF05");
  return deriveFamilies(selectPowertrain(powertrain, models));
}
