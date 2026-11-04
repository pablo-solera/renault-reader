import { describe, expect, test } from "bun:test";
import { REDIS_PREFIX, lockKey, partsLockKey, queueNames, stateKey } from "../src/redis-keys.js";
import type { LabourRequest, PartsRequest } from "../src/types.js";

describe("Redis naming", () => {
  test("queues are prefixed with the service name like the BMW ones", () => {
    expect(queueNames).toEqual({ labours: "renault-labours", parts: "renault-parts", models: "renault-models" });
    for (const name of Object.values(queueNames)) expect(name.startsWith("renault-")).toBe(true);
  });

  test("state and lock keys live under renault-reader:", () => {
    expect(REDIS_PREFIX).toBe("renault-reader");
    expect(stateKey("abc")).toBe("renault-reader:job:abc");
    const labour = { family: "CLIO", format: "json", language: "es", range: "active" } as LabourRequest;
    expect(lockKey(labour)).toBe("renault-reader:lock:TM01:CLIO:json:es:active:");
    const parts = { exportType: "PR03", range: "active" } as PartsRequest;
    expect(partsLockKey(parts)).toBe("renault-reader:lock:PR03:All:default::active::::");
  });

  test("nothing is left under the old asmdor: prefix", () => {
    const keys = [stateKey("x"), lockKey({ family: "A", format: "f", language: "l", range: "r" } as LabourRequest), partsLockKey({ exportType: "PR03", range: "r" } as PartsRequest)];
    for (const key of keys) expect(key.startsWith("asmdor")).toBe(false);
  });
});
