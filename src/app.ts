import express from "express";
import { createSystemRouter } from "@pablosla/core-reader/interfaces/http/express/system-router";
import { createV1Router } from "@pablosla/core-reader/interfaces/http/express/v1-router";
import { readerErrorMiddleware, readerNotFoundMiddleware } from "@pablosla/core-reader/interfaces/http/express/error-middleware";
import { ConflictError } from "@pablosla/core-reader/domain/errors";
import type { CreateRequest } from "@pablosla/core-reader/contract/v1";
import type { ResourceHandlers } from "@pablosla/core-reader/application/v1-handlers";
import type { AppDependencies } from "./interfaces/http/app-dependencies.js";
import type { Resource } from "./domain/request.js";

export const readerVersion = "1.0.0";

export function createApp(dependencies: AppDependencies) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));
  app.use(createSystemRouter(dependencies.openApi, dependencies.docsHtml, dependencies.readyChecks));

  const handlers = (resource: Resource): ResourceHandlers => ({
    create: async (body: CreateRequest) => ({ requestId: await dependencies.createRequest(resource, body) }),
    list: async query => {
      const page = await dependencies.listRequests(resource, { status: query.status, manufacturer: query.manufacturer, axCode: query.axCode, edition: query.edition }, query.cursor, query.limit);
      return { items: page.items.map(state => dependencies.mapSummary(state)), nextCursor: page.nextCursor };
    },
    get: async requestId => {
      const state = await dependencies.getState(requestId);
      return state && state.resource === resource ? dependencies.mapState(state) : null;
    },
    download: (requestId, artifact) => dependencies.downloadArtifact(resource, requestId, artifact),
    cancel: async requestId => {
      const result = await dependencies.cancelRequest(requestId);
      if (result.status !== "cancelled" && result.status !== "cancelling") throw new ConflictError("Request cannot be cancelled in its current state", { status: result.status });
      return { status: result.status, body: { requestId, status: result.status } };
    },
    resume: (requestId, force) => dependencies.resumeRequest(requestId, force),
  });

  app.use("/v1", createV1Router({
    reader: "renault",
    version: readerVersion,
    manufacturers: () => Promise.resolve(dependencies.manufacturers()),
    handlers: { labours: handlers("labours"), parts: handlers("parts"), modelsOptions: query => dependencies.modelOptions(query) },
  }));
  app.use(readerNotFoundMiddleware);
  app.use(readerErrorMiddleware);
  return app;
}
