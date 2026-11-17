import { startApi } from "@pablosla/core-reader/interfaces/http/express/server";
import { createRenaultContainer } from "./composition/container.js";

const container = createRenaultContainer();
await container.objectStorage.ensureBucket();
startApi({ app: container.app, host: container.config.HOST, port: container.config.PORT, logger: container.logger, close: () => container.close() });
