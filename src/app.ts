import express, { type Request, type Response } from "express";
import { signedDownload } from "./storage.js";
import { discoverExportOptions, discoverLabourOptions, gigyaLogin, RenaultClient } from "./renault.js";
import { config, getRenaultCredentials } from "./config.js";
import { enqueueLabour, enqueueParts, getState } from "./jobs.js";
import { PARTS_EXPORT_CODES, type LabourRequest, type PartsRequest } from "./types.js";
import { normalizeAxCode, normalizeEdition, normalizeManufacturer } from "./parts.js";
import { openapi } from "./openapi.js";

export const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));

const required = (value: unknown, name: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
};

const rejectCredentials = (body: any) => {
  if (body && (Object.hasOwn(body, "email") || Object.hasOwn(body, "password"))) {
    throw new Error("Credentials must be configured through environment variables");
  }
};

function parseInput(body: any): LabourRequest {
  rejectCredentials(body);
  const input: LabourRequest = {
    family: required(body?.family, "family"),
    format: required(body?.format, "format"),
    language: required(body?.language, "language").toLowerCase(),
    range: required(body?.range, "range"),
    publishedAfter: body?.publishedAfter ? required(body.publishedAfter, "publishedAfter") : undefined,
  };
  if (input.publishedAfter && !/^\d{4}-\d{2}-\d{2}$/.test(input.publishedAfter)) throw new Error("publishedAfter must use YYYY-MM-DD");
  return input;
}

function parsePartsInput(body: any): PartsRequest {
  rejectCredentials(body);
  const exportType = required(body?.exportType, "exportType").toUpperCase() as PartsRequest["exportType"];
  if (!PARTS_EXPORT_CODES.includes(exportType)) throw new Error(`Unsupported Parts exportType; use ${PARTS_EXPORT_CODES.join(", ")}`);
  const input: PartsRequest = {
    exportType,
    axCode: body?.axCode ? normalizeAxCode(required(body.axCode, "axCode")) : undefined,
    epc: body?.epc ? required(body.epc, "epc") : undefined,
    manufacturer: body?.manufacturer ? normalizeManufacturer(required(body.manufacturer, "manufacturer")) : undefined,
    description: body?.description ? required(body.description, "description") : undefined,
    edition: body?.edition ? normalizeEdition(required(body.edition, "edition")) : undefined,
    modelIds: body?.modelIds ? (() => {
      if (!Array.isArray(body.modelIds) || body.modelIds.some((value: unknown) => typeof value !== "string" || !value.trim())) throw new Error("modelIds must be an array of non-empty strings");
      return body.modelIds.map((value: string) => value.trim());
    })() : undefined,
    previousRequestId: body?.previousRequestId ? required(body.previousRequestId, "previousRequestId") : undefined,
    illustrationsRequestId: body?.illustrationsRequestId ? required(body.illustrationsRequestId, "illustrationsRequestId") : undefined,
    contextRequestId: body?.contextRequestId ? required(body.contextRequestId, "contextRequestId") : undefined,
    family: body?.family ? required(body.family, "family") : undefined,
    format: body?.format ? required(body.format, "format") : undefined,
    language: body?.language ? required(body.language, "language").toLowerCase() : undefined,
    range: required(body?.range, "range"),
    publishedAfter: body?.publishedAfter ? required(body.publishedAfter, "publishedAfter") : undefined,
  };
  if (input.publishedAfter && !/^\d{4}-\d{2}-\d{2}$/.test(input.publishedAfter)) throw new Error("publishedAfter must use YYYY-MM-DD");
  if (input.edition === "01/0" && input.previousRequestId) throw new Error("No se puede comparar la primera edición 01/0");
  return input;
}


