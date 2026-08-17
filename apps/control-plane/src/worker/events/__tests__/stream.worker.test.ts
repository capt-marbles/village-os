import { env } from "cloudflare:workers";
import { SELF, applyD1Migrations } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { BrowserControlState } from "@village/contracts";

const principalId = "prn_01J00000000000000000000005" as const;
const browserSessionId = "brs_01J00000000000000000000005" as const;
const deviceId = "dev_01J00000000000000000000005" as const;
const jobId = "job_01J00000000000000000000005" as const;
const now = "2026-08-12T18:00:00.000Z";
const csrf = "csrf_csrf_csrf_csrf_csrf_csrf_5678";

const ownerHeaders = {
  origin: "http://localhost:5173",
  cookie: `village_csrf=${csrf}`,
  "x-village-csrf": csrf,
  "x-village-development-principal": principalId,
};

beforeEach(async () => {
  await applyD1Migrations(env.VILLAGE_DB, env.TEST_MIGRATIONS!);
  await env.VILLAGE_DB.batch([
    env.VILLAGE_DB.prepare("DELETE FROM principals"),
    env.VILLAGE_DB.prepare(
      "INSERT INTO principals (principal_id, created_at) VALUES (?, ?)",
    ).bind(principalId, now),
    env.VILLAGE_DB.prepare(
      `INSERT INTO devices
       (principal_id, device_id, public_key, credential_status, protocol_version,
        last_accepted_sequence, created_at)
       VALUES (?, ?, '{}', 'ACTIVE', 1, 0, ?)`,
    ).bind(principalId, deviceId, now),
    env.VILLAGE_DB.prepare(
      `INSERT INTO jobs
       (principal_id, job_id, state, version, last_event_sequence, created_at, updated_at)
       VALUES (?, ?, 'WAITING_FOR_BROWSER', 2, 2, ?, ?)`,
    ).bind(principalId, jobId, now, now),
    env.VILLAGE_DB.prepare(
      `INSERT INTO browser_sessions
       (principal_id, browser_session_id, job_id, device_id, host_id, site,
        controller, connection_state, lease_epoch, last_accepted_sequence,
        automation_blocked, takeover_state, profile_state, updated_at)
       VALUES (?, ?, ?, ?, 'hst_01J00000000000000000000005', 'OWNED_FIXTURE',
        'NONE', 'ONLINE', 0, 0, 1, 'NONE', 'PRESENT', ?)`,
    ).bind(principalId, browserSessionId, jobId, deviceId, now),
  ]);
  const control: BrowserControlState = {
    principalId,
    deviceId,
    jobId,
    browserSessionId,
    controller: "NONE",
    connection: "ONLINE",
    leaseEpoch: 0,
    leaseExpiresAt: null,
    lastAcceptedSequence: 0,
    automationBlocked: true,
    takeover: "NONE",
    profile: "PRESENT",
  };
  await env.BROWSER_SESSION_COORDINATOR.getByName(browserSessionId).initialize({
    principalId,
    browserSessionId,
    site: "OWNED_FIXTURE",
    initializedAt: now,
    control,
  });
});

function nextMessage(webSocket: WebSocket) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    webSocket.addEventListener(
      "message",
      (event) =>
        resolve(JSON.parse(String(event.data)) as Record<string, unknown>),
      { once: true },
    );
    webSocket.addEventListener(
      "error",
      () => reject(new Error("stream error")),
      {
        once: true,
      },
    );
  });
}

async function connect(cursor: number, headers: HeadersInit = ownerHeaders) {
  const response = await SELF.fetch(
    new Request(
      `https://village.test/api/browser-sessions/${browserSessionId}/stream?cursor=${cursor}`,
      { headers: { ...headers, upgrade: "websocket" } },
    ),
  );
  return response;
}

describe("authoritative browser event stream", () => {
  it("replays from a cursor then delivers each new event once", async () => {
    const response = await connect(0);
    expect(response.status).toBe(101);
    const webSocket = response.webSocket!;
    const replay = nextMessage(webSocket);
    webSocket.accept();
    await expect(replay).resolves.toMatchObject({
      type: "EVENT",
      event: { sequence: 1, type: "SESSION_INITIALIZED" },
    });
    await expect(nextMessage(webSocket)).resolves.toMatchObject({
      type: "READY",
      cursor: 1,
      latestSequence: 1,
      hasMore: false,
    });

    const live = nextMessage(webSocket);
    const canceled = await SELF.fetch(
      new Request(
        `https://village.test/api/browser-sessions/${browserSessionId}/cancel`,
        { method: "POST", headers: ownerHeaders },
      ),
    );
    expect(canceled.status).toBe(200);
    await expect(live).resolves.toMatchObject({
      type: "EVENT",
      event: { sequence: 2, type: "AUTOMATION_CANCELED" },
    });
    webSocket.close(1000, "test complete");

    const resumed = await connect(1);
    expect(resumed.status).toBe(101);
    const resumedSocket = resumed.webSocket!;
    const recovered = nextMessage(resumedSocket);
    resumedSocket.accept();
    await expect(recovered).resolves.toMatchObject({
      type: "EVENT",
      event: { sequence: 2, type: "AUTOMATION_CANCELED" },
    });
    resumedSocket.close(1000, "test complete");
  });

  it("rejects another principal before upgrading", async () => {
    const response = await connect(0, {
      ...ownerHeaders,
      "x-village-development-principal": "prn_01J00000000000000000000006",
    });
    expect(response.status).toBe(404);

    const hostileOrigin = await connect(0, {
      ...ownerHeaders,
      origin: "https://evil.example",
    });
    expect(hostileOrigin.status).toBe(403);
  });
});
