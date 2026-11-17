import { describe, expect, test } from "bun:test";
import { ConflictError, NotFoundError, NotReadyError, NotDownloadableError } from "@pablosla/core-reader/domain/errors";
import { RequestAbortedError } from "@pablosla/core-reader/shared/retry";
import { enqueueRequestUseCase } from "../src/application/use-cases/enqueue-request.js";
import { processUnitUseCase, errorCodeOf, type ProcessUnitDependencies } from "../src/application/use-cases/process-unit.js";
import { cancelRequestUseCase, finalizeCancelledRequest, requestLockPaths } from "../src/application/use-cases/cancel-request.js";
import { recoverRequests, resumeRequestUseCase } from "../src/application/use-cases/resume-request.js";
import { downloadArtifactUseCase } from "../src/application/use-cases/download-artifact.js";
import { listRequestsUseCase, matchesFilters } from "../src/application/use-cases/list-requests.js";
import { deriveFamiliesUseCase } from "../src/application/use-cases/derive-families.js";
import { extractUnit } from "../src/application/use-cases/extract-unit.js";
import { toRequestState, toRequestSummary, requestArtifacts } from "../src/interfaces/http/state-mapper.js";
import { requestJobId } from "../src/application/ports/request-queue.js";
import type { RenaultRequestState } from "../src/domain/request.js";
import { fakeRenault, jsonZip, memoryLocks, memoryQueue, memoryRepository, memoryStore } from "./helpers/fakes.js";

const now = new Date("2026-11-17T10:00:00Z");
const labourBody = { manufacturer: "RENAULT", language: "en", selection: { family: "X1310", format: "json.zip", range: "active" } };
const partsBody = { manufacturer: "DACIA", axCode: "5208", edition: "02/0", selection: { description: "Bigster", family: "X1310", modelIds: ["M1"], range: "active", exports: { REF01: false, REF02: false, REF03: false, PR05: false, PR06: false } } };

const models = [{ modelId: "M1", familyVehicle: "X13", bodyType: "SUV", engineType: "E1" }, { modelId: "M2", familyVehicle: "X99", bodyType: "SUV", engineType: "E1" }];
const powertrain = [{ familyVehicle: "X13", bodyType: "SUV", engineType: "E1", familyEngine: "ENG", familyGearbox: "GB" }, { familyVehicle: "X99", bodyType: "SUV", engineType: "E1", familyEngine: "OTHER" }];

function world(options: { families?: string[] } = {}) {
  const repo = memoryRepository();
  const queue = memoryQueue();
  const lockSet = memoryLocks();
  const memory = memoryStore();
  const renault = fakeRenault({ families: options.families ?? ["X1310", "X13", "ENG", "GB"], files: name => name.startsWith("ref04_") ? jsonZip(models) : name.startsWith("ref05_") ? jsonZip(powertrain) : new Uint8Array([9]) });
  const events: string[] = [];
  const flags = new Set<string>();
  let shuttingDown = false;
  const cancelDeps = { repository: repo.repository, queue: queue.queue, locks: lockSet.locks, flags: { request: async (id: string) => { flags.add(id); }, clear: async (id: string) => { flags.delete(id); } } };
  const processor = (override: Partial<ProcessUnitDependencies> = {}): ProcessUnitDependencies => ({
    state: { get: id => repo.repository.get(id), update: (id, patch, deleted) => repo.repository.patch(id, patch, deleted) },
    cancellation: { isRequested: async id => flags.has(id), finalize: id => finalizeCancelledRequest(id, cancelDeps) },
    worker: { isShuttingDown: () => shuttingDown },
    extract: (state, index, hooks) => extractUnit({ requestId: state.requestId, input: state.input, unit: state.units[index]!, families: state.families }, { api: renault.api, store: memory.store, pollIntervalMs: 1, timeoutMs: 1000, onStage: hooks.onStage }),
    families: state => deriveFamiliesUseCase(state.input as never, state.units, memory.store),
    queue: { next: job => queue.queue.enqueue(job) },
    locks: { releaseAll: state => lockSet.locks.release(requestLockPaths(state), state.requestId) },
    logger: { info: (event, data) => { events.push(`${event}${data?.unit ? `:${data.unit}` : ""}`); }, error: event => { events.push(`error:${event}`); } },
    ...override,
  });
  /** Runs queued jobs one after another, like a single worker. */
  async function drain(override: Partial<ProcessUnitDependencies> = {}) {
    for (let guard = 0; guard < 50; guard++) {
      const next = [...queue.jobs.values()].find(entry => entry.state === "pending");
      if (!next) return;
      next.state = "active";
      try { await processUnitUseCase(next.job, processor(override)); next.state = "completed"; } catch { next.state = "failed"; }
    }
    throw new Error("queue never drained");
  }
  const enqueue = (resource: "labours" | "parts", body: any) => enqueueRequestUseCase(resource, body, { repository: repo.repository, locks: lockSet.locks, queue: queue.queue, now: () => now });
  return { ...repo, ...queue, ...lockSet, ...memory, renault, events, flags, cancelDeps, processor, drain, enqueue, setShuttingDown: (value: boolean) => { shuttingDown = value; } };
}

