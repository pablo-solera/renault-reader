import { zipSync, strToU8 } from "fflate";
import type { ArtifactStore } from "../../src/application/ports/artifact-store.js";
import type { RenaultApi } from "../../src/application/ports/renault-api.js";
import type { RequestRepository } from "../../src/application/ports/request-repository.js";
import type { ScopeLocks } from "../../src/application/ports/scope-locks.js";
import { requestJobId, type QueueJobState, type RequestJob, type RequestQueue } from "../../src/application/ports/request-queue.js";
import type { Json } from "../../src/domain/renault-query.js";
import type { RenaultRequestState } from "../../src/domain/request.js";

export function memoryStore(prefix = "") {
  const objects = new Map<string, Uint8Array | string>();
  const order: string[] = [];
  const store: ArtifactStore = {
    objectKey: (...parts) => [prefix, ...parts].filter(Boolean).join("/"),
    putObject: async (key, body) => { objects.set(key, body); order.push(key); },
    putJson: async (key, value) => { objects.set(key, JSON.stringify(value)); order.push(key); },
    getJsonIfExists: async <T>(key: string) => objects.has(key) ? JSON.parse(String(objects.get(key))) as T : undefined,
    getBytes: async key => {
      const value = objects.get(key);
      if (value === undefined) throw new Error(`missing ${key}`);
      return typeof value === "string" ? strToU8(value) : value;
    },
  };
  return { store, objects, order };
}

export function memoryRepository() {
  const states = new Map<string, RenaultRequestState>();
  const repository: RequestRepository = {
    get: async id => states.get(id) ?? null,
    create: async state => { states.set(state.requestId, state); },
    patch: async (id, patch, deletedKeys = [], ifMatches) => {
      const current = states.get(id);
      if (!current) return null;
      if (ifMatches && Object.entries(ifMatches).some(([key, value]) => (current as Record<string, unknown>)[key] !== value)) return null;
      const next = { ...current, ...patch, updatedAt: new Date().toISOString() } as Record<string, unknown>;
      for (const key of deletedKeys) delete next[key];
      states.set(id, next as RenaultRequestState);
      return next as RenaultRequestState;
    },
    remove: async id => { states.delete(id); },
  };
  return { repository, states };
}

export function memoryLocks() {
  const owners = new Map<string, string>();
  const locks: ScopeLocks = {
    claim: async (paths, requestId) => {
      const conflict = paths.find(path => owners.has(path) && owners.get(path) !== requestId);
      if (conflict) return { ok: false, path: conflict };
      for (const path of paths) owners.set(path, requestId);
      return { ok: true };
    },
    release: async (paths, requestId) => { for (const path of paths) if (owners.get(path) === requestId) owners.delete(path); },
  };
  return { locks, owners };
}

export function memoryQueue() {
  const jobs = new Map<string, { job: RequestJob; state: QueueJobState }>();
  const queue: RequestQueue = {
    enqueue: async job => { const id = requestJobId(job); jobs.set(id, { job, state: "pending" }); return id; },
    getJob: async id => jobs.has(id) ? { id, state: jobs.get(id)!.state } : null,
    remove: async id => { jobs.delete(id); },
  };
  return { queue, jobs };
}

const profile = { value: "AUDATEX", user: "user@example.test", brand: "RENAULT", interpretModEvent: true };

export function query(code: string, over: Record<string, unknown> = {}) {
  return { id: `id-${code}`, queryCode: code, queryDesc: `${code} desc`, queryService: `rest/launch/${code}`, queryDownloadPath: `PATH/${code.toLowerCase()}_export.zip`, familyFilter: false, language: null, formatList: [{ value: "zip" }], ...over };
}

export type FakeApiOptions = {
  queries?: Json[];
  /** Bytes returned for each file name. */
  files?: (fileName: string) => Uint8Array;
  /** Remote status of the first status call. */
  status?: string;
  /** History polls that answer "not ready" before the file shows up. */
  pendingPolls?: number;
  families?: string[];
  onWait?: () => void;
};

/** A scripted ASMDOR: a partner account whose History completes after `pendingPolls` polls. */
export function fakeRenault(options: FakeApiOptions = {}) {
  const calls = { status: [] as string[], launch: 0, history: 0, downloadUrl: [] as string[], download: [] as string[], applicability: 0 };
  let polls = 0;
  const families = (options.families ?? ["X1310"]).map(value => ({ value, label: value, criteria: value }));
  const queries = options.queries ?? [query("TM01", { familyFilter: true, familyType: "All", language: ["en"], formatList: [{ value: "json.zip" }] }), ...["REF01", "REF02", "REF03", "REF04", "REF05", "PR05", "PR06"].map(code => query(code)), query("PR08", { familyFilter: true, familyType: "All" }), query("PR03", { familyFilter: true, familyType: "All", queryDownloadPath: "PATH/pr03_images.tar.gz", formatList: [{ value: "tar.gz" }] })];
  let lastFile = "";
  const api: RenaultApi = {
    applicability: async () => { calls.applicability++; return { status: "Success", responseData: { commercialName: "COMM", accountType: "Partner", asomSubscriptions: { applicabilitySubscriptions: { applicabilities: [{}] } }, applicabilitiesLanguage: ["EN"], allfamilyList: { active: families, old: families, future: families }, vehicleFamilyList: { active: families }, powertrainFamilyList: { active: families } } }; },
    profileData: async () => ({ responseData: [profile] }),
    queries: async () => ({ responseData: queries }),
    nonConfidentialFamilies: async () => ({ responseData: families }),
    status: async (_query, _payload, fileName) => { calls.status.push(fileName); lastFile = fileName; return { status: options.status ?? "EXECUTE", responseData: { requestQueryId: "remote-1" } }; },
    launch: async () => { calls.launch++; },
    history: async () => {
      calls.history++;
      options.onWait?.();
      polls++;
      const ready = polls > (options.pendingPolls ?? 0);
      return { responseData: ready ? [{ requestedQueryId: "remote-1", fileName: lastFile, exportStatus: "Completed", filePath: "biz/path/x/" }] : [] };
    },
    downloadUrl: async (filePath, fileName) => { calls.downloadUrl.push(`${filePath}|${fileName}`); return { responseData: { downloadUrl: `https://files.test/${fileName}` } }; },
    download: async url => { const name = url.split("/").pop()!; calls.download.push(name); return { bytes: options.files?.(name) ?? strToU8(`raw:${name}`), contentType: "zip" }; },
  };
  return { api, calls };
}

/** A REF04/REF05 style archive: one JSON file with records. */
export const jsonZip = (records: unknown[]) => zipSync({ "data.json": strToU8(JSON.stringify(records)) });
