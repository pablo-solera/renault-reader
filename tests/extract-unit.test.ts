import { describe, expect, test } from "bun:test";
import { NotAvailableError, UnavailableError, UpstreamError } from "@pablosla/core-reader/domain/errors";
import { RequestAbortedError } from "@pablosla/core-reader/shared/retry";
import { parseExtractionManifest } from "@pablosla/core-reader/contract/manifest";
import { extractUnit, type ExtractUnitDependencies } from "../src/application/use-cases/extract-unit.js";
import { discoverExport } from "../src/application/use-cases/discover-export.js";
import { getModelOptionsUseCase } from "../src/application/use-cases/get-model-options.js";
import { initialUnits } from "../src/domain/units.js";
import { validateLabourInput, validatePartsInput } from "../src/domain/validation.js";
import { fakeRenault, memoryStore, query } from "./helpers/fakes.js";

const now = new Date("2026-11-17T10:00:00Z");
const requestId = "00000000-0000-4000-8000-000000000001";
const labour = validateLabourInput({ manufacturer: "RENAULT", language: "en", selection: { family: "X1310", format: "json.zip", range: "active" } }, now);

function setup(options: Parameters<typeof fakeRenault>[0] = {}, overrides: Partial<ExtractUnitDependencies> = {}) {
  const renault = fakeRenault(options);
  const memory = memoryStore("pfx");
  const stages: string[] = [];
  const dependencies: ExtractUnitDependencies = { api: renault.api, store: memory.store, pollIntervalMs: 1, timeoutMs: 5000, onStage: async stage => { stages.push(stage); }, now: () => new Date("2026-11-17T10:00:00Z"), ...overrides };
  return { ...renault, ...memory, stages, dependencies };
}

