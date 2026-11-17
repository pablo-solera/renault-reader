import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "node:http";
import { strToU8, zipSync } from "fflate";
import { parseExtractionManifest } from "@pablosla/core-reader/contract/manifest";
import { loadConfig } from "../../src/config.js";
import { createRenaultContainer, type RenaultContainer } from "../../src/composition/container.js";

const models = [{ modelId: "M1", familyVehicle: "X13", bodyType: "SUV", engineType: "E1" }, { modelId: "M2", familyVehicle: "X99", bodyType: "SUV", engineType: "E1" }];
const powertrain = [{ familyVehicle: "X13", bodyType: "SUV", engineType: "E1", familyEngine: "ENG", familyGearbox: "GB" }, { familyVehicle: "X99", bodyType: "SUV", engineType: "E1", familyEngine: "OTHER" }];
const jsonZip = (records: unknown[]) => zipSync({ "data.json": strToU8(JSON.stringify(records)) });
const family = (value: string) => ({ value, label: value, criteria: value });
const families = ["X1310", "X13", "ENG", "GB"].map(family);

const query = (code: string, over: Record<string, unknown> = {}) => ({ id: `id-${code}`, queryCode: code, queryDesc: `${code} desc`, queryService: `rest/launch/${code}`, queryDownloadPath: `PATH/${code.toLowerCase()}_export.zip`, familyFilter: false, language: null, formatList: [{ value: "zip" }], ...over });
const queries = [
  query("TM01", { familyFilter: true, familyType: "All", language: ["en"], formatList: [{ value: "json.zip" }] }),
  ...["REF01", "REF02", "REF03", "REF04", "REF05", "PR05", "PR06"].map(code => query(code)),
  query("PR08", { familyFilter: true, familyType: "All" }),
  query("PR03", { familyFilter: true, familyType: "All", queryDownloadPath: "PATH/pr03_images.tar.gz", formatList: [{ value: "tar.gz" }] }),
];

