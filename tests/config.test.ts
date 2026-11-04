import { describe, expect, test } from "bun:test";
import { listenHost } from "../src/config.js";

describe("listenHost", () => {
  test("listens on loopback unless HOST is set", () => {
    expect(listenHost(undefined)).toBe("127.0.0.1");
    expect(listenHost("")).toBe("127.0.0.1");
    expect(listenHost("   ")).toBe("127.0.0.1");
  });

  test("uses the configured address so a container can be reached from the Docker network", () => {
    expect(listenHost("0.0.0.0")).toBe("0.0.0.0");
    expect(listenHost(" 0.0.0.0 ")).toBe("0.0.0.0");
  });
});
