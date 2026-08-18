import type { GmailMetadataReviewRequest } from "@village/contracts";
import { describe, expect, it, vi } from "vitest";
import { GmailMetadataProvider } from "../src/gmail/gmail-metadata-provider.js";

const request: GmailMetadataReviewRequest = {
  schemaVersion: 1,
  provider: "GMAIL",
  scope: "https://www.googleapis.com/auth/gmail.metadata",
  maxMessages: 2,
  lookbackDays: 3,
  unreadOnly: true,
};

function accessTokenSource() {
  return {
    withAccessToken: async <T>(use: (value: Uint8Array) => Promise<T>) => {
      const value = new TextEncoder().encode("access-secret");
      try {
        return await use(value);
      } finally {
        value.fill(0);
      }
    },
  };
}

describe("Gmail metadata provider", () => {
  it("lists only a bounded inbox and fetches metadata without query, snippet, or body", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(String(input));
      expect(init?.headers).toEqual({ Authorization: "Bearer access-secret" });
      if (url.pathname.endsWith("/users/me/messages")) {
        expect(url.searchParams.getAll("labelIds")).toEqual([
          "INBOX",
          "UNREAD",
        ]);
        expect(url.searchParams.get("maxResults")).toBe("2");
        expect(url.searchParams.get("fields")).toBe("messages/id");
        expect(url.searchParams.has("q")).toBe(false);
        return Response.json({ messages: [{ id: "m1" }, { id: "m2" }] });
      }
      expect(url.pathname).toMatch(/\/users\/me\/messages\/m[12]$/);
      expect(url.searchParams.get("format")).toBe("METADATA");
      expect(url.searchParams.get("fields")).toBe(
        "id,labelIds,internalDate,payload/headers",
      );
      expect(url.searchParams.getAll("metadataHeaders")).toEqual([
        "From",
        "Subject",
      ]);
      const id = url.pathname.endsWith("m1") ? "m1" : "m2";
      return Response.json({
        id,
        labelIds: id === "m1" ? ["INBOX", "UNREAD"] : ["INBOX"],
        internalDate:
          id === "m1"
            ? String(Date.UTC(2026, 7, 16))
            : String(Date.UTC(2026, 6, 1)),
        payload: {
          headers: [
            {
              name: "From",
              value: id === "m1" ? "Boss <boss@example.com>" : "Old",
            },
            {
              name: "Subject",
              value: id === "m1" ? "Need your decision" : "Old mail",
            },
          ],
          body: { data: "must-not-be-read" },
        },
        snippet: "must-not-be-read",
      });
    });
    const provider = new GmailMetadataProvider({
      accessTokens: accessTokenSource(),
      fetch,
      now: () => new Date("2026-08-17T12:00:00.000Z"),
    });

    await expect(provider.review(request)).resolves.toEqual({
      status: "result",
      provider: "GMAIL",
      messages: [
        {
          messageNumber: 1,
          from: "Boss <boss@example.com>",
          subject: "Need your decision",
          receivedAt: "2026-08-16T00:00:00.000Z",
          unread: true,
          labelIds: ["INBOX", "UNREAD"],
          taint: "UNTRUSTED_GMAIL_METADATA",
        },
      ],
    });
  });

  it("hydrates metadata concurrently while preserving Gmail list order", async () => {
    let active = 0;
    let maximumActive = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/users/me/messages")) {
        return Response.json({
          messages: Array.from({ length: 6 }, (_, index) => ({
            id: `m${index + 1}`,
          })),
        });
      }
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      const id = url.pathname.split("/").at(-1)!;
      await new Promise((resolve) => setTimeout(resolve, id === "m1" ? 10 : 1));
      active -= 1;
      return Response.json({
        id,
        labelIds: ["INBOX", "UNREAD"],
        internalDate: String(Date.UTC(2026, 7, 16)),
        payload: {
          headers: [
            { name: "From", value: `${id}@example.com` },
            { name: "Subject", value: id },
          ],
        },
      });
    });
    const provider = new GmailMetadataProvider({
      accessTokens: accessTokenSource(),
      fetch,
      now: () => new Date("2026-08-17T12:00:00.000Z"),
    });

    const result = await provider.review({ ...request, maxMessages: 6 });

    expect(result.status).toBe("result");
    if (result.status !== "result") throw new Error("expected Gmail result");
    expect(result.messages.map(({ subject }) => subject)).toEqual([
      "m1",
      "m2",
      "m3",
      "m4",
      "m5",
      "m6",
    ]);
    expect(result.messages.map(({ messageNumber }) => messageNumber)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    expect(maximumActive).toBeGreaterThan(1);
    expect(maximumActive).toBeLessThanOrEqual(4);
  });

  it("skips a message deleted between the list and metadata requests", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/users/me/messages")) {
        return Response.json({ messages: [{ id: "deleted" }, { id: "kept" }] });
      }
      if (url.pathname.endsWith("/deleted")) {
        return new Response(null, { status: 404 });
      }
      return Response.json({
        id: "kept",
        labelIds: ["INBOX", "UNREAD"],
        internalDate: String(Date.UTC(2026, 7, 16)),
        payload: {
          headers: [
            { name: "From", value: "owner@example.com" },
            { name: "Subject", value: "Still available" },
          ],
        },
      });
    });
    const provider = new GmailMetadataProvider({
      accessTokens: accessTokenSource(),
      fetch,
      now: () => new Date("2026-08-17T12:00:00.000Z"),
    });

    await expect(provider.review(request)).resolves.toMatchObject({
      status: "result",
      messages: [{ messageNumber: 1, subject: "Still available" }],
    });
  });

  it("maps auth, transport, malformed, and cancellation failures to bounded results", async () => {
    const unauthenticated = new GmailMetadataProvider({
      accessTokens: {
        withAccessToken: async () => {
          throw new Error("SECRET_REVOKED");
        },
      },
      fetch: vi.fn(),
    });
    await expect(unauthenticated.review(request)).resolves.toEqual({
      status: "waiting",
      provider: "GMAIL",
      reason: "AUTHENTICATION_REQUIRED",
    });

    const unavailable = new GmailMetadataProvider({
      accessTokens: accessTokenSource(),
      fetch: vi.fn(async () => {
        throw new TypeError("offline");
      }),
    });
    await expect(unavailable.review(request)).resolves.toEqual({
      status: "waiting",
      provider: "GMAIL",
      reason: "PROVIDER_UNAVAILABLE",
    });

    const malformed = new GmailMetadataProvider({
      accessTokens: accessTokenSource(),
      fetch: vi.fn(async () => Response.json({ messages: [{ id: 42 }] })),
    });
    await expect(malformed.review(request)).resolves.toEqual({
      status: "waiting",
      provider: "GMAIL",
      reason: "MALFORMED_PROVIDER_OUTPUT",
    });

    const cancellation = new AbortController();
    cancellation.abort();
    await expect(
      unavailable.review(request, { signal: cancellation.signal }),
    ).rejects.toThrow("RITUAL_RUN_CANCELED");
  });

  it.each([
    [401, "AUTHENTICATION_REQUIRED"],
    [403, "AUTHENTICATION_REQUIRED"],
    [429, "RATE_LIMITED"],
    [422, "PROVIDER_REQUEST_REJECTED"],
    [500, "PROVIDER_UNAVAILABLE"],
  ] as const)("maps Gmail HTTP %s to %s", async (status, reason) => {
    const provider = new GmailMetadataProvider({
      accessTokens: accessTokenSource(),
      fetch: vi.fn(async () => new Response(null, { status })),
    });
    await expect(provider.review(request)).resolves.toEqual({
      status: "waiting",
      provider: "GMAIL",
      reason,
    });
  });

  it("rejects an oversized response before parsing it", async () => {
    const provider = new GmailMetadataProvider({
      accessTokens: accessTokenSource(),
      fetch: vi.fn(
        async () =>
          new Response("{}", {
            headers: { "content-length": String(256 * 1_024 + 1) },
          }),
      ),
    });
    await expect(provider.review(request)).resolves.toEqual({
      status: "waiting",
      provider: "GMAIL",
      reason: "MALFORMED_PROVIDER_OUTPUT",
    });
  });

  it("bounds stalled credential resolution without starting a late Gmail request", async () => {
    let resolveCredential!: (value: Uint8Array) => void;
    const credential = new Promise<Uint8Array>((resolve) => {
      resolveCredential = resolve;
    });
    const fetch = vi.fn<typeof globalThis.fetch>();
    const provider = new GmailMetadataProvider({
      accessTokens: {
        withAccessToken: async <T>(use: (value: Uint8Array) => Promise<T>) =>
          use(await credential),
      },
      fetch,
      timeoutMs: 5,
    });

    await expect(provider.review(request)).resolves.toEqual({
      status: "waiting",
      provider: "GMAIL",
      reason: "TIME_BUDGET_EXHAUSTED",
    });
    resolveCredential(new TextEncoder().encode("access-secret"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetch).not.toHaveBeenCalled();
  });
});
