import type { RenaultRequestState } from "../../domain/request.js";

export interface RequestRepository {
  get(requestId: string): Promise<RenaultRequestState | null>;
  /** Persists a new request and indexes it for listing. */
  create(state: RenaultRequestState): Promise<void>;
  /** Merges `patch` atomically; returns null when the request is gone or `ifMatches` does not hold. */
  patch(requestId: string, patch: Partial<RenaultRequestState>, deletedKeys?: string[], ifMatches?: Partial<RenaultRequestState>): Promise<RenaultRequestState | null>;
  remove(requestId: string): Promise<void>;
}
