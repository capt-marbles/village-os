import type { Environment } from "./env.js";

declare global {
  namespace Cloudflare {
    interface Env extends Environment {}
  }
}

export {};