describe("enqueue", () => {
  test("creates a queued request with its units, takes the lock and queues the first unit", async () => {
    const w = world();
    const requestId = await w.enqueue("labours", labourBody);
    const state = w.states.get(requestId)!;
    expect(state).toMatchObject({ resource: "labours", status: "queued", progress: 0, familiesPending: false });
    expect(state.units).toHaveLength(1);
    expect(w.jobs.get(state.queueJobId!)?.job).toEqual({ requestId, runId: state.runId!, index: 0 });
    expect(w.owners.get(state.units[0]!.path)).toBe(requestId);
  });

  test("an identical request is a conflict while the first one is active", async () => {
    const w = world();
    await w.enqueue("labours", labourBody);
    await expect(w.enqueue("labours", labourBody)).rejects.toBeInstanceOf(ConflictError);
    await expect(w.enqueue("labours", { ...labourBody, selection: { ...labourBody.selection, format: "csv" } })).resolves.toBeString();
  });

  test("validation errors create nothing", async () => {
    const w = world();
    await expect(w.enqueue("parts", { ...partsBody, axCode: undefined })).rejects.toThrow("axCode");
    expect(w.states.size).toBe(0);
    expect(w.owners.size).toBe(0);
  });

  test("rolls back the state and the lock when queueing fails", async () => {
    const w = world();
    const failing = { ...w.queue, enqueue: async () => { throw new Error("redis down"); } };
    await expect(enqueueRequestUseCase("labours", labourBody, { repository: w.repository, locks: w.locks, queue: failing, now: () => now })).rejects.toThrow("redis down");
    expect(w.states.size).toBe(0);
    expect(w.owners.size).toBe(0);
  });
});

