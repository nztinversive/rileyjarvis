"use strict";

const path = require("node:path");
const dotenv = require("dotenv");
const { createSafeLogger, createVectorRealtimeServer } = require("./app.cjs");
const { loadConfig } = require("./config.cjs");

dotenv.config({ path: process.env.VECTOR_ENV_PATH || path.join(process.cwd(), ".env.local") });

const logger = createSafeLogger();

try {
  const config = loadConfig();
  const server = createVectorRealtimeServer({ config, logger });
  server.listen(config.port, config.host, () => {
    logger.info("server_started", { host: config.host, port: server.address().port, environment: config.nodeEnv });
  });
} catch (error) {
  logger.error("server_start_failed", { code: typeof error?.code === "string" ? error.code : "configuration_error" });
  process.exitCode = 1;
}
