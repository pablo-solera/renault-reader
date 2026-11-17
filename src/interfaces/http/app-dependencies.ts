import type { CreateRequest, ModelOptions, RequestState } from "@pablosla/core-reader/contract/v1";
import type { RenaultRequestState, RequestListFilters, Resource } from "../../domain/request.js";

export type AppDependencies = {
  readyChecks: Record<string, () => Promise<void>>;
  openApi: unknown;
  docsHtml: string;
  modelOptions(query: Record<string, unknown>): Promise<ModelOptions>;
  manufacturers(): string[];
  createRequest(resource: Resource, input: CreateRequest): Promise<string>;
  listRequests(resource: Resource, filters: RequestListFilters, cursor: string | undefined, limit: number): Promise<{ items: RenaultRequestState[]; nextCursor: string | null }>;
  getState(requestId: string): Promise<RenaultRequestState | null>;
  mapState(state: RenaultRequestState): Promise<RequestState>;
  cancelRequest(requestId: string): Promise<{ requestId: string; status: "cancelled" | "cancelling" }>;
  resumeRequest(requestId: string, force: boolean): Promise<unknown>;
  downloadArtifact(resource: Resource, requestId: string, artifact?: string): Promise<string>;
};