describe("processing", () => {
  test("a labour request stores the raw export and manifest, then completes and frees the lock", async () => {
    const w = world();
    const requestId = await w.enqueue("labours", labourBody);
    await w.drain();
    const state = w.states.get(requestId)!;
    expect(state).toMatchObject({ status: "completed", progress: 100 });
    expect(state.units[0]).toMatchObject({ status: "completed", reused: false });
    expect([...w.objects.keys()].sort()).toEqual([`${state.units[0]!.path}/${state.units[0]!.fileName}`, `${state.units[0]!.path}/${state.units[0]!.unit}_completed.json`].sort());
    expect(w.owners.size).toBe(0);
  });

  test("a parts request extracts REF04 and REF05, derives the families from the stored archives and then asks PR08 and PR03 per family", async () => {
    const w = world();
    const requestId = await w.enqueue("parts", partsBody);
    await w.drain();
    const state = w.states.get(requestId)!;
    expect(state.status).toBe("completed");
    expect(state.families).toEqual(["X13", "ENG", "GB"]);
    expect(state.familiesPending).toBe(false);
    expect(state.units.map(unit => unit.unit)).toEqual(["REF04", "REF05", "PR08_X13", "PR08_ENG", "PR08_GB", "PR03_X13", "PR03_ENG", "PR03_GB"]);
    expect(state.units.every(unit => unit.status === "completed")).toBe(true);
    expect(w.renault.calls.launch).toBe(8);
    const manifests = [...w.objects.keys()].filter(key => key.endsWith("_completed.json"));
    expect(manifests).toHaveLength(8);
    expect(JSON.parse(String(w.objects.get(manifests.find(key => key.includes("PR03_ENG"))!))).details).toMatchObject({ families: ["X13", "ENG", "GB"], modelIds: ["M1"], family: "ENG" });
    expect(w.owners.size).toBe(0);
  });

  test("disabling PR08 and PR03 skips the family step", async () => {
    const w = world();
    const requestId = await w.enqueue("parts", { ...partsBody, selection: { ...partsBody.selection, exports: { ...partsBody.selection.exports, PR08: false, PR03: false } } });
    await w.drain();
    expect(w.states.get(requestId)).toMatchObject({ status: "completed", familiesPending: false });
    expect(w.states.get(requestId)!.units).toHaveLength(2);
  });

  test("a failure marks the unit and the request failed with the error code and frees the lock", async () => {
    const w = world({ families: ["OTHER"] });
    const requestId = await w.enqueue("labours", labourBody);
    await w.drain();
    const state = w.states.get(requestId)!;
    expect(state).toMatchObject({ status: "failed", stage: "failed", errorCode: "NOT_AVAILABLE" });
    expect(state.units[0]).toMatchObject({ status: "failed" });
    expect(w.owners.size).toBe(0);
  });

  test("a cancellation requested before the job runs finalizes it without calling Renault", async () => {
    const w = world();
    const requestId = await w.enqueue("labours", labourBody);
    w.flags.add(requestId);
    await w.drain();
    expect(w.states.get(requestId)!.status).toBe("cancelled");
    expect(w.renault.calls.applicability).toBe(0);
    expect(w.flags.has(requestId)).toBe(false);
  });

  test("a worker shutdown pauses the request instead of failing it", async () => {
    const w = world();
    const requestId = await w.enqueue("labours", labourBody);
    await w.drain({ extract: async () => { w.setShuttingDown(true); throw new RequestAbortedError(); } });
    expect(w.states.get(requestId)).toMatchObject({ status: "paused", stage: expect.stringContaining("paused") });
    expect(w.states.get(requestId)!.units[0]!.status).toBe("pending");
  });

  test("stale and finished jobs are skipped", async () => {
    const w = world();
    const requestId = await w.enqueue("labours", labourBody);
    const state = w.states.get(requestId)!;
    expect(await processUnitUseCase({ requestId, runId: "other-run", index: 0 }, w.processor())).toEqual({ kind: "skipped", reason: "stale" });
    expect(await processUnitUseCase({ requestId: "missing", runId: "r", index: 0 }, w.processor())).toEqual({ kind: "skipped", reason: "missing" });
    await w.drain();
    expect(await processUnitUseCase({ requestId, runId: state.runId!, index: 0 }, w.processor())).toEqual({ kind: "skipped", reason: "terminal" });
  });

  test("maps failures to core error codes", () => {
    expect(errorCodeOf(new NotFoundError("x"))).toBe("NOT_FOUND");
    expect(errorCodeOf(Object.assign(new Error("login"), { name: "TokenError" }))).toBe("UNAVAILABLE");
    expect(errorCodeOf(new Error("boom"))).toBe("INTERNAL_ERROR");
  });
});

