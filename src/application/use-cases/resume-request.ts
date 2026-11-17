import { randomUUID } from "node:crypto";
import { ConflictError, NotFoundError } from "@pablosla/core-reader/domain/errors";
import type { RequestRepository } from "../ports/request-repository.js";
import { isQueueJobPending, type RequestQueue } from "../ports/request-queue.js";
import type { ScopeLocks } from "../ports/scope-locks.js";
import { resumableUnitIndex } from "../../domain/progress.js";
import { finalizeCancelledRequest, requestLockPaths, type CancelRequestDependencies } from "./cancel-request.js";

export type ResumeRequestDependencies = {
  repository: RequestRepository;
  queue: RequestQueue;
  locks: ScopeLocks;
  isHeartbeatAlive(requestId: string): Promise<boolean>;
  queueName: string;
};

const RESUMABLE = new Set(["failed", "running", "queued", "paused"]);

/**
 * Requeues the request from its first incomplete unit. Stored units carry a manifest, so running them again
 * reuses the file without calling Renault. `startupRecovery` skips the live-heartbeat guard: after a crash the old heartbeat can outlive the process.
 */
export async function resumeRequestUseCase(requestId: string, force: boolean, dependencies: ResumeRequestDependencies, options: { startupRecovery?: boolean } = {}) {
  const state = await dependencies.repository.get(requestId);
  if (!state) throw new NotFoundError("Request not found", { requestId });
  if (state.status === "cancelled" || state.status === "cancelling") throw new ConflictError("A cancelled request cannot be resumed", { status: state.status });
  if (!RESUMABLE.has(state.status)) throw new ConflictError("Only failed, paused or interrupted requests can be resumed", { status: state.status });
  if (state.status === "running" && !force && !options.startupRecovery && await dependencies.isHeartbeatAlive(requestId)) throw new ConflictError("The request is running", { status: state.status });

  const job = state.queueJobId ? await dependencies.queue.getJob(state.queueJobId) : null;
  if (job && isQueueJobPending(job.state)) throw new ConflictError("The request already has a queued or active job", { queueJobId: job.id, state: job.state });
  if (job) await dependencies.queue.remove(job.id);

  const first = resumableUnitIndex(state.units);
  if (first >= state.units.length && !state.familiesPending) throw new ConflictError("Every unit is already completed", { status: state.status });
  // With every known unit stored but the families still to derive, the last unit runs again (reused) so the derivation follows.
  const index = Math.min(first, state.units.length - 1);
  const paths = requestLockPaths(state);
  const claim = await dependencies.locks.claim(paths, requestId);
  if (!claim.ok) throw new ConflictError("Another extraction already uses this folder", { path: claim.path });

  const runId = randomUUID();
  const unit = state.units[index]!;
  try {
    const queueJobId = await dependencies.queue.enqueue({ requestId, runId, index });
    await dependencies.repository.patch(requestId, { status: "queued", stage: `${unit.unit}:queued`, runId, queueJobId }, ["error", "errorCode"]);
  } catch (error) {
    await dependencies.locks.release(paths, requestId).catch(() => undefined);
    throw error;
  }
  return { requestId, resumedAtUnit: unit.unit, queue: dependencies.queueName };
}

export type RecoverDependencies = ResumeRequestDependencies & CancelRequestDependencies & {
  requestIds(): Promise<string[]>;
  logger: { info(event: string, data?: Record<string, unknown>): void; error(event: string, data?: Record<string, unknown>): void };
};

const INTERRUPTED = new Set(["queued", "running", "paused"]);

/** On worker start: finalize cancellations the old worker never finished and requeue requests whose job was lost. */
export async function recoverRequests(dependencies: RecoverDependencies) {
  const recovered = { resumed: [] as string[], cancelled: [] as string[] };
  for (const requestId of await dependencies.requestIds()) {
    const state = await dependencies.repository.get(requestId);
    if (!state) continue;
    const job = state.queueJobId ? await dependencies.queue.getJob(state.queueJobId) : null;
    try {
      if (state.status === "cancelling" && job?.state !== "active") { await finalizeCancelledRequest(requestId, dependencies); recovered.cancelled.push(requestId); }
      else if (INTERRUPTED.has(state.status) && !isQueueJobPending(job?.state)) { await resumeRequestUseCase(requestId, false, dependencies, { startupRecovery: true }); recovered.resumed.push(requestId); }
    } catch (error) {
      dependencies.logger.error("orphan_job_recovery_skipped", { requestId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return recovered;
}
