import { createHash } from "node:crypto";
import { RedisLeaseLock, type RedisLockClient } from "@pablosla/core-reader/infrastructure/redis/lock";
import type { ScopeLocks } from "../../application/ports/scope-locks.js";
import { renaultKeyspace } from "./request-repository.js";

export const scopeLockKey = (bucket: string, path: string) => renaultKeyspace("scope-lock", createHash("sha256").update(`${bucket}\n${path}`).digest("hex"));

/** The lock value is the request id, so a request can re-claim (extend) its own folders when resumed. */
export function createRedisScopeLocks(client: RedisLockClient, options: { bucket: string; ttlMs: number }): ScopeLocks {
  const lock = new RedisLeaseLock(client);
  return {
    async claim(paths, requestId) {
      const acquired: string[] = [];
      for (const path of paths) {
        const key = scopeLockKey(options.bucket, path);
        if (await lock.renew(key, requestId, options.ttlMs)) continue;
        if (await lock.acquire(key, requestId, options.ttlMs)) { acquired.push(key); continue; }
        for (const owned of acquired) await lock.release(owned, requestId);
        return { ok: false, path };
      }
      return { ok: true };
    },
    async release(paths, requestId) {
      for (const path of paths) await lock.release(scopeLockKey(options.bucket, path), requestId);
    },
  };
}