/** A stand-in for Gigya and ASMDOR: login, token exchange, bearer-protected API, a History that shows the file one poll after the launch. */
function fakeRenault() {
  const state = {
    logins: 0, badAuth: 0, launches: [] as string[], failLaunchOnce: new Set<string>(), holdHistory: false,
    byRemoteId: new Map<string, string>(), launched: new Map<string, { polls: number }>(), seq: 0,
    served: new Map<string, Uint8Array>(),
  };
  const fileFor = (name: string) => {
    const bytes = name.startsWith("ref04_") ? jsonZip(models) : name.startsWith("ref05_") ? jsonZip(powertrain) : strToU8(`raw archive of ${name}`);
    state.served.set(name, bytes);
    return bytes;
  };
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    port: 0,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === "/accounts.login") {
        const form = new URLSearchParams(await request.text());
        if (form.get("apiKey") !== "gigya-key" || form.get("loginID") !== "user@example.test" || form.get("password") !== "e2e-password") return Response.json({ errorCode: 403042, status: "FAIL" });
        state.logins++;
        return Response.json({ errorCode: 0, status: "OK", isActive: true, UID: "uid", UIDSignature: "sig", signatureTimestamp: "123" });
      }
      if (url.pathname === "/api/v1/user/gigya/accessToken") return Response.json({ accessToken: `tok-${state.logins}` });
      if (url.pathname.startsWith("/files/")) return new Response(fileFor(decodeURIComponent(url.pathname.slice(7))) as BodyInit, { headers: { "content-type": "zip" } });
      if (!(request.headers.get("authorization") ?? "").startsWith("Bearer tok-")) { state.badAuth++; return new Response("denied", { status: 401 }); }
      const path = url.pathname.replace("/api/", "");
      const body = request.method === "POST" ? await request.json().catch(() => ({})) as any : {};
      if (path.startsWith("v1/apigee/partnerApplicability/GIGYAUSER/")) return Response.json({ status: "Success", responseData: { commercialName: "COMM", accountType: "Partner", asomSubscriptions: { applicabilitySubscriptions: { applicabilities: [{}] } }, applicabilitiesLanguage: ["EN"], allfamilyList: { active: families, old: families, future: families } } });
      if (path.startsWith("rest/v1/profile/getProfileData/")) return Response.json({ responseData: [{ value: "AUDATEX", user: "user@example.test", brand: "RENAULT", interpretModEvent: true }] });
      if (path.startsWith("rest/v1/query/get/profile/")) return Response.json({ responseData: queries });
      if (path === "rest/v1/requestquery/get/status") {
        const id = `remote-${++state.seq}`;
        state.byRemoteId.set(id, body.fileName);
        return Response.json({ status: "EXECUTE", responseData: { requestQueryId: id } });
      }
      if (path.startsWith("rest/launch/")) {
        const fileName = state.byRemoteId.get(body.queryRequestId)!;
        const code = path.split("/").pop()!;
        if (state.failLaunchOnce.delete(code)) return new Response(JSON.stringify({ message: "boom" }), { status: 500 });
        state.launches.push(fileName);
        state.launched.set(body.queryRequestId, { polls: 0 });
        return Response.json({});
      }
      if (path.startsWith("rest/v1/history/get/")) {
        const rows = [...state.launched.entries()].map(([id, entry]) => {
          entry.polls++;
          return { requestedQueryId: id, fileName: state.byRemoteId.get(id), exportStatus: !state.holdHistory && entry.polls > 1 ? "Completed" : "InProgress", filePath: "biz/files/" };
        });
        return Response.json({ responseData: rows });
      }
      if (path === "rest/s3/get/downloadURL") return Response.json({ status: "Success", responseData: { downloadUrl: `http://127.0.0.1:${server.port}/files/${encodeURIComponent(body.fileName)}` } });
      return new Response("unknown", { status: 404 });
    },
  });
  return { state, url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

const renault = fakeRenault();
const prefix = `integration-tests/e2e-${crypto.randomUUID()}`;
const config = loadConfig({
  ...process.env, RENAULT_API_BASE: `${renault.url}/api/`, GIGYA_API_BASE: renault.url, GIGYA_API_KEY: "gigya-key",
  RENAULT_EMAIL: "user@example.test", RENAULT_PASSWORD: "e2e-password", POLL_INTERVAL_MS: "50", JOB_TIMEOUT_MS: "30000", S3_PREFIX: prefix,
});
let container: RenaultContainer;
let server: Server;
let base: string;
let worker: Awaited<ReturnType<RenaultContainer["jobs"]["createWorker"]>>;

beforeAll(async () => {
  container = createRenaultContainer(config, { cancelPollMs: 100 });
  await container.redis.flushdb();
  await container.objectStorage.ensureBucket();
  worker = await container.jobs.createWorker();
  await container.workerLock.acquire("e2e");
  await container.workerLock.renew("e2e");
  server = container.app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  container.jobs.setWorkerShuttingDown(true);
  await worker.close(true);
  server.close();
  await container.close();
  renault.stop();
});

const json = async (response: Response) => response.json() as Promise<any>;
const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function waitFor(resource: string, requestId: string, done: (state: any) => boolean, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await json(await fetch(`${base}/v1/${resource}/${requestId}`));
    if (done(state)) return state;
    if (Date.now() > deadline) throw new Error(`Timed out; last state: ${JSON.stringify({ status: state.status, stage: state.stage, error: state.error })}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
const finished = (state: any) => ["completed", "failed", "cancelled"].includes(state.status);
const store = () => container.objectStorage;
const folderOf = (state: any, unit: string) => state.artifacts.find((artifact: any) => artifact.kind === "prefix" && artifact.name === unit).location.key as string;

const labourBody = { manufacturer: "RENAULT", language: "en", selection: { family: "X1310", format: "json.zip", range: "active" } };
const partsBody = (description: string) => ({ manufacturer: "DACIA", axCode: "5208", edition: "02/0", selection: { description, family: "X1310", modelIds: ["M1"], range: "active", exports: { REF01: false, REF02: false, REF03: false, PR05: false, PR06: false } } });

describe("API + worker end to end against a simulated Gigya and ASMDOR", () => {
  test("discovers the authorised families through the Gigya login", async () => {
    const info = await json(await fetch(`${base}/v1/info`));
    expect(info).toMatchObject({ reader: "renault", manufacturers: ["RENAULT", "DACIA"] });
    const options = await json(await fetch(`${base}/v1/models/options?range=active`));
    expect(options.models.map((model: any) => model.id)).toEqual(["ENG", "GB", "X13", "X1310"]);
    expect(options.filters.map((filter: any) => filter.name)).toEqual(["format", "language"]);
    expect(renault.state.badAuth).toBe(0);
    expect(renault.state.logins).toBe(1);
  });

  test("a labour request stores the raw export untouched with a manifest v2 and serves it back", async () => {
    const created = await post("/v1/labours", labourBody);
    expect(created.status).toBe(202);
    const { requestId } = await json(created);
    const state = await waitFor("labours", requestId, finished);
    expect(state).toMatchObject({ status: "completed", progress: 100, error: null });

    const unit = state.details.units[0];
    expect(unit.path).toMatch(/^RENAULT\/RENAULT\/labour\/X1310\/\d{8}\/TM01_en_active_json-zip$/);
    const raw = renault.state.served.get(unit.fileName)!;
    const rawKey = store().objectKey(unit.path, unit.fileName);
    expect([...(await container.objectStorage.listObjects(store().objectKey(unit.path)))].sort()).toEqual([rawKey, store().objectKey(unit.path, `${unit.unit}_completed.json`)].sort());
    const manifest = await store().getJson<any>(store().objectKey(unit.path, `${unit.unit}_completed.json`));
    expect(parseExtractionManifest(manifest)).toMatchObject({ ok: true, version: 2 });
    expect(manifest).toMatchObject({ schemaVersion: 2, manufacturer: "RENAULT", resource: "labour", unit: unit.unit, requestId, language: "en", files: [{ name: unit.fileName, role: "export" }], details: { queryCode: "TM01", size: raw.length, remoteStatus: "EXECUTE", family: "X1310" } });

    const download = await fetch(`${base}/v1/labours/${requestId}/download`, { redirect: "manual" });
    expect(download.status).toBe(307);
    expect(Buffer.from(await (await fetch(download.headers.get("location")!)).arrayBuffer()).equals(Buffer.from(raw))).toBe(true);
    expect(renault.state.logins).toBe(1);
    expect((await json(await fetch(`${base}/v1/labours?status=completed`))).items.map((item: any) => item.requestId)).toContain(requestId);
  });

  test("a parts request stores REF04 and REF05, then PR08 and PR03 for the families derived from them", async () => {
    const created = await post("/v1/parts", partsBody("Bigster (SVA)"));
    expect(created.status).toBe(202);
    const { requestId } = await json(created);
    const state = await waitFor("parts", requestId, finished);
    expect(state).toMatchObject({ status: "completed", progress: 100, error: null });
    expect(state.details.families).toEqual(["X13", "ENG", "GB"]);
    expect(state.details.units.map((unit: any) => unit.unit)).toEqual(["REF04", "REF05", "PR08_X13", "PR08_ENG", "PR08_GB", "PR03_X13", "PR03_ENG", "PR03_GB"]);
    expect(state.details.units[0].path).toMatch(/^RENAULT\/DACIA\/parts\/5208_Bigster-SVA-_X1310\/02-0\/\d{8}\/REF04$/);

    for (const unit of state.details.units) {
      const manifest = await store().getJson<any>(store().objectKey(unit.path, `${unit.unit}_completed.json`));
      expect(parseExtractionManifest(manifest).ok).toBe(true);
      expect(manifest).toMatchObject({ resource: "parts", axCode: "5208", edition: "02/0", details: { modelIds: ["M1"] } });
      const raw = renault.state.served.get(unit.fileName)!;
      expect(manifest.details.size).toBe(raw.length);
      const stored = await container.objectStorage.getObjectStream(store().objectKey(unit.path, unit.fileName));
      const chunks: Buffer[] = [];
      for await (const chunk of stored) chunks.push(chunk as Buffer);
      expect(Buffer.concat(chunks).equals(Buffer.from(raw))).toBe(true);
    }
    expect((await fetch(`${base}/v1/parts/${requestId}/download`, { redirect: "manual" })).status).toBe(409);
    const byName = await fetch(`${base}/v1/parts/${requestId}/download?artifact=REF04_completed.json`, { redirect: "manual" });
    expect(byName.status).toBe(307);
    expect(state.artifacts.filter((artifact: any) => artifact.primary)).toEqual([]);
  });

  test("a failed request resumes at the failing unit and reuses what was already stored", async () => {
    renault.state.failLaunchOnce.add("REF05");
    const before = renault.state.launches.length;
    const { requestId } = await json(await post("/v1/parts", partsBody("Resume Model")));
    const failed = await waitFor("parts", requestId, finished);
    expect(failed).toMatchObject({ status: "failed", error: { code: "UPSTREAM_ERROR" } });
    expect(failed.details.units.map((unit: any) => unit.status).slice(0, 2)).toEqual(["completed", "failed"]);
    expect(renault.state.launches.length - before).toBe(1);

    const resumed = await post(`/v1/parts/${requestId}/resume`, {});
    expect(resumed.status).toBe(202);
    const done = await waitFor("parts", requestId, state => state.status === "completed");
    expect(done.details.units.every((unit: any) => unit.status === "completed")).toBe(true);
    expect(renault.state.launches.length - before).toBe(1 + 7);
  });

  test("cancelling interrupts the wait for Renault, frees the folder and keeps what exists", async () => {
    renault.state.holdHistory = true;
    const body = { ...labourBody, selection: { ...labourBody.selection, publishedAfter: "2026-01-01" } };
    const { requestId } = await json(await post("/v1/labours", body));
    await waitFor("labours", requestId, state => String(state.stage).includes("waiting_for_renault"));
    expect((await post("/v1/labours", body)).status).toBe(409);
    const cancel = await post(`/v1/labours/${requestId}/cancel`, {});
    expect([200, 202]).toContain(cancel.status);
    const state = await waitFor("labours", requestId, finished);
    expect(state.status).toBe("cancelled");
    renault.state.holdHistory = false;
    expect((await post("/v1/labours", body)).status).toBe(202);
  });
});
