import { listRequestsPage } from "@pablosla/core-reader/application/list-requests";
import type { RenaultRequestState, RequestListFilters, Resource } from "../../domain/request.js";

export type ListRequestsDependencies = {
  ensureIndex(resource: Resource): Promise<void>;
  fetchRequestIds(resource: Resource, cutoff: number, after: { score: number; requestId: string } | null, count: number): Promise<string[]>;
  fetchStates(requestIds: string[]): Promise<Array<RenaultRequestState | null>>;
  removeMissing(resource: Resource, requestIds: string[]): Promise<void>;
  pruneExpired(resource: Resource, cutoff: number): Promise<void>;
  ttlMs: number;
  now?: () => number;
};

const edition = (state: RenaultRequestState) => state.input.edition ?? state.input.date;

export function matchesFilters(state: RenaultRequestState, filters: RequestListFilters): boolean {
  return (!filters.status?.length || filters.status.includes(state.status))
    && (filters.manufacturer === undefined || state.input.manufacturer.toLowerCase() === filters.manufacturer.toLowerCase())
    && (filters.axCode === undefined || state.input.axCode === filters.axCode)
    && (filters.edition === undefined || edition(state) === filters.edition);
}

export function listRequestsUseCase(resource: Resource, filters: RequestListFilters, cursor: string | undefined, limit: number, dependencies: ListRequestsDependencies) {
  const now = dependencies.now ?? Date.now;
  return listRequestsPage<RenaultRequestState, RenaultRequestState>(cursor, limit, {
    ensureIndex: () => dependencies.ensureIndex(resource),
    cutoff: () => now() - dependencies.ttlMs,
    pruneExpired: cutoff => dependencies.pruneExpired(resource, cutoff),
    fetchRequestIds: (cutoff, after, count) => dependencies.fetchRequestIds(resource, cutoff, after, count),
    fetchStates: dependencies.fetchStates,
    removeMissing: ids => dependencies.removeMissing(resource, ids),
    summarize: state => matchesFilters(state, filters) ? [state] : [],
  });
}
