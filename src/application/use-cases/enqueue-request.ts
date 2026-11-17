import { randomUUID } from "node:crypto";
import { ConflictError } from "@pablosla/core-reader/domain/errors";
import type { CreateRequest } from "@pablosla/core-reader/contract/v1";
import type { RequestRepository } from "../ports/request-repository.js";
import type { ScopeLocks } from "../ports/scope-locks.js";
import type { RequestQueue } from "../ports/request-queue.js";
import type { RenaultRequestState, Resource } from "../../domain/request.js";
import { validateLabourInput, validatePartsInput } from "../../domain/validation.js";
import { initialUnits, lockPaths, needsFamilies } from "../../domain/units.js";

export type EnqueueRequestDependencies = {
  repository: RequestRepository;
  locks: ScopeLocks;
  queue: RequestQueue;
  now?: () => Date;
  newId?: () => string;
};

/** Creates the request: validate, lock the S3 folders, persist, then queue the first unit. Rolls back on failure. */
export async function enqueueRequestUseCase(resource: Resource, raw: CreateRequest, dependencies: EnqueueRequestDependencies): Promise<string> {
  const now = dependencies.now ?? (() => new Date());
  const input = resource === "labours" ? validateLabourInput(raw, now()) : validatePartsInput(raw, now());
  const requestId = (dependencies.newId ?? randomUUID)();
  const units = initialUnits(input);
  const paths = lockPaths(input, units);

  const claim = await dependencies.locks.claim(paths, requestId);
  if (!claim.ok) throw new ConflictError("Another extraction already uses this folder", { path: claim.path });

  const timestamp = now().toISOString();
  const runId = randomUUID();
  const state: RenaultRequestState = {
    requestId, resource, status: "queued", stage: "queued", progress: 0, input, units, runId,
    familiesPending: input.resource === "parts" && needsFamilies(input),
    createdAt: timestamp, updatedAt: timestamp,
  };
  try {
    await dependencies.repository.create(state);
    const queueJobId = await dependencies.queue.enqueue({ requestId, runId, index: 0 });
    await dependencies.repository.patch(requestId, { queueJobId });
  } catch (error) {
    await dependencies.repository.remove(requestId).catch(() => undefined);
    await dependencies.locks.release(paths, requestId).catch(() => undefined);
    throw error;
  }
  return requestId;
}
