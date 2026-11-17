import { describe, expect, test } from "bun:test";
import { loadConfig, requireRenaultCredentials } from "../src/config.js";

describe("config", () => {
  test("defaults listen on loopback and keep the legacy polling semantics", () => {
    const config = loadConfig({});
    expect(config).toMatchObject({ HOST: "127.0.0.1", PORT: 3000, POLL_INTERVAL_MS: 30000, JOB_TIMEOUT_MS: 86400000, JOB_CONCURRENCY: 2, S3_PREFIX: "", s3ForcePathStyle: true, s3AutoCreateBucket: false, manufacturers: ["RENAULT", "DACIA"] });
  });

  test("uses the configured address and treats an empty S3 endpoint as unset", () => {
    const config = loadConfig({ HOST: "0.0.0.0", S3_ENDPOINT: "", RENAULT_MANUFACTURERS: " RENAULT , " });
    expect(config.HOST).toBe("0.0.0.0");
    expect(config.S3_ENDPOINT).toBeUndefined();
    expect(config.manufacturers).toEqual(["RENAULT"]);
  });

  test("rejects non-positive numbers", () => {
    expect(() => loadConfig({ POLL_INTERVAL_MS: "0" })).toThrow();
  });

  test("credentials come only from the environment and are required by the worker", () => {
    expect(() => requireRenaultCredentials(loadConfig({}))).toThrow("RENAULT_EMAIL and RENAULT_PASSWORD");
    expect(() => requireRenaultCredentials(loadConfig({ RENAULT_EMAIL: "a@b.c", RENAULT_PASSWORD: "p" }))).toThrow("GIGYA_API_KEY");
    expect(requireRenaultCredentials(loadConfig({ RENAULT_EMAIL: " a@b.c ", RENAULT_PASSWORD: "p", GIGYA_API_KEY: "k" }))).toEqual({ email: "a@b.c", password: "p" });
  });
});
