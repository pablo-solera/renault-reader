import type { LabourRequest, PartsRequest } from "./types.js";

/** Every Redis key of this service starts with this prefix, like bmw-reader:* and bmw-transformer:*, because the Redis is shared. */
export const REDIS_PREFIX = "renault-reader";

/** BullMQ queue names, prefixed like bmw-labour-typekeys and bmw-transformer-reports. */
export const queueNames = {
  labours: "renault-labours",
  parts: "renault-parts",
  models: "renault-models",
} as const;

export const stateKey = (id: string) => `${REDIS_PREFIX}:job:${id}`;

export const lockKey = (input: LabourRequest) => `${REDIS_PREFIX}:lock:TM01:${input.family}:${input.format}:${input.language}:${input.range}:${input.publishedAfter ?? ""}`;

export const partsLockKey = (input: PartsRequest) => `${REDIS_PREFIX}:lock:${input.exportType}:${input.family ?? "All"}:${input.format ?? "default"}:${input.language ?? ""}:${input.range}:${input.publishedAfter ?? ""}:${input.previousRequestId ?? ""}:${input.illustrationsRequestId ?? ""}:${input.modelIds?.join(",") ?? ""}`;
