import { mkdir, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { gunzipSync, unzipSync } from "fflate";
import { getState } from "../jobs.js";
import { downloadBytes } from "../storage.js";

function tarFiles(bytes: Uint8Array): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const name = new TextDecoder().decode(header.subarray(0, 100)).replace(/\0.*$/, "");
    const size = Number.parseInt(new TextDecoder().decode(header.subarray(124, 136)).replace(/\0.*$/, "").trim() || "0", 8);
    const start = offset + 512;
    if (name && !name.endsWith("/")) files[basename(name)] = bytes.slice(start, start + size);
    offset = start + Math.ceil(size / 512) * 512;
  }
  return files;
}

export async function publishSandboxImages(rootRequestId: string, destination = "sandbox-images"): Promise<number> {
  const root = await getState(rootRequestId);
  const children = root?.children ?? {};
  let count = 0;
  for (const [key, child] of Object.entries(children).filter(([key]) => key.startsWith("PR03_"))) {
    const state = await getState(child.requestId);
    if (!state?.rawObjectKey) continue;
    const raw = await downloadBytes(state.rawObjectKey);
    const files = tarFiles(raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw);
    const family = key.slice("PR03_".length);
    const folder = join(destination, "DACIA", "0826", "X1310", family);
    await mkdir(folder, { recursive: true });
    for (const [name, bytes] of Object.entries(files)) {
      if (!/\.svg$/i.test(name)) continue;
      await writeFile(join(folder, name), bytes);
      count++;
    }
  }
  return count;
}

if (import.meta.main) publishSandboxImages("4aa5bf62-acfc-4571-8938-9454dfaaf2ed").then((count) => { console.log(`published ${count} SVG files`); process.exit(0); }).catch((error) => { console.error(error.message); process.exit(1); });
