/** Wiki Assistant agent — Express server entrypoint. */

import express from "express";
import { config, validateMcpAuth } from "./config.js";
import { chatRoute } from "./routes/chat.js";
import { healthRoute } from "./routes/health.js";

function main(): void {
  validateMcpAuth();

  const app = express();
  app.use(express.json({ limit: "256kb" }));

  // Minimal cookie parser — we only need _hyperon_session for auth-tier detection.
  app.use((req, _res, next) => {
    const cookieHeader = req.headers.cookie ?? "";
    const cookies: Record<string, string> = {};
    for (const piece of cookieHeader.split(";")) {
      const [name, ...rest] = piece.trim().split("=");
      if (name) cookies[name] = decodeURIComponent(rest.join("="));
    }
    (req as express.Request & { cookies: Record<string, string> }).cookies = cookies;
    next();
  });

  app.get("/api/assistant/health", healthRoute);
  app.post("/api/assistant/chat", chatRoute);

  app.listen(config.port, () => {
    process.stdout.write(
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "info",
        msg: "magi-assistant-wiki listening",
        port: config.port,
        default_model: config.defaultModel,
      })}\n`,
    );
  });
}

main();
