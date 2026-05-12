/** GET /api/assistant/health — readiness/liveness (plan B-10). */

import type { Request, Response } from "express";
import { config } from "../config.js";

const STARTED_AT = Date.now();

export function healthRoute(_req: Request, res: Response): void {
  const uptimeS = Math.floor((Date.now() - STARTED_AT) / 1000);
  res.json({
    ok: true,
    default_model: config.defaultModel,
    uptime_s: uptimeS,
    // mcp_connected / anthropic_reachable are deferred to a deeper probe
    // (would require spawning the MCP subprocess on each /health hit). V1
    // reports ok:true if the process is up; deep checks via the /metrics or
    // a dedicated /readiness endpoint in R5.
  });
}