app.get("/health", (_request, response) => response.json({ status: "ok" }));
app.get("/openapi.json", (_request, response) => response.json(openapi));
app.get("/docs", (_request, response) => response.type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Renault Reader API</title>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css"></head>
<body><div id="swagger-ui"></div>
<script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>window.ui=SwaggerUIBundle({url:'/openapi.json',dom_id:'#swagger-ui'});</script>
</body></html>`));

app.post("/labours/options", async (request: Request, response: Response) => {
  try {
    const body = request.body ?? {};
    rejectCredentials(body);
    const range = required(body.range, "range");
    const { email, password } = getRenaultCredentials();
    const auth = await gigyaLogin(email, password);
    const discovered = await discoverLabourOptions(new RenaultClient(auth.token), email, range);
    response.json({ queryCode: discovered.query.queryCode, profile: discovered.profile.value, range, families: discovered.families, formats: discovered.formats, languages: discovered.languages });
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "Invalid options request" });
  }
});

app.post("/labours", async (request: Request, response: Response) => {
  try {
    const state = await enqueueLabour(parseInput(request.body));
    response.status(202).json({ requestId: state.requestId, status: state.status, statusUrl: `/labours/${state.requestId}` });
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "Invalid Labour request" });
  }
});

app.get("/labours/:requestId", async (request: Request, response: Response) => {
  const requestId = String(request.params.requestId);
  const state = await getState(requestId);
  if (!state) return response.status(404).json({ error: "Labour request not found" });
  return response.json({ ...state, downloadUrl: state.status === "completed" && state.objectKey ? `/labours/${state.requestId}/download` : undefined });
});

app.get("/labours/:requestId/download", async (request: Request, response: Response) => {
  const state = await getState(String(request.params.requestId));
  if (!state) return response.status(404).json({ error: "Labour request not found" });
  if (state.status !== "completed" || !state.objectKey) return response.status(409).json({ error: "Labour file is not ready", status: state.status });
  return response.redirect(307, await signedDownload(state.objectKey));
});

app.post("/parts/options", async (request: Request, response: Response) => {
  try {
    const body = request.body ?? {};
    rejectCredentials(body);
    const exportType = required(body.exportType, "exportType").toUpperCase() as PartsRequest["exportType"];
    if (!PARTS_EXPORT_CODES.includes(exportType)) throw new Error(`Unsupported Parts exportType; use ${PARTS_EXPORT_CODES.join(", ")}`);
    const range = required(body.range, "range");
    const { email, password } = getRenaultCredentials();
    const auth = await gigyaLogin(email, password);
    const discovered = await discoverExportOptions(new RenaultClient(auth.token), email, range, exportType);
    response.json({ queryCode: discovered.query.queryCode, queryDesc: discovered.query.queryDesc, profile: discovered.profile.value, range, families: discovered.families, formats: discovered.formats, languages: discovered.languages });
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "Invalid Parts options request" });
  }
});

app.post("/parts", async (request: Request, response: Response) => {
  try {
    const state = await enqueueParts(parsePartsInput(request.body));
    response.status(202).json({ requestId: state.requestId, status: state.status, statusUrl: `/parts/${state.requestId}` });
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "Invalid Parts request" });
  }
});

app.get("/parts/:requestId", async (request: Request, response: Response) => {
  const requestId = String(request.params.requestId);
  const state = await getState(requestId);
  if (!state) return response.status(404).json({ error: "Parts request not found" });
  return response.json({ ...state, downloadUrl: state.status === "completed" && state.objectKey ? `/parts/${state.requestId}/download` : undefined });
});

app.get("/parts/:requestId/download", async (request: Request, response: Response) => {
  const state = await getState(String(request.params.requestId));
  if (!state) return response.status(404).json({ error: "Parts request not found" });
  if (state.status !== "completed" || !state.objectKey) return response.status(409).json({ error: "Parts file is not ready", status: state.status });
  return response.redirect(307, await signedDownload(state.objectKey));
});

app.use((error: unknown, _request: Request, response: Response, _next: unknown) => response.status(500).json({ error: error instanceof Error ? error.message : "Internal server error" }));

if (config.port < 1) throw new Error("Invalid port");