describe("cancel, resume and recovery", () => {
  test("cancelling a queued request removes its job and frees the lock; files stay", async () => {
    const w = world();
    const requestId = await w.enqueue("labours", labourBody);
    const result = await cancelRequestUseCase(requestId, w.cancelDeps);
    expect(result).toEqual({ requestId, status: "cancelled" });
    expect(w.jobs.size).toBe(0);
    expect(w.owners.size).toBe(0);
    expect(w.states.get(requestId)!.status).toBe("cancelled");
  });

  test("cancelling an active job only asks it to stop", async () => {
    const w = world();
    const requestId = await w.enqueue("labours", labourBody);
    const [job] = w.jobs.values();
    job!.state = "active";
    expect(await cancelRequestUseCase(requestId, w.cancelDeps)).toEqual({ requestId, status: "cancelling" });
    expect(w.flags.has(requestId)).toBe(true);
  });

  test("a completed or unknown request cannot be cancelled", async () => {
    const w = world();
    const requestId = await w.enqueue("labours", labourBody);
    await w.drain();
    await expect(cancelRequestUseCase(requestId, w.cancelDeps)).rejects.toBeInstanceOf(ConflictError);
    await expect(cancelRequestUseCase("missing", w.cancelDeps)).rejects.toBeInstanceOf(NotFoundError);
  });

  test("resume restarts from the first incomplete unit and reuses what is stored", async () => {
    const w = world();
    const requestId = await w.enqueue("parts", partsBody);
    await w.drain({ extract: async (state, index, hooks) => {
      if (index === 1) throw new Error("boom");
      return extractUnit({ requestId, input: state.input, unit: state.units[index]!, families: state.families }, { api: w.renault.api, store: w.store, pollIntervalMs: 1, timeoutMs: 1000, onStage: hooks.onStage });
    } });
    expect(w.states.get(requestId)).toMatchObject({ status: "failed", error: expect.stringContaining("boom") });
    const launches = w.renault.calls.launch;
    const resumed = await resumeRequestUseCase(requestId, false, { repository: w.repository, queue: w.queue, locks: w.locks, isHeartbeatAlive: async () => false, queueName: "q" });
    expect(resumed).toMatchObject({ resumedAtUnit: "REF05" });
    expect(w.states.get(requestId)).toMatchObject({ status: "queued" });
    expect(w.states.get(requestId)!.error).toBeUndefined();
    await w.drain();
    expect(w.states.get(requestId)!.status).toBe("completed");
    expect(w.renault.calls.launch).toBe(launches + 7);
  });

  test("resume refuses completed, cancelled and live requests", async () => {
    const w = world();
    const deps = { repository: w.repository, queue: w.queue, locks: w.locks, isHeartbeatAlive: async () => true, queueName: "q" };
    const requestId = await w.enqueue("labours", labourBody);
    await w.drain();
    await expect(resumeRequestUseCase(requestId, false, deps)).rejects.toBeInstanceOf(ConflictError);
    const other = await w.enqueue("labours", { ...labourBody, selection: { ...labourBody.selection, format: "csv" } });
    await w.repository.patch(other, { status: "running" });
    w.jobs.clear();
    await expect(resumeRequestUseCase(other, false, deps)).rejects.toBeInstanceOf(ConflictError);
    await expect(resumeRequestUseCase("missing", false, deps)).rejects.toBeInstanceOf(NotFoundError);
  });

  test("startup recovery requeues orphans and finalizes cancellations", async () => {
    const w = world();
    const orphan = await w.enqueue("labours", labourBody);
    const cancelling = await w.enqueue("labours", { ...labourBody, selection: { ...labourBody.selection, format: "csv" } });
    await w.repository.patch(orphan, { status: "running" });
    await w.repository.patch(cancelling, { status: "cancelling" });
    w.jobs.clear();
    const result = await recoverRequests({ ...w.cancelDeps, isHeartbeatAlive: async () => true, queueName: "q", requestIds: async () => [...w.states.keys()], logger: { info() {}, error() {} } });
    expect(result).toEqual({ resumed: [orphan], cancelled: [cancelling] });
    expect(w.states.get(cancelling)!.status).toBe("cancelled");
    const requeued = w.states.get(orphan)!;
    expect(w.jobs.has(requestJobId({ requestId: orphan, runId: requeued.runId!, index: 0 }))).toBe(true);
  });
});

