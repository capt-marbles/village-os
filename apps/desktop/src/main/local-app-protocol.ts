import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Protocol } from "electron";

const csp = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const indexHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <title>Village</title>
    <link rel="stylesheet" href="village://app/styles.css">
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="village://app/renderer.js"></script>
  </body>
</html>`;

const styles = `:root { color-scheme: dark; font-family: ui-sans-serif, system-ui; background: #101410; color: #f2f5ed; }
* { box-sizing: border-box; }
body { margin: 0; min-width: 320px; min-height: 100vh; background: radial-gradient(circle at 18% 10%, #283a28, #101410 45%); }
#root { width: 100%; min-width: 360px; height: 100vh; overflow: auto; }
.pairing-mode #root { width: 100%; }
.desktop-workspace { min-width: 360px; min-height: 100vh; overflow: hidden; }
.pairing-bootstrap { width: min(760px, calc(100% - 2rem)); margin: 0 auto; padding: 3rem 0; }
.pairing-bootstrap__eyebrow { color: #a8d48f; font-size: .75rem; font-weight: 800; letter-spacing: .14em; }
.pairing-bootstrap h1 { margin: .35rem 0 1rem; font-size: clamp(2rem, 7vw, 4rem); }
.pairing-bootstrap p { max-width: 68ch; color: #c2cec0; line-height: 1.6; }
.pairing-bootstrap__fingerprint { display: block; margin: .75rem 0 1rem; font: 800 1.15rem ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .08em; }
.pairing-bootstrap pre { overflow: auto; border: 1px solid #445047; border-radius: 14px; padding: 1rem; color: #eff7eb; background: #111711; user-select: all; }
.pairing-bootstrap section { margin-top: 1rem; border: 1px solid #36503a; border-radius: 14px; padding: 1rem; background: #172118; }
button:focus-visible { outline: 3px solid white !important; outline-offset: 3px; }
button:disabled { cursor: not-allowed !important; opacity: .52; }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition-duration: .01ms !important; animation-duration: .01ms !important; } }`;

const shieldHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
    <style>
      html, body { margin: 0; height: 100%; background: transparent; font-family: ui-sans-serif, system-ui; }
      body { display: grid; place-items: start center; }
      p { margin-top: 14px; padding: 7px 12px; border-radius: 999px; color: #eaf5e5; background: rgba(16, 20, 16, .88); font-size: 12px; letter-spacing: .08em; }
    </style>
  </head>
  <body><p>AGENT CONTROL · TAKE OVER FROM VILLAGE</p></body>
</html>`;

export function registerVillageScheme(
  protocolModule: typeof import("electron").protocol,
): void {
  protocolModule.registerSchemesAsPrivileged([
    {
      scheme: "village",
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: false,
      },
    },
  ]);
}

export function installVillageProtocol(
  protocolModule: Protocol,
  rendererRoot: string,
): void {
  const rendererSource = readFile(join(rendererRoot, "index.js"));
  protocolModule.handle("village", async (request) => {
    const url = new URL(request.url);
    if (url.host !== "app") return new Response("Not found", { status: 404 });
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(indexHtml, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (url.pathname === "/shield") {
      return new Response(shieldHtml, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (url.pathname === "/styles.css") {
      return new Response(styles, {
        headers: { "content-type": "text/css; charset=utf-8" },
      });
    }
    if (url.pathname === "/renderer.js") {
      return new Response(await rendererSource, {
        headers: { "content-type": "text/javascript; charset=utf-8" },
      });
    }
    return new Response("Not found", { status: 404 });
  });
}
