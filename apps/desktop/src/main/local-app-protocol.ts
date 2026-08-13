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
    <main>
      <p class="eyebrow">VILLAGE DESKTOP</p>
      <h1>Work locally. Pick up anywhere.</h1>
      <p id="status">The browser is isolated in the pane beside this workspace.</p>
      <button id="takeover" type="button">Take control</button>
    </main>
    <script type="module" src="village://app/renderer.js"></script>
  </body>
</html>`;

const styles = `:root { color-scheme: dark; font-family: ui-sans-serif, system-ui; background: #101410; color: #f2f5ed; }
body { margin: 0; min-height: 100vh; background: radial-gradient(circle at 18% 10%, #283a28, #101410 45%); }
main { box-sizing: border-box; width: 58%; padding: 72px 48px; }
.eyebrow { color: #a8d48f; letter-spacing: .18em; font-size: 12px; }
h1 { max-width: 580px; font-size: clamp(38px, 6vw, 72px); line-height: .95; margin: 24px 0; }
p { color: #b8c2b3; max-width: 520px; line-height: 1.6; }
button { margin-top: 20px; border: 1px solid #a8d48f; border-radius: 999px; padding: 12px 20px; background: #a8d48f; color: #101410; font-weight: 700; }
button:focus-visible { outline: 3px solid white; outline-offset: 3px; }`;

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