describe("artifacts, download and listing", () => {
  const locator = { bucket: "bucket", objectKey: (...parts: string[]) => ["pfx", ...parts].join("/") };

  async function completed(body: any, resource: "labours" | "parts") {
    const w = world();
    const requestId = await w.enqueue(resource, body);
    await w.drain();
    return { w, state: w.states.get(requestId)!, requestId };
  }

  test("a labour request exposes its raw export as the primary artifact next to the manifest", async () => {
    const { state } = await completed(labourBody, "labours");
    const artifacts = requestArtifacts(state, locator);
    expect(artifacts.map(artifact => [artifact.kind, artifact.primary])).toEqual([["prefix", false], ["file", true], ["file", false]]);
    expect(artifacts[0]!.location).toEqual({ bucket: "bucket", key: `pfx/${state.units[0]!.path}` });
    const mapped = toRequestState(state, locator, { stalled: false });
    expect(mapped).toMatchObject({ reader: "renault", resource: "labours", status: "completed", progress: 100, error: null, request: { manufacturer: "RENAULT", language: "en", selection: { family: "X1310", format: "json.zip", range: "active" } } });
    expect(toRequestSummary(state, locator).artifactCount).toBe(3);
  });

  test("a failed request carries its error code", async () => {
    const w = world({ families: ["OTHER"] });
    const requestId = await w.enqueue("labours", labourBody);
    await w.drain();
    expect(toRequestState(w.states.get(requestId)!, locator).error).toMatchObject({ code: "NOT_AVAILABLE" });
  });

  test("downloads the primary file or a named artifact and refuses prefixes and unknown names", async () => {
    const { w, state, requestId } = await completed(labourBody, "labours");
    const deps = { ...locator, getState: async (id: string) => w.states.get(id) ?? null, exists: async (key: string) => w.objects.has(key.replace(/^pfx\//, "")), signDownload: async (key: string, filename?: string) => `https://signed/${key}?name=${filename}` };
    expect(await downloadArtifactUseCase("labours", requestId, undefined, deps)).toBe(`https://signed/pfx/${state.units[0]!.path}/${state.units[0]!.fileName}?name=${state.units[0]!.fileName}`);
    expect(await downloadArtifactUseCase("labours", requestId, `${state.units[0]!.unit}_completed.json`, deps)).toContain("_completed.json");
    await expect(downloadArtifactUseCase("labours", requestId, state.units[0]!.unit, deps)).rejects.toBeInstanceOf(NotDownloadableError);
    await expect(downloadArtifactUseCase("labours", requestId, "nope", deps)).rejects.toBeInstanceOf(NotFoundError);
    await expect(downloadArtifactUseCase("parts", requestId, undefined, deps)).rejects.toBeInstanceOf(NotFoundError);
  });

  test("parts have no primary artifact", async () => {
    const { w, requestId } = await completed(partsBody, "parts");
    const deps = { ...locator, getState: async (id: string) => w.states.get(id) ?? null, exists: async () => true, signDownload: async (key: string) => key };
    await expect(downloadArtifactUseCase("parts", requestId, undefined, deps)).rejects.toBeInstanceOf(NotReadyError);
    expect(await downloadArtifactUseCase("parts", requestId, "REF04_completed.json", deps)).toContain("REF04_completed.json");
  });

  test("lists one resource at a time with filters", async () => {
    const w = world();
    await w.enqueue("labours", labourBody);
    const parts = await w.enqueue("parts", partsBody);
    const states = [...w.states.values()];
    const dependencies = (resource: string) => ({
      ensureIndex: async () => undefined,
      fetchRequestIds: async () => states.filter(state => state.resource === resource).map(state => state.requestId),
      fetchStates: async (ids: string[]) => ids.map(id => w.states.get(id) ?? null),
      removeMissing: async () => undefined, pruneExpired: async () => undefined, ttlMs: 1e12, now: () => now.getTime(),
    });
    const page = await listRequestsUseCase("parts", { manufacturer: "dacia", axCode: "5208", edition: "02/0", status: ["queued"] }, undefined, 10, dependencies("parts"));
    expect(page.items.map(state => state.requestId)).toEqual([parts]);
    expect(matchesFilters(states[0] as RenaultRequestState, { status: ["failed"] })).toBe(false);
  });
});
