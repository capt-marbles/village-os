import {
  gmailMetadataReviewRequestSchema,
  gmailMetadataReviewResultSchema,
  type GmailMetadataReviewRequest,
  type GmailMetadataReviewResult,
  type GmailMetadataWaitingReason,
  type GmailMessageMetadata,
} from "@village/contracts";
import { z } from "zod";
import type { GmailAccessTokenSource } from "./gmail-oauth-controller.js";
import { readBoundedResponseBody } from "../net/read-bounded-response-body.js";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const MAX_RESPONSE_BYTES = 256 * 1_024;
const HEADER_NAMES = ["From", "Subject"] as const;

const messageListSchema = z
  .object({
    messages: z
      .array(z.object({ id: z.string().trim().min(1).max(256) }).passthrough())
      .max(25)
      .optional(),
  })
  .passthrough();

const messageSchema = z
  .object({
    id: z.string().trim().min(1).max(256),
    labelIds: z.array(z.string().trim().min(1).max(128)).max(32).optional(),
    internalDate: z.string().regex(/^\d{1,20}$/),
    payload: z
      .object({
        headers: z
          .array(
            z.object({
              name: z.string().max(128),
              value: z.string().max(2_048),
            }),
          )
          .max(128),
      })
      .strip(),
  })
  .strip();

class GmailProviderError extends Error {
  constructor(readonly reason: GmailMetadataWaitingReason) {
    super(`GMAIL_${reason}`);
  }
}

export interface GmailMailboxProvider {
  review(
    request: GmailMetadataReviewRequest,
    options?: { signal?: AbortSignal },
  ): Promise<GmailMetadataReviewResult>;
}

export class GmailMetadataProvider implements GmailMailboxProvider {
  private readonly accessTokens: GmailAccessTokenSource;
  private readonly request: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(dependencies: {
    accessTokens: GmailAccessTokenSource;
    fetch?: typeof globalThis.fetch;
    timeoutMs?: number;
    now?: () => Date;
  }) {
    this.accessTokens = dependencies.accessTokens;
    this.request = dependencies.fetch ?? globalThis.fetch;
    this.timeoutMs = dependencies.timeoutMs ?? 15_000;
    this.now = dependencies.now ?? (() => new Date());
    if (this.timeoutMs < 1 || this.timeoutMs > 30_000) {
      throw new Error("INVALID_GMAIL_TIMEOUT");
    }
  }

