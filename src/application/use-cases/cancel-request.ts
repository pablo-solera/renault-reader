import { ConflictError, NotFoundError } from "@pablosla/core-reader/domain/errors";
import type { RequestRepository } from "../ports/request-repository.js";
import { isQueueJobPending, type RequestQueue } from "../ports/request-queue.js";
import type { ScopeLocks } from "../ports/scope-locks.js";
import { lockPaths } from "../../domain/units.js";
import type { RenaultRequestState } from "../../domain/request.js";

export type CancelRequestDependencies = {
  repository: RequestRepository;
  queue: RequestQueue;
  locks: ScopeLocks;
  flags: { request(requestId: string): Promise<void>; clear(requestId: string): Promise<void> };
  logger?: { info(event: string, data?: Record<string, unknown>): void };
};

export const requestLockPaths = (state: RenaultRequestState) => lockPaths(state.input, state.units);

/** Ends a cancelled request. Files already downloaded stay in S3: a later request reuses them through their manifest. */
export async function finalizeCancelledRequest(requestId: string, dependencies: CancelRequestDependencies) {
  const state = await dependencies.repository.get(requestId);
  if (!state) return;
  await dependencies.repository.patch(requestId, { status: "cancelled", stage: "cancelled" });
  await dependencies.locks.release(requestLockPaths(state), requestId);
  await dependencies.flags.clear(requestId);
  dependencies.logger?.info("extraction_cancelled", { requestId });
}

export async function cancelRequestUseCase(requestId: string, dependencies: CancelRequestDependencies): Promise<{ requestId: string; status: "cancelled" | "cancelling" }> {
  const state = await dependencies.repository.get(requestId);
  if (!state) throw new NotFoundError("Request not found", { requestId });
  if (state.status === "completed") throw new ConflictError("A completed request cannot be cancelled", { status: state.status });
  if (state.status === "cancelled" || state.status === "cancelling") return { requestId, status: state.status };

  await dependencies.flags.request(requestId);
  await dependencies.repository.patch(requestId, { status: "cancelling", stage: "cancelling" });
  const job = state.queueJobId ? await dependencies.queue.getJob(state.queueJobId) : null;
  if (job?.state === "active") return { requestId, status: "cancelling" };
  if (job && isQueueJobPending(job.state) || job?.state === "failed") await dependencies.queue.remove(job.id);
  const afterRemoval = state.queueJobId ? await dependencies.queue.getJob(state.queueJobId) : null;
  if (afterRemoval?.state === "active") return { requestId, status: "cancelling" };
  await finalizeCancelledRequest(requestId, dependencies);
  return { requestId, status: "cancelled" };
}
