import type { Redis } from "ioredis";
import { RedisStateStore } from "@pablosla/core-reader/infrastructure/redis/state-store";
import { createRedisRequestIndex, type RequestIndexRedis } from "@pablosla/core-reader/infrastructure/redis/request-index";
import { createKeyspace } from "@pablosla/core-reader/infrastructure/redis/keyspace";
import type { RequestRepository } from "../../application/ports/request-repository.js";
import type { RenaultRequestState, Resource } from "../../domain/request.js";

/** Every Redis key of this service starts with this prefix: the Redis is shared with the other readers and transformers. */
export const redisNamespace = "renault-reader";
export const renaultKeyspace = createKeyspace(redisNamespace);

export type RequestRepositoryRedis = Pick<Redis, "get" | "set" | "del" | "watch" | "unwatch" | "multi" | "mget"> & RequestIndexRedis;

export const requestStateKey = (requestId: string) => renaultKeyspace("request", requestId);

const resources: Resource[] = ["labours", "parts"];

/** One state record per request, and one paginated index per resource (labours and parts are listed separately). */
export function createRedisRequestRepository(redis: RequestRepositoryRedis, options: { ttlSeconds: number }) {
  const store = new RedisStateStore<RenaultRequestState>(redis as never, requestStateKey, options.ttlSeconds);
  const indexes = Object.fromEntries(resources.map(resource => [resource, createRedisRequestIndex(redis, { namespace: redisNamespace, resource, ttlMs: options.ttlSeconds * 1000, stateKey: requestStateKey })])) as Record<Resource, ReturnType<typeof createRedisRequestIndex>>;
  const repository: RequestRepository = {
    get: id => store.get(id),
    async create(state) {
      await store.set(state.requestId, state, state.updatedAt);
      await indexes[state.resource].add(state);
    },
    patch: (id, patch, deletedKeys, ifMatches) => store.patch(id, patch, deletedKeys, ifMatches),
    async remove(id) {
      const state = await store.get(id);
      await redis.del(requestStateKey(id));
      if (state) await indexes[state.resource].remove([id]);
    },
  };
  return {
    repository,
    indexes,
    async fetchStates(requestIds: string[]): Promise<Array<RenaultRequestState | null>> {
      if (!requestIds.length) return [];
      return (await redis.mget(...requestIds.map(requestStateKey))).map(value => value ? JSON.parse(value) as RenaultRequestState : null);
    },
    /** Every indexed request of both resources, for the startup recovery. */
    async allRequestIds() {
      return (await Promise.all(resources.map(resource => indexes[resource].requestIds()))).flat();
    },
  };
}
