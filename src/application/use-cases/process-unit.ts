import { applicationErrorCodes, type ApplicationErrorCode } from "@pablosla/core-reader/domain/errors";
import { RequestAbortedError } from "@pablosla/core-reader/shared/retry";
import type { RenaultRequestState, UnitSummary } from "../../domain/request.js";
import { familyUnits } from "../../domain/units.js";
import { requestProgress } from "../../domain/progress.js";
import type { RequestJob } from "../ports/request-queue.js";
import type { ExtractUnitResult } from "./extract-unit.js";

export type ProcessUnitDependencies = {
  state: {
    get(requestId: string): Promise<RenaultRequestState | null>;
    update(requestId: string, patch: Partial<RenaultRequestState>, deletedKeys?: string[]): Promise<RenaultRequestState | null>;
  };
  cancellation: { isRequested(requestId: string): Promise<boolean>; finalize(requestId: string): Promise<unknown> };
  worker: { isShuttingDown(): boolean };
  extract(state: RenaultRequestState, index: number, hooks: { onStage(stage: string, details?: { remoteRequestId?: string; fileName?: string }): Promise<void> }): Promise<ExtractUnitResult>;
  families(state: RenaultRequestState): Promise<string[]>;
  queue: { next(job: RequestJob): Promise<string> };
  locks: { releaseAll(state: RenaultRequestState): Promise<void> };
  logger: { info(event: string, data?: Record<string, unknown>): void; error(event: string, data?: Record<string, unknown>): void };
};

export type ProcessResult =
  | { kind: "skipped"; reason: "missing" | "terminal" | "stale" }
  | { kind: "cancelled" }
  | { kind: "paused"; unit: string }
  | { kind: "unit"; unit: string; next: string }
  | { kind: "completed" };

const TERMINAL = new Set(["completed", "cancelled"]);
const withUnit = (units: UnitSummary[], index: number, patch: Partial<UnitSummary>) => units.map((unit, i) => i === index ? { ...unit, ...patch } : unit);
const messageOf = (error: unknown) => error instanceof Error ? `${error.name}: ${error.message}` : String(error);

export function errorCodeOf(error: unknown): ApplicationErrorCode {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  if (typeof error === "object" && error !== null && (error as { name?: unknown }).name === "TokenError") return "UNAVAILABLE";
  return (applicationErrorCodes as readonly unknown[]).includes(code) ? code as ApplicationErrorCode : "INTERNAL_ERROR";
}

/** Runs one BullMQ job: one Renault export. Chains the next unit's job, derives the PR08/PR03 units after REF04 and REF05, or completes the request. */
export async function processUnitUseCase(data: RequestJob, dependencies: ProcessUnitDependencies): Promise<ProcessResult> {
  const { requestId, index, runId } = data;
  const state = await dependencies.state.get(requestId);
  if (!state) return { kind: "skipped", reason: "missing" };
  if (TERMINAL.has(state.status)) return { kind: "skipped", reason: "terminal" };
  if (state.runId !== runId) return { kind: "skipped", reason: "stale" };
  const unit = state.units[index];
  if (!unit) throw new Error(`Missing unit at index ${index}`);

  const cancelled = async (): Promise<ProcessResult> => { await dependencies.cancellation.finalize(requestId); return { kind: "cancelled" }; };
  if (await dependencies.cancellation.isRequested(requestId)) return cancelled();

  await dependencies.state.update(requestId, { status: "running", stage: `${unit.unit}:starting`, units: withUnit(state.units, index, { status: "running" }) });
  let chain: Promise<unknown> = Promise.resolve();
  const onStage = (stage: string, details?: { remoteRequestId?: string; fileName?: string }) => {
    const update = chain.then(async () => {
      const current = await dependencies.state.get(requestId);
      if (!current || TERMINAL.has(current.status)) return;
      const cancelling = await dependencies.cancellation.isRequested(requestId);
      await dependencies.state.update(requestId, {
        status: cancelling ? "cancelling" : "running", stage: `${unit.unit}:${cancelling ? "cancelling" : stage}`,
        ...(details?.fileName ? { units: withUnit(current.units, index, { fileName: details.fileName }) } : {}),
      });
    });
    chain = update.catch(() => undefined);
    return update;
  };

  try {
    const result = await dependencies.extract(state, index, { onStage });
    await chain;
    if (await dependencies.cancellation.isRequested(requestId)) return cancelled();
    const current = (await dependencies.state.get(requestId)) ?? state;
    let units = withUnit(current.units, index, { status: "completed", fileName: result.fileName, reused: result.reused, remoteStatus: result.remoteStatus, error: undefined });
    dependencies.logger.info("unit_completed", { requestId, unit: unit.unit, reused: result.reused, remoteStatus: result.remoteStatus });

    let families = current.families;
    let familiesPending = current.familiesPending;
    if (index + 1 >= units.length && familiesPending && current.input.resource === "parts") {
      families = await dependencies.families({ ...current, units });
      units = [...units, ...familyUnits(current.input, families)];
      familiesPending = false;
      dependencies.logger.info("families_derived", { requestId, families });
    }
    const progress = requestProgress(units, current.progress);
    if (index + 1 < units.length) {
      // The finished unit is persisted before the next job is queued: that job reads the state as soon as it starts.
      await dependencies.state.update(requestId, { status: "running", stage: `${unit.unit}:completed`, progress, units, families, familiesPending });
      const queueJobId = await dependencies.queue.next({ requestId, runId, index: index + 1 });
      await dependencies.state.update(requestId, { queueJobId });
      return { kind: "unit", unit: unit.unit, next: units[index + 1]!.unit };
    }
    await dependencies.state.update(requestId, { status: "completed", stage: "completed", progress: 100, units, families, familiesPending, error: undefined, errorCode: undefined });
    await dependencies.locks.releaseAll(state);
    dependencies.logger.info("extraction_completed", { requestId, units: units.length });
    return { kind: "completed" };
  } catch (error) {
    if (await dependencies.cancellation.isRequested(requestId)) return cancelled();
    if (error instanceof RequestAbortedError && dependencies.worker.isShuttingDown()) {
      const current = (await dependencies.state.get(requestId)) ?? state;
      await dependencies.state.update(requestId, { status: "paused", stage: `${unit.unit}:paused`, units: withUnit(current.units, index, { status: "pending" }) });
      dependencies.logger.info("extraction_paused", { requestId, unit: unit.unit });
      return { kind: "paused", unit: unit.unit };
    }
    const current = (await dependencies.state.get(requestId)) ?? state;
    await dependencies.state.update(requestId, {
      status: "failed", stage: "failed", error: messageOf(error), errorCode: errorCodeOf(error),
      units: withUnit(current.units, index, { status: "failed", error: messageOf(error) }),
    });
    await dependencies.locks.releaseAll(state);
    dependencies.logger.error("unit_failed", { requestId, unit: unit.unit, error: messageOf(error) });
    throw error;
  }
}
