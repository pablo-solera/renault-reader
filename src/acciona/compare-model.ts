import { mkdir, writeFile } from "node:fs/promises";
import { compareSandboxWithDatabase } from "./compare.js";

const axCode = process.argv[2] ?? "5208";
const model = process.argv[3] ?? "X1310";
const referenceDatabase = process.env.ACCIONA_SQL_REFERENCE_DB ?? "Extraccion_DACIA0826";

compareSandboxWithDatabase(axCode, model, referenceDatabase).then(async (result) => {
  await mkdir("compare-out", { recursive: true });
  await writeFile(`compare-out/${axCode}_${model}.json`, JSON.stringify({ axCode, model, referenceDatabase, generatedAt: new Date().toISOString(), approximate: true, counts: { added: result.added.length, deleted: result.deleted.length, changed: result.changed.length }, result }, null, 2));
  console.log(JSON.stringify({ referenceDatabase, approximate: true, added: result.added.length, deleted: result.deleted.length, changed: result.changed.length }));
  process.exit(0);
}).catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
