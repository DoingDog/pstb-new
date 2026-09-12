import { createHttpApp } from "./http";
import type { Env } from "./types";

export default {
  fetch(request, env) {
    return createHttpApp(env).fetch(request);
  },
} satisfies ExportedHandler<Env>;
