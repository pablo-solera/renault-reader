import { runWorkerHealthcheck } from "@pablosla/core-reader/infrastructure/redis/worker-healthcheck";

await runWorkerHealthcheck({ namespace: "renault-reader", redisUrl: process.env.REDIS_URL });
