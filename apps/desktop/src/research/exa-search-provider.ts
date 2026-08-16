import {
  webResearchRequestSchema,
  webResearchResultSchema,
  type WebResearchRequest,
  type WebResearchResult,
  type WebResearchWaitingReason,
} from "@village/contracts";
import { z } from "zod";
import type { ExaCredentialSource } from "./exa-credential-source.js";

const EXA_SEARCH_ENDPOINT = "https://api.exa.ai/search";
const MAX_RESPONSE_BYTES = 512 * 1_024;

const exaResponseSchema = z.object({
  requestId: z.string().trim().min(1).max(200),
  results: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(320),
        url: z.string().max(2_048),
        publishedDate: z.string().nullable().optional(),
        author: z.string().trim().min(1).max(160).nullable().optional(),
        highlights: z
          .array(z.string().trim().min(1).max(2_000))
          .max(8)
          .optional(),
      }),
    )
    .max(10),
});

export interface WebResearchProvider {
  search(request: WebResearchRequest): Promise<WebResearchResult>;
}

export class ExaSearchProvider implements WebResearchProvider {
  private readonly credentials: ExaCredentialSource;
  private readonly request: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(dependencies: {
    credentials: ExaCredentialSource;
    fetch?: typeof globalThis.fetch;
    timeoutMs?: number;
  }) {
    this.credentials = dependencies.credentials;
    this.request = dependencies.fetch ?? globalThis.fetch;
    this.timeoutMs = dependencies.timeoutMs ?? 15_000;
    if (this.timeoutMs < 1 || this.timeoutMs > 30_000) {
      throw new Error("INVALID_EXA_TIMEOUT");
    }
  }

  async search(candidate: WebResearchRequest): Promise<WebResearchResult> {
    const request = webResearchRequestSchema.parse(candidate);
    const controller = new AbortController();
    let resolveDeadline!: (result: WebResearchResult) => void;
    const deadline = new Promise<WebResearchResult>((resolve) => {
      resolveDeadline = resolve;
    });
    const timeout = setTimeout(() => {
      controller.abort();
      resolveDeadline(waiting("TIME_BUDGET_EXHAUSTED"));
    }, this.timeoutMs);
    const work = this.credentials
      .withApiKey(async (apiKey) => new Uint8Array(apiKey))
      .then(async (apiKey) => {
        try {
          return controller.signal.aborted
            ? waiting("TIME_BUDGET_EXHAUSTED")
            : await this.searchWithCredential(
                request,
                apiKey,
                controller.signal,
              );
        } finally {
          apiKey.fill(0);
        }
      })
      .catch((error: unknown) => credentialFailure(error));
    try {
      return await Promise.race([work, deadline]);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async searchWithCredential(
    request: WebResearchRequest,
    apiKeyBytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<WebResearchResult> {
    let apiKey = "";
    try {
      apiKey = new TextDecoder("utf-8", { fatal: true }).decode(apiKeyBytes);
      if (!/^[\x21-\x7e]{8,512}$/.test(apiKey)) {
        throw new Error("EXA_API_KEY_INVALID");
      }
      const body = {
        query: request.query,
        type: "auto",
        numResults: request.maxResults,
        ...(request.publishedAfter
          ? { startPublishedDate: request.publishedAfter }
          : {}),
        ...(request.includeDomains
          ? { includeDomains: request.includeDomains }
          : {}),
        moderation: true,
        contents: { highlights: true },
      };
      let response: Response;
      try {
        response = await this.request(EXA_SEARCH_ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal,
        });
      } catch {
        return waiting(
          signal.aborted ? "TIME_BUDGET_EXHAUSTED" : "PROVIDER_UNAVAILABLE",
        );
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return waiting(reasonForStatus(response.status));
      }
      let candidate: unknown;
      try {
        candidate = JSON.parse(await readBoundedBody(response));
      } catch {
        return waiting(
          signal.aborted
            ? "TIME_BUDGET_EXHAUSTED"
            : "MALFORMED_PROVIDER_OUTPUT",
        );
      }
      const raw = exaResponseSchema.safeParse(candidate);
      if (!raw.success || raw.data.results.length > request.maxResults) {
        return waiting("MALFORMED_PROVIDER_OUTPUT");
      }
      const result = webResearchResultSchema.safeParse({
        status: "result",
        provider: "EXA",
        requestId: raw.data.requestId,
        sources: raw.data.results.map((source) => {
          const url = canonicalSourceUrl(source.url);
          if (!sourceMatchesDomains(url, request.includeDomains)) {
            throw new Error("EXA_SOURCE_DOMAIN_OUT_OF_SCOPE");
          }
          return {
            title: source.title,
            url,
            publishedAt: normalizePublishedAt(source.publishedDate),
            author: source.author ?? null,
            highlights: source.highlights ?? [],
            taint: "UNTRUSTED_WEB",
          };
        }),
      });
      return result.success
        ? result.data
        : waiting("MALFORMED_PROVIDER_OUTPUT");
    } catch (error) {
      if (error instanceof Error && error.message === "EXA_API_KEY_INVALID") {
        throw error;
      }
      return waiting(
        signal.aborted ? "TIME_BUDGET_EXHAUSTED" : "MALFORMED_PROVIDER_OUTPUT",
      );
    } finally {
      apiKey = "";
    }
  }
}

function reasonForStatus(status: number): WebResearchWaitingReason {
  if (status === 401 || status === 403) return "AUTHENTICATION_REQUIRED";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 400 && status < 500) return "PROVIDER_REQUEST_REJECTED";
  return "PROVIDER_UNAVAILABLE";
}

function credentialFailure(error: unknown): WebResearchResult {
  if (
    error instanceof Error &&
    ["SECRET_REVOKED", "EXA_API_KEY_INVALID"].includes(error.message)
  ) {
    return waiting("AUTHENTICATION_REQUIRED");
  }
  return waiting("CREDENTIAL_STORE_UNAVAILABLE");
}

function waiting(reason: WebResearchWaitingReason): WebResearchResult {
  return webResearchResultSchema.parse({
    status: "waiting",
    provider: "EXA",
    reason,
  });
}

function canonicalSourceUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("EXA_SOURCE_URL_UNSAFE");
  }
  url.search = "";
  url.hash = "";
  return url.toString();
}

function normalizePublishedAt(value: string | null | undefined): string | null {
  if (!value) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value;
}

function sourceMatchesDomains(
  value: string,
  domains: WebResearchRequest["includeDomains"],
): boolean {
  if (!domains?.length) return true;
  const hostname = new URL(value).hostname.toLowerCase();
  return domains.some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
  );
}

async function readBoundedBody(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error("EXA_RESPONSE_TOO_LARGE");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  const chunks: string[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        throw new Error("EXA_RESPONSE_TOO_LARGE");
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}
