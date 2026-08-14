import { OWNED_FIXTURE_ORIGIN } from "@village/contracts";

export interface FixtureProtocol {
  handle(
    scheme: string,
    handler: (request: Request) => Promise<Response>,
  ): Promise<void>;
  unhandle(scheme: string): Promise<void>;
}

function denied(): Response {
  return new Response(JSON.stringify({ code: "FIXTURE_ORIGIN_DENIED" }), {
    status: 403,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function installFixtureSessionHandler(
  fixtureProtocol: FixtureProtocol,
  applicationHandler: (request: Request) => Promise<Response>,
): Promise<() => Promise<void>> {
  await fixtureProtocol.handle("https", async (request) => {
    try {
      const url = new URL(request.url);
      if (
        url.origin !== OWNED_FIXTURE_ORIGIN ||
        url.username !== "" ||
        url.password !== ""
      ) {
        return denied();
      }
    } catch {
      return denied();
    }
    return applicationHandler(request);
  });
  let closed = false;
  return async () => {
    if (closed) return;
    closed = true;
    await fixtureProtocol.unhandle("https");
  };
}
