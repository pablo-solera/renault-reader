import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { checkV1HttpConformance } from "@pablosla/core-reader/testing/conformance";
import { ConflictError, NotReadyError, UnavailableError } from "@pablosla/core-reader/domain/errors";
import { createApp } from "../src/app.js";
import type { AppDependencies } from "../src/interfaces/http/app-dependencies.js";
import { buildRenaultOpenApi, docsHtml } from "../src/interfaces/http/openapi.js";
import { createModelOptionsHandler } from "../src/interfaces/http/model-options-handler.js";
import { getModelOptionsUseCase } from "../src/application/use-cases/get-model-options.js";
import { enqueueRequestUseCase } from "../src/application/use-cases/enqueue-request.js";
import { toRequestState, toRequestSummary } from "../src/interfaces/http/state-mapper.js";
import { fakeRenault, memoryLocks, memoryQueue, memoryRepository } from "./helpers/fakes.js";

const requestId = "00000000-0000-4000-8000-000000000001";
const locator = { bucket: "bucket", objectKey: (...parts: string[]) => parts.join("/") };

async function withServer(run: (baseUrl: string, deps: AppDependencies) => Promise<void>, overrides: Partial<AppDependencies> = {}) {
  const repo = memoryRepository();
  const queue = memoryQueue();
  const locks = memoryLocks();
  const { api } = fakeRenault();
  let created = 0;
  const dependencies: AppDependencies = {
    readyChecks: { redis: async () => undefined },
    openApi: buildRenaultOpenApi(3000),
    docsHtml,
    manufacturers: () => ["RENAULT", "DACIA"],
    modelOptions: createModelOptionsHandler(query => getModelOptionsUseCase(query, api)),
    createRequest: (resource, input) => enqueueRequestUseCase(resource, input, { repository: repo.repository, queue: queue.queue, locks: locks.locks, newId: () => created++ === 0 ? requestId : `00000000-0000-4000-8000-00000000000${created}` }),
    listRequests: async (resource) => ({ items: [...repo.states.values()].filter(state => state.resource === resource), nextCursor: null }),
    getState: id => repo.repository.get(id),
    mapState: async state => toRequestState(state, locator),
    mapSummary: state => toRequestSummary(state, locator),
    cancelRequest: async id => ({ requestId: id, status: "cancelled" as const }),
    resumeRequest: async () => ({ requestId, resumedAtUnit: "REF04" }),
    downloadArtifact: async () => "https://example.test/download",
    ...overrides,
  };
  const server = createServer(createApp(dependencies));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  try { await run(`http://127.0.0.1:${address.port}`, dependencies); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

const post = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const labourBody = { manufacturer: "RENAULT", language: "en", selection: { family: "X1310", format: "json.zip", range: "active" } };
const partsBody = { manufacturer: "DACIA", axCode: "5208", edition: "02/0", selection: { description: "Bigster", family: "X1310", modelIds: ["M1"], range: "active" } };

describe("Renault v1 HTTP contract", () => {
  test("publishes identity, manufacturers and capabilities for labours and parts", async () => {
    await withServer(async baseUrl => {
      const info = await (await fetch(`${baseUrl}/v1/info`)).json();
      expect(info).toMatchObject({ reader: "renault", contractVersion: "1.0.0", manufacturers: ["RENAULT", "DACIA"], capabilities: { models: { options: true }, labours: { create: true, list: true, cancel: true, resume: true, download: true }, parts: { create: true, list: true, cancel: true, resume: true, download: true } } });
    });
  });

  test("passes the reusable conformance checks and exposes only versioned business routes", async () => {
    await withServer(async baseUrl => {
      expect(await checkV1HttpConformance(baseUrl)).toEqual([]);
      for (const legacy of ["/labours", "/parts", "/models", "/labours/options"]) expect((await fetch(`${baseUrl}${legacy}`)).status).toBe(404);
      expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
      expect((await fetch(`${baseUrl}/ready`)).status).toBe(200);
    });
  });

  test("creates labours and parts requests with 202 and a self link, then reads them back", async () => {
    await withServer(async baseUrl => {
      const created = await post(`${baseUrl}/v1/labours`, labourBody);
      expect(created.status).toBe(202);
      expect(await created.json()).toEqual({ requestId, resource: "labours", status: "queued", links: { self: `/v1/labours/${requestId}` } });
      const state = await (await fetch(`${baseUrl}/v1/labours/${requestId}`)).json();
      expect(state).toMatchObject({ requestId, resource: "labours", reader: "renault", status: "queued", request: labourBody });
      expect((await fetch(`${baseUrl}/v1/parts/${requestId}`)).status).toBe(404);
      const list = await (await fetch(`${baseUrl}/v1/labours?status=queued`)).json() as { items: Array<{ requestId: string; artifactCount: number }> };
      expect(list.items.map(item => item.requestId)).toEqual([requestId]);
    });
    await withServer(async baseUrl => {
      expect((await post(`${baseUrl}/v1/parts`, partsBody)).status).toBe(202);
    });
  });

  test("invalid selections, credentials and conflicts answer with the shared error body", async () => {
    await withServer(async baseUrl => {
      const missing = await post(`${baseUrl}/v1/labours`, { manufacturer: "RENAULT", selection: {} });
      expect(missing.status).toBe(400);
      expect(await missing.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
      const credentials = await post(`${baseUrl}/v1/labours`, { ...labourBody, selection: { ...labourBody.selection, email: "a@b.c", password: "x" } });
      expect(credentials.status).toBe(400);
      await post(`${baseUrl}/v1/labours`, labourBody);
      const conflict = await post(`${baseUrl}/v1/labours`, labourBody);
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({ error: { code: "CONFLICT" } });
    });
  });

  test("download redirects with 307; not-ready and conflicts keep their codes", async () => {
    await withServer(async baseUrl => {
      const redirect = await fetch(`${baseUrl}/v1/labours/${requestId}/download?artifact=x`, { redirect: "manual" });
      expect(redirect.status).toBe(307);
      expect(redirect.headers.get("location")).toBe("https://example.test/download");
    });
    await withServer(async baseUrl => {
      const response = await fetch(`${baseUrl}/v1/parts/${requestId}/download`);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: "NOT_READY" } });
    }, { downloadArtifact: async () => { throw new NotReadyError("not yet"); } });
  });

  test("cancel answers 200 or 202 and resume 202; a conflict is a 409", async () => {
    await withServer(async baseUrl => {
      expect((await post(`${baseUrl}/v1/labours/${requestId}/cancel`, {})).status).toBe(200);
      expect((await post(`${baseUrl}/v1/labours/${requestId}/resume`, {})).status).toBe(202);
    });
    await withServer(async baseUrl => {
      expect((await post(`${baseUrl}/v1/parts/${requestId}/cancel`, {})).status).toBe(202);
      expect((await post(`${baseUrl}/v1/parts/${requestId}/resume`, { force: true })).status).toBe(409);
    }, { cancelRequest: async id => ({ requestId: id, status: "cancelling" as const }), resumeRequest: async () => { throw new ConflictError("running"); } });
  });

  test("model options list the authorised families as ready selections", async () => {
    await withServer(async baseUrl => {
      const options = await (await fetch(`${baseUrl}/v1/models/options?range=active`)).json() as { complete: boolean; models: Array<{ selection: unknown }>; filters: Array<{ name: string }> };
      expect(options.complete).toBe(true);
      expect(options.models[0]!.selection).toEqual({ family: "X1310", range: "active" });
      expect(options.filters.map(filter => filter.name)).toEqual(["format", "language"]);
      expect((await fetch(`${baseUrl}/v1/models/options?range=ancient`)).status).toBe(400);
    });
  });

  test("maps an unavailable Renault to 503", async () => {
    await withServer(async baseUrl => {
      const response = await fetch(`${baseUrl}/v1/models/options`);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: "UNAVAILABLE" } });
    }, { modelOptions: async () => { throw new UnavailableError("login failed"); } });
  });
});
