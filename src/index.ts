import { createHttpApp } from "./http";
import { handleMcp } from "./mcp";
import type { Env } from "./types";

export default {
  fetch(request, env, ctx) {
    if (new URL(request.url).pathname === "/mcp") return handleMcp(request, env, ctx);
    return createHttpApp(env).fetch(request);
  },
} satisfies ExportedHandler<Env>;
