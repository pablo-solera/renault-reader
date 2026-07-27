import { app } from "./app.js";
import { config } from "./config.js";
import { getRenaultCredentials } from "./config.js";
import { ensureBucket } from "./storage.js";

getRenaultCredentials();
await ensureBucket();
app.listen(config.port, "localhost", () => console.log(`renault-reader listening on http://localhost:${config.port}`));