  async review(
    candidate: GmailMetadataReviewRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<GmailMetadataReviewResult> {
    const request = gmailMetadataReviewRequestSchema.parse(candidate);
    if (options.signal?.aborted) throw new Error("RITUAL_RUN_CANCELED");
    const controller = new AbortController();
    let resolveDeadline!: (result: GmailMetadataReviewResult) => void;
    const deadline = new Promise<GmailMetadataReviewResult>((resolve) => {
      resolveDeadline = resolve;
    });
    let rejectCancellation!: (error: Error) => void;
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const cancel = () => {
      controller.abort();
      rejectCancellation(new Error("RITUAL_RUN_CANCELED"));
    };
    options.signal?.addEventListener("abort", cancel, { once: true });
    const timeout = setTimeout(() => {
      controller.abort();
      resolveDeadline(waiting("TIME_BUDGET_EXHAUSTED"));
    }, this.timeoutMs);
    const work = this.accessTokens
      .withAccessToken(
        (accessToken) =>
          this.reviewWithAccessToken(request, accessToken, controller.signal),
        { signal: controller.signal },
      )
      .catch((error: unknown) => mapFailure(error, controller.signal));
    try {
      return await Promise.race([work, deadline, cancellation]);
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", cancel);
    }
  }

  private async reviewWithAccessToken(
    request: GmailMetadataReviewRequest,
    accessTokenBytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<GmailMetadataReviewResult> {
    let accessToken = "";
    try {
      if (signal.aborted) throw new Error("GMAIL_REQUEST_ABORTED");
      accessToken = new TextDecoder("utf-8", { fatal: true }).decode(
        accessTokenBytes,
      );
      if (!/^[\x21-\x7e]{8,4096}$/.test(accessToken)) {
        throw new GmailProviderError("AUTHENTICATION_REQUIRED");
      }
      const listUrl = new URL(`${GMAIL_API}/messages`);
      listUrl.searchParams.set("labelIds", "INBOX");
      if (request.unreadOnly) listUrl.searchParams.append("labelIds", "UNREAD");
      listUrl.searchParams.set("maxResults", String(request.maxMessages));
      listUrl.searchParams.set("fields", "messages/id");
      const list = messageListSchema.parse(
        await this.getJson(listUrl.toString(), accessToken, signal),
      );
      const ids = list.messages ?? [];
      if (ids.length > request.maxMessages) {
        throw new GmailProviderError("MALFORMED_PROVIDER_OUTPUT");
      }
      const earliest =
        this.now().getTime() - request.lookbackDays * 24 * 60 * 60 * 1_000;
      const candidates = await mapWithConcurrency(ids, 4, async ({ id }) => {
        if (signal.aborted) throw new Error("GMAIL_REQUEST_ABORTED");
        const url = new URL(`${GMAIL_API}/messages/${encodeURIComponent(id)}`);
        url.searchParams.set("format", "METADATA");
        url.searchParams.set(
          "fields",
          "id,labelIds,internalDate,payload/headers",
        );
        for (const header of HEADER_NAMES) {
          url.searchParams.append("metadataHeaders", header);
        }
        const rawMessage = await this.getJson(
          url.toString(),
          accessToken,
          signal,
          { missingAsNull: true },
        );
        if (rawMessage === null) return null;
        const message = messageSchema.parse(rawMessage);
        if (message.id !== id) {
          throw new GmailProviderError("MALFORMED_PROVIDER_OUTPUT");
        }
        const received = Number(message.internalDate);
        if (!Number.isSafeInteger(received) || received < earliest) return null;
        const labelIds = message.labelIds ?? [];
        if (
          labelIds.includes("CATEGORY_PROMOTIONS") ||
          labelIds.includes("CATEGORY_SOCIAL")
        ) {
          return null;
        }
        const unread = labelIds.includes("UNREAD");
        if (request.unreadOnly && !unread) return null;
        return {
          messageNumber: 0,
          from: headerValue(message.payload.headers, "From", "Unknown sender"),
          subject: headerValue(
            message.payload.headers,
            "Subject",
            "(No subject)",
          ),
          receivedAt: new Date(received).toISOString(),
          unread,
          labelIds,
          taint: "UNTRUSTED_GMAIL_METADATA",
        } satisfies GmailMessageMetadata;
      });
      const hydrated = candidates
        .filter((message): message is GmailMessageMetadata => message !== null)
        .map((message, index) => ({
          messageNumber: index + 1,
          from: message.from,
          subject: message.subject,
          receivedAt: message.receivedAt,
          unread: message.unread,
          labelIds: message.labelIds,
          taint: message.taint,
        }));
      return gmailMetadataReviewResultSchema.parse({
        status: "result",
        provider: "GMAIL",
        messages: hydrated,
      });
    } catch (error) {
      if (error instanceof GmailProviderError) throw error;
      if (signal.aborted) throw new Error("GMAIL_REQUEST_ABORTED");
      throw new GmailProviderError("MALFORMED_PROVIDER_OUTPUT");
    } finally {
      accessToken = "";
    }
  }

  private async getJson(
    url: string,
    accessToken: string,
    signal: AbortSignal,
    options: { missingAsNull?: boolean } = {},
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.request(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal,
      });
    } catch {
      if (signal.aborted) throw new Error("GMAIL_REQUEST_ABORTED");
      throw new GmailProviderError("PROVIDER_UNAVAILABLE");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (
        options.missingAsNull &&
        (response.status === 404 || response.status === 410)
      ) {
        return null;
      }
      throw new GmailProviderError(reasonForStatus(response.status));
    }
    try {
      return JSON.parse(
        await readBoundedResponseBody(response, {
          maxBytes: MAX_RESPONSE_BYTES,
          errorCode: "GMAIL_RESPONSE_TOO_LARGE",
        }),
      );
    } catch {
      if (signal.aborted) throw new Error("GMAIL_REQUEST_ABORTED");
      throw new GmailProviderError("MALFORMED_PROVIDER_OUTPUT");
    }
  }
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  project: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  results.length = values.length;
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex++;
        results[index] = await project(values[index]!);
      }
    }),
  );
  return results;
}

function headerValue(
  headers: readonly { name: string; value: string }[],
  name: string,
  fallback: string,
): string {
  const value = headers.find(
    (header) => header.name.toLowerCase() === name.toLowerCase(),
  )?.value;
  const compact = value?.trim().replace(/[\r\n]+/g, " ");
  return (compact || fallback).slice(0, name === "Subject" ? 500 : 320);
}

function reasonForStatus(status: number): GmailMetadataWaitingReason {
  if (status === 401 || status === 403) return "AUTHENTICATION_REQUIRED";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 400 && status < 500) return "PROVIDER_REQUEST_REJECTED";
  return "PROVIDER_UNAVAILABLE";
}

function waiting(
  reason: GmailMetadataWaitingReason,
): GmailMetadataReviewResult {
  return gmailMetadataReviewResultSchema.parse({
    status: "waiting",
    provider: "GMAIL",
    reason,
  });
}

function mapFailure(
  error: unknown,
  signal: AbortSignal,
): GmailMetadataReviewResult {
  if (signal.aborted) return waiting("TIME_BUDGET_EXHAUSTED");
  if (error instanceof GmailProviderError) return waiting(error.reason);
  if (error instanceof Error && error.message === "SECRET_REVOKED") {
    return waiting("AUTHENTICATION_REQUIRED");
  }
  if (
    error instanceof Error &&
    [
      "GMAIL_REFRESH_CREDENTIAL_CORRUPT",
      "SECRET_VAULT_CORRUPT",
      "SECURE_SECRET_STORAGE_UNAVAILABLE",
    ].includes(error.message)
  ) {
    return waiting("CREDENTIAL_STORE_UNAVAILABLE");
  }
  return waiting("PROVIDER_UNAVAILABLE");
}
