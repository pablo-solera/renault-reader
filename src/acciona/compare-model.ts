import { mkdir, writeFile } from "node:fs/promises";
import { compareSandboxWithDatabase } from "./compare.js";
import { getState } from "../jobs.js";
import { getAccionaConfig, extractionDatabaseName } from "../db/acciona.js";
import { epcFromDate } from "../parts.js";

const requestId = process.argv[2];
if (!requestId) throw new Error("Usage: bun src/acciona/compare-model.ts <requestId> [referenceDatabase]");
const root = await getState(requestId);
if (!root?.modelInput) throw new Error(`Request ${requestId} has no modelInput; relaunch the model extraction`);
const input = root.modelInput;
const config = getAccionaConfig();
const axCode = input.axCode;
const model = input.family;
const referenceDatabase = process.argv[3] ?? extractionDatabaseName(config, input.manufacturer, input.epc ?? epcFromDate(root.createdAt));

compareSandboxWithDatabase(axCode, model, referenceDatabase).then(async (result) => {
  await mkdir("compare-out", { recursive: true });
  await writeFile(`compare-out/${axCode}_${model}.json`, JSON.stringify({ axCode, model, referenceDatabase, generatedAt: new Date().toISOString(), approximate: true, counts: { added: result.added.length, deleted: result.deleted.length, changed: result.changed.length }, result }, null, 2));
  console.log(JSON.stringify({ referenceDatabase, approximate: true, added: result.added.length, deleted: result.deleted.length, changed: result.changed.length }));
  process.exit(0);
}).catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
