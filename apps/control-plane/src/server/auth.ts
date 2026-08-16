import {
  principalIdSchema,
  villageIdentitySessionSchema,
  type VillageIdentitySession,
} from "@village/contracts";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Environment } from "../env.js";

const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const jwksByDomain = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function encodePrincipalHash(bytes: Uint8Array): string {
  let buffer = 0;
  let bits = 0;
  let encoded = "";
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded += alphabet[(buffer >>> bits) & 31];
    }
  }
  if (bits > 0) encoded += alphabet[(buffer << (5 - bits)) & 31];
  return encoded.padEnd(26, "0").slice(0, 26);
}

async function principalForSubject(
  db: D1Database,
  provider: string,
  subject: string,
  now: string,
): Promise<string> {
  const existing = await db
    .prepare(
      "SELECT principal_id FROM principal_identities WHERE provider = ? AND subject = ?",
    )
    .bind(provider, subject)
    .first<{ principal_id: string }>();
  if (existing) return principalIdSchema.parse(existing.principal_id);
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${provider}\u0000${subject}`),
    ),
  );
  const principalId = principalIdSchema.parse(
    `prn_${encodePrincipalHash(digest.slice(0, 16))}`,
  );
  await db.batch([
    db
      .prepare(
        "INSERT OR IGNORE INTO principals (principal_id, created_at) VALUES (?, ?)",
      )
      .bind(principalId, now),
    db
      .prepare(
        `INSERT OR IGNORE INTO principal_identities
         (provider, subject, principal_id, created_at) VALUES (?, ?, ?, ?)`,
      )
      .bind(provider, subject, principalId, now),
  ]);
  return principalId;
}

export async function authenticateRequest(
  request: Request,
  environment: Environment,
  now = new Date().toISOString(),
): Promise<
  | {
      ok: true;
      principalId: string;
      identity: VillageIdentitySession;
    }
  | { ok: false; code: string }
> {
  if (environment.VILLAGE_AUTH_MODE === "development-header") {
    if (
      environment.VILLAGE_ENVIRONMENT !== "development" &&
      environment.VILLAGE_ENVIRONMENT !== "test"
    ) {
      return { ok: false, code: "INSECURE_AUTH_MODE_DISABLED" };
    }
    const candidate = request.headers.get("x-village-development-principal");
    const parsed = principalIdSchema.safeParse(candidate);
    if (!parsed.success) return { ok: false, code: "UNAUTHENTICATED" };
    await environment.VILLAGE_DB.prepare(
      "INSERT OR IGNORE INTO principals (principal_id, created_at) VALUES (?, ?)",
    )
      .bind(parsed.data, now)
      .run();
    const identity = villageIdentitySessionSchema.parse({
      authenticated: true,
      principalId: parsed.data,
      provider: "DEVELOPMENT",
    });
    return { ok: true, principalId: identity.principalId, identity };
  }

  const domain = environment.CF_ACCESS_TEAM_DOMAIN;
  const audience = environment.CF_ACCESS_AUD;
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!domain || !audience || !token) {
    return { ok: false, code: "UNAUTHENTICATED" };
  }
  try {
    const issuer = new URL(domain).origin;
    let keys = jwksByDomain.get(issuer);
    if (!keys) {
      keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
      jwksByDomain.set(issuer, keys);
    }
    const { payload } = await jwtVerify(token, keys, {
      issuer,
      audience,
      algorithms: ["RS256"],
    });
    if (!payload.sub || typeof payload.email !== "string") {
      return { ok: false, code: "UNAUTHENTICATED" };
    }
    const identity = villageIdentitySessionSchema.parse({
      authenticated: true,
      principalId: await principalForSubject(
        environment.VILLAGE_DB,
        issuer,
        payload.sub,
        now,
      ),
      provider: "CLOUDFLARE_ACCESS",
      email: payload.email,
      signOutPath: "/cdn-cgi/access/logout",
    });
    return { ok: true, principalId: identity.principalId, identity };
  } catch {
    return { ok: false, code: "UNAUTHENTICATED" };
  }
}
