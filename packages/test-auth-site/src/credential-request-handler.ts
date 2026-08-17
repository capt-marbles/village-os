import { OWNED_FIXTURE_ORIGIN } from "@village/contracts";
import { renderOwnedFixtureLogin } from "./login.js";
import { fixtureJson } from "./request-handler.js";

export interface OwnedFixtureCredentialRequestHandlerOptions {
  readonly onDestinationRequest: (request: {
    readonly username: string;
    readonly password: string;
  }) => void | Promise<void>;
}

export function createOwnedFixtureCredentialRequestHandler(
  options: OwnedFixtureCredentialRequestHandlerOptions,
): (request: Request) => Promise<Response> {
  return async (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return fixtureJson({ code: "FIXTURE_ORIGIN_DENIED" }, 403);
    }
    if (
      url.origin !== OWNED_FIXTURE_ORIGIN ||
      url.username !== "" ||
      url.password !== ""
    ) {
      return fixtureJson({ code: "FIXTURE_ORIGIN_DENIED" }, 403);
    }
    if (url.pathname !== "/login" || url.search !== "" || url.hash !== "") {
      return fixtureJson({ code: "INVALID_FIXTURE_REQUEST" }, 400);
    }
    if (request.method === "GET") {
      return new Response(renderOwnedFixtureLogin(), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy":
            "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        },
      });
    }
    if (
      request.method !== "POST" ||
      request.headers.get("content-type") !==
        "application/x-www-form-urlencoded"
    ) {
      return fixtureJson({ code: "INVALID_FIXTURE_REQUEST" }, 400);
    }
    const body = await request.text();
    if (body.length > 4_096) {
      return fixtureJson({ code: "INVALID_FIXTURE_REQUEST" }, 400);
    }
    const form = new URLSearchParams(body);
    const keys = [...form.keys()];
    const username = form.get("username");
    const password = form.get("password");
    if (
      keys.length !== 2 ||
      keys[0] !== "username" ||
      keys[1] !== "password" ||
      username === null ||
      username.length > 128 ||
      password === null ||
      password.length < 1 ||
      password.length > 1_024
    ) {
      return fixtureJson({ code: "INVALID_FIXTURE_REQUEST" }, 400);
    }
    await options.onDestinationRequest({ username, password });
    return new Response(null, {
      status: 204,
      headers: { "cache-control": "no-store" },
    });
  };
}
