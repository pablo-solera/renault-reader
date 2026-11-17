import { createRenaultContainer } from "./composition/container.js";
import { createWorkerRuntime } from "./composition/worker-runtime.js";

await createWorkerRuntime(createRenaultContainer());