describe("extractUnit", () => {
  test("stores the raw archive exactly as received and writes the manifest last", async () => {
    const { calls, objects, order, dependencies, stages } = setup({ files: () => new Uint8Array([1, 2, 3, 4]) });
    const unit = initialUnits(labour)[0]!;
    const result = await extractUnit({ requestId, input: labour, unit }, dependencies);
    expect(result.reused).toBe(false);
    expect(calls.launch).toBe(1);
    const rawKey = `pfx/${unit.path}/${result.fileName}`;
    expect(objects.get(rawKey)).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(order).toEqual([rawKey, `pfx/${unit.path}/${unit.unit}_completed.json`]);
    const manifest = parseExtractionManifest(JSON.parse(String(objects.get(`pfx/${unit.path}/${unit.unit}_completed.json`))));
    expect(manifest.ok && manifest.version === 2 && manifest.manifest).toMatchObject({ resource: "labour", unit: unit.unit, files: [{ name: result.fileName, role: "export" }], details: { queryCode: "TM01", size: 4, remoteRequestId: "remote-1", remoteStatus: "EXECUTE", family: "X1310", language: "en" } });
    expect(stages).toEqual(["tm01_configuration", "request_status", "launching", "presigned_url", "downloading", "s3_upload"]);
    expect(calls.downloadUrl[0]).toBe(`path/x|${result.fileName}`);
  });

  test("reuses a stored unit without calling Renault", async () => {
    const { calls, dependencies } = setup();
    const unit = initialUnits(labour)[0]!;
    const first = await extractUnit({ requestId, input: labour, unit }, dependencies);
    const second = await extractUnit({ requestId, input: labour, unit }, dependencies);
    expect(second).toMatchObject({ reused: true, fileName: first.fileName });
    expect(calls.applicability).toBe(1);
    expect(calls.status).toHaveLength(1);
  });

  test("waits on the History until the file is completed", async () => {
    const { calls, dependencies, stages } = setup({ pendingPolls: 2 });
    await extractUnit({ requestId, input: labour, unit: initialUnits(labour)[0]! }, dependencies);
    expect(calls.history).toBe(3);
    expect(stages.filter(stage => stage === "waiting_for_renault")).toHaveLength(2);
  });

  test("an AVAILABLE export is not launched again", async () => {
    const { calls, dependencies } = setup({ status: "AVAILABLE" });
    await extractUnit({ requestId, input: labour, unit: initialUnits(labour)[0]! }, dependencies);
    expect(calls.launch).toBe(0);
  });

  test("times out waiting for the History", async () => {
    const { dependencies } = setup({ pendingPolls: 1e9 }, { timeoutMs: 20 });
    await expect(extractUnit({ requestId, input: labour, unit: initialUnits(labour)[0]! }, dependencies)).rejects.toBeInstanceOf(UnavailableError);
  });

  test("an aborted wait stops without downloading anything", async () => {
    const controller = new AbortController();
    const { calls, objects, dependencies } = setup({ pendingPolls: 1e9, onWait: () => controller.abort() }, { signal: controller.signal });
    await expect(extractUnit({ requestId, input: labour, unit: initialUnits(labour)[0]! }, dependencies)).rejects.toBeInstanceOf(RequestAbortedError);
    expect(calls.download).toEqual([]);
    expect(objects.size).toBe(0);
  });

  test("rejects families, formats and languages the account is not authorised for", async () => {
    for (const input of [
      { ...labour, family: "UNKNOWN" },
      { ...labour, format: "csv" },
      { ...labour, language: "fr" },
    ]) {
      const { dependencies, objects } = setup();
      await expect(extractUnit({ requestId, input, unit: { ...initialUnits(labour)[0]!, family: input.family } }, dependencies)).rejects.toBeInstanceOf(NotAvailableError);
      expect(objects.size).toBe(0);
    }
  });

  test("tolerates the stale-duplicate status error of Labour exports only", async () => {
    const stale = () => {
      const renault = fakeRenault();
      let file = "";
      renault.api.status = async (_query, _payload, fileName) => { file = fileName; return { status: "STATUS_ERROR", responseData: { requestQueryStatusMsg: "Failed to get the status" } }; };
      renault.api.history = async () => ({ responseData: [{ requestedQueryId: "available", fileName: file, exportStatus: "Unlocked", filePath: "p" }] });
      return renault.api;
    };
    const dependencies = (store: ReturnType<typeof memoryStore>["store"]): ExtractUnitDependencies => ({ api: stale(), store, pollIntervalMs: 1, timeoutMs: 1000, onStage: async () => undefined });
    const ok = await extractUnit({ requestId, input: labour, unit: initialUnits(labour)[0]! }, dependencies(memoryStore().store));
    expect(ok.reused).toBe(false);

    const parts = validatePartsInput({ manufacturer: "DACIA", axCode: "5208", edition: "02/0", selection: { description: "Bigster", family: "X1310", modelIds: ["M1"], range: "active" } }, now);
    await expect(extractUnit({ requestId, input: parts, unit: initialUnits(parts)[0]! }, dependencies(memoryStore().store))).rejects.toBeInstanceOf(UpstreamError);
  });

  test("a parts unit records the model ids and families in its manifest", async () => {
    const parts = validatePartsInput({ manufacturer: "DACIA", axCode: "5208", edition: "02/0", selection: { description: "Bigster", family: "X1310", modelIds: ["M1"], range: "active" } }, now);
    const { objects, dependencies } = setup();
    const unit = { ...initialUnits(parts)[0]!, unit: "PR08_X1310", queryCode: "PR08", family: "X1310", path: "RENAULT/DACIA/parts/s/02-0/20261117/PR08_X1310" };
    await extractUnit({ requestId, input: parts, unit, families: ["X1310"] }, dependencies);
    const manifest = JSON.parse(String(objects.get(`pfx/${unit.path}/PR08_X1310_completed.json`)));
    expect(manifest).toMatchObject({ resource: "parts", axCode: "5208", edition: "02/0", details: { queryCode: "PR08", modelIds: ["M1"], families: ["X1310"], family: "X1310" } });
  });
});

describe("discovery", () => {
  test("rejects accounts without a profile or the requested query", async () => {
    const { api } = fakeRenault({ queries: [query("REF04")] });
    await expect(discoverExport(api, "active", "TM01")).rejects.toBeInstanceOf(NotAvailableError);
  });

  test("an invalid range is a NOT_AVAILABLE answer, not an internal error", async () => {
    const { api } = fakeRenault();
    await expect(discoverExport(api, "ancient", "TM01")).rejects.toBeInstanceOf(NotAvailableError);
  });

  test("model options expose each authorised family with a ready labour selection", async () => {
    const { api } = fakeRenault({ families: ["B", "A"] });
    const options = await getModelOptionsUseCase({ range: "active", exportType: "TM01", includeRaw: true }, api);
    expect(options.complete).toBe(true);
    expect(options.models.map(model => model.selection)).toEqual([{ family: "A", range: "active" }, { family: "B", range: "active" }]);
    expect(options.filters).toEqual([{ name: "format", values: [{ value: "json.zip" }] }, { name: "language", values: [{ value: "en" }] }]);
    expect(options.raw).toMatchObject({ queryCode: "TM01", profile: "AUDATEX" });
  });
});
