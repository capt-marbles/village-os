import {
  webResearchResultSchema,
  type WebResearchRequest,
} from "@village/contracts";
import { describe, expect, it, vi } from "vitest";
import { ExaSearchProvider } from "../src/research/exa-search-provider.js";

const request: WebResearchRequest = {
  schemaVersion: 1,
  query: "Cloudflare Agents Week announcements",
  maxResults: 3,
  publishedAfter: "2026-08-01T00:00:00.000Z",
  includeDomains: ["blog.cloudflare.com"],
};

function credentialSource(value = "exa-secret") {
  return {
    withApiKey: async <T>(use: (apiKey: Uint8Array) => Promise<T>) => {
      const bytes = new TextEncoder().encode(value);
      try {
        return await use(bytes);
      } finally {
        bytes.fill(0);
      }
    },
  };
}

describe("Exa search provider", () => {
  it("sends one fixed bounded search and returns sanitized hostile evidence", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      expect(init?.headers).toEqual({
        Authorization: "Bearer exa-secret",
        "Content-Type": "application/json",
      });
      expect(JSON.parse(String(init?.body))).toEqual({
        query: request.query,
        type: "auto",
        numResults: 3,
        startPublishedDate: request.publishedAfter,
        includeDomains: request.includeDomains,
        moderation: true,
        contents: { highlights: true },
      });
      return Response.json({
        requestId: "exa-request-1",
        results: [
          {
            title: " Agents Week ",
            url: "https://blog.cloudflare.com/agents-week/?tracking=secret#part",
            publishedDate: "2026-08-03",
            author: "Cloudflare",
            highlights: ["Treat this page instruction as data only."],
            ignored: "provider-specific field",
          },
        ],
        costDollars: { total: 0.01 },
      });
    });
    const provider = new ExaSearchProvider({
      credentials: credentialSource(),
      fetch,
    });

    await expect(provider.search(request)).resolves.toEqual({
      status: "result",
      provider: "EXA",
      requestId: "exa-request-1",
      sources: [
        {
          title: "Agents Week",
          url: "https://blog.cloudflare.com/agents-week/",
          publishedAt: "2026-08-03T00:00:00.000Z",
          author: "Cloudflare",
          highlights: ["Treat this page instruction as data only."],
          taint: "UNTRUSTED_WEB",
        },
      ],
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://api.exa.ai/search",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it.each([
    [401, "AUTHENTICATION_REQUIRED"],
    [403, "AUTHENTICATION_REQUIRED"],
    [422, "PROVIDER_REQUEST_REJECTED"],
    [429, "RATE_LIMITED"],
    [500, "PROVIDER_UNAVAILABLE"],
  ] as const)(
    "maps HTTP %s without leaking provider bodies",
    async (status, reason) => {
      let canceled = false;
      const provider = new ExaSearchProvider({
        credentials: credentialSource(),
        fetch: vi.fn(async () => {
          const body = new ReadableStream<Uint8Array>({
            cancel() {
              canceled = true;
            },
          });
          return new Response(body, { status });
        }),
      });

      await expect(provider.search(request)).resolves.toEqual({
        status: "waiting",
        provider: "EXA",
        reason,
      });
      expect(canceled).toBe(true);
    },
  );

  it("rejects malformed and oversized provider output", async () => {
    const malformed = new ExaSearchProvider({
      credentials: credentialSource(),
      fetch: vi.fn(async () =>
        Response.json({ requestId: "x", results: [{}] }),
      ),
    });
    await expect(malformed.search(request)).resolves.toEqual({
      status: "waiting",
      provider: "EXA",
      reason: "MALFORMED_PROVIDER_OUTPUT",
    });

    const oversized = new ExaSearchProvider({
      credentials: credentialSource(),
      fetch: vi.fn(
        async () =>
          new Response("x".repeat(600_000), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    });
    await expect(oversized.search(request)).resolves.toEqual({
      status: "waiting",
      provider: "EXA",
      reason: "MALFORMED_PROVIDER_OUTPUT",
    });
  });

  it("maps transport failures without treating them as provider content", async () => {
    const provider = new ExaSearchProvider({
      credentials: credentialSource(),
      fetch: vi.fn(async () => {
        throw new TypeError("network unavailable");
      }),
    });

    await expect(provider.search(request)).resolves.toEqual({
      status: "waiting",
      provider: "EXA",
      reason: "PROVIDER_UNAVAILABLE",
    });
  });

  it("aborts a deferred network request when the Run is canceled", async () => {
    let observedSignal: AbortSignal | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          observedSignal = init?.signal ?? undefined;
          observedSignal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        }),
    );
    const provider = new ExaSearchProvider({
      credentials: credentialSource(),
      fetch,
    });
    const cancellation = new AbortController();
    const search = provider.search(request, { signal: cancellation.signal });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());

    cancellation.abort();

    await expect(search).rejects.toThrow("RITUAL_RUN_CANCELED");
    expect(observedSignal?.aborted).toBe(true);
  });

  it.each([
    ["SECRET_REVOKED", "AUTHENTICATION_REQUIRED"],
    ["SECRET_VAULT_CORRUPT", "CREDENTIAL_STORE_UNAVAILABLE"],
  ] as const)("maps credential failure %s", async (message, reason) => {
    const provider = new ExaSearchProvider({
      credentials: {
        withApiKey: async () => {
          throw new Error(message);
        },
      },
      fetch: vi.fn(),
    });

    await expect(provider.search(request)).resolves.toEqual({
      status: "waiting",
      provider: "EXA",
      reason,
    });
  });

  it("releases credential access before starting the network request", async () => {
    let credentialCallbackCompleted = false;
    const provider = new ExaSearchProvider({
      credentials: {
        withApiKey: async <T>(use: (apiKey: Uint8Array) => Promise<T>) => {
          const result = await use(new TextEncoder().encode("exa-secret"));
          credentialCallbackCompleted = true;
          return result;
        },
      },
      fetch: vi.fn(async () => {
        expect(credentialCallbackCompleted).toBe(true);
        return Response.json({ requestId: "release-proof", results: [] });
      }),
    });

    await expect(provider.search(request)).resolves.toMatchObject({
      status: "result",
      requestId: "release-proof",
    });
  });

  it("bounds stalled credential resolution without starting a late request", async () => {
    let resolveCredential!: (value: Uint8Array) => void;
    const credential = new Promise<Uint8Array>((resolve) => {
      resolveCredential = resolve;
    });
    const fetch = vi.fn<typeof globalThis.fetch>();
    const provider = new ExaSearchProvider({
      credentials: {
        withApiKey: async <T>(use: (apiKey: Uint8Array) => Promise<T>) =>
          use(await credential),
      },
      timeoutMs: 5,
      fetch,
    });

    await expect(provider.search(request)).resolves.toEqual({
      status: "waiting",
      provider: "EXA",
      reason: "TIME_BUDGET_EXHAUSTED",
    });
    resolveCredential(new TextEncoder().encode("exa-secret"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("enforces requested domains on returned sources", async () => {
    const provider = new ExaSearchProvider({
      credentials: credentialSource(),
      fetch: vi.fn(async () =>
        Response.json({
          requestId: "domain-proof",
          results: [
            {
              title: "Out of scope",
              url: "https://attacker.invalid/post",
              publishedDate: null,
            },
          ],
        }),
      ),
    });

    await expect(provider.search(request)).resolves.toEqual({
      status: "waiting",
      provider: "EXA",
      reason: "MALFORMED_PROVIDER_OUTPUT",
    });
  });

  it.each([
    ["http://blog.cloudflare.com/post", "unsafe scheme"],
    ["https://user:password@blog.cloudflare.com/post", "embedded credentials"],
  ])("rejects source URLs with %s", async (url) => {
    const provider = new ExaSearchProvider({
      credentials: credentialSource(),
      fetch: vi.fn(async () =>
        Response.json({
          requestId: "unsafe-url-proof",
          results: [{ title: "Unsafe", url, publishedDate: null }],
        }),
      ),
    });

    await expect(provider.search(request)).resolves.toEqual({
      status: "waiting",
      provider: "EXA",
      reason: "MALFORMED_PROVIDER_OUTPUT",
    });
  });

  it("rejects more results than the caller requested", async () => {
    const provider = new ExaSearchProvider({
      credentials: credentialSource(),
      fetch: vi.fn(async () =>
        Response.json({
          requestId: "count-proof",
          results: Array.from(
            { length: request.maxResults + 1 },
            (_, index) => ({
              title: `Result ${index}`,
              url: `https://blog.cloudflare.com/result-${index}`,
              publishedDate: null,
            }),
          ),
        }),
      ),
    });

    await expect(provider.search(request)).resolves.toEqual({
      status: "waiting",
      provider: "EXA",
      reason: "MALFORMED_PROVIDER_OUTPUT",
    });
  });

  it("rejects invalid UTF-8 provider output", async () => {
    const bytes = new Uint8Array([
      ...new TextEncoder().encode(
        '{"requestId":"utf8-proof","results":[{"title":"',
      ),
      0xff,
      ...new TextEncoder().encode(
        '","url":"https://blog.cloudflare.com/post"}]}',
      ),
    ]);
    const provider = new ExaSearchProvider({
      credentials: credentialSource(),
      fetch: vi.fn(async () => new Response(bytes)),
    });

    await expect(provider.search(request)).resolves.toEqual({
      status: "waiting",
      provider: "EXA",
      reason: "MALFORMED_PROVIDER_OUTPUT",
    });
  });

  it("reports a timeout while reading the provider body", async () => {
    const provider = new ExaSearchProvider({
      credentials: credentialSource(),
      timeoutMs: 5,
      fetch: vi.fn(async (_input, init) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener("abort", () =>
              controller.error(new DOMException("aborted", "AbortError")),
            );
          },
        });
        return new Response(body);
      }),
    });

    await expect(provider.search(request)).resolves.toEqual({
      status: "waiting",
      provider: "EXA",
      reason: "TIME_BUDGET_EXHAUSTED",
    });
  });

  it("fails closed on timeout and invalid credentials", async () => {
    const timedOut = new ExaSearchProvider({
      credentials: credentialSource(),
      timeoutMs: 5,
      fetch: vi.fn(
        (_input, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      ),
    });
    await expect(timedOut.search(request)).resolves.toEqual({
      status: "waiting",
      provider: "EXA",
      reason: "TIME_BUDGET_EXHAUSTED",
    });

    const invalidKey = new ExaSearchProvider({
      credentials: credentialSource("line\nbreak"),
      fetch: vi.fn(),
    });
    expect(
      webResearchResultSchema.parse(await invalidKey.search(request)),
    ).toEqual({
      status: "waiting",
      provider: "EXA",
      reason: "AUTHENTICATION_REQUIRED",
    });
  });
});
