export class PairingClient {
  constructor(
    private readonly baseUrl: string,
    private readonly request: typeof fetch = fetch,
  ) {}

  async consume(input: {
    principalId: string;
    pairingId: string;
    secret: string;
  }): Promise<{ deviceId: string }> {
    const response = await this.request(
      new URL(`/api/pairing/${input.pairingId}/consume`, this.baseUrl),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          principalId: input.principalId,
          secret: input.secret,
        }),
      },
    );
    const result = (await response.json()) as {
      ok: boolean;
      deviceId?: string;
      code?: string;
    };
    if (!response.ok || !result.ok || !result.deviceId) {
      throw new Error(result.code ?? "PAIRING_FAILED");
    }
    return { deviceId: result.deviceId };
  }
}
