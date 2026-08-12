import { createServer } from "node:http";

const body = `<!doctype html>
<html lang="en"><meta charset="utf-8"><title>Village-owned auth fixture</title>
<body><main><h1>Village-owned authentication fixture</h1>
<p>Dummy values only. This fixture does not transmit or persist input.</p>
<form onsubmit="event.preventDefault();document.querySelector('output').textContent='authenticated fixture state';">
<label>Fixture user <input autocomplete="off"></label>
<label>Fixture secret <input type="password" autocomplete="off"></label>
<button>Sign in to fixture</button><output></output>
</form></main></body></html>`;

const server = createServer((request, response) => {
  response.writeHead(request.url === "/auth" ? 200 : 404, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'",
  });
  response.end(request.url === "/auth" ? body : "Not found");
});

server.listen(4173, "127.0.0.1", () => {
  console.log("Owned fixture listening at http://127.0.0.1:4173/auth");
});
