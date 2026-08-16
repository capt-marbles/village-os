import {
  villageIdentitySessionSchema,
  type VillageIdentitySession,
} from "@village/contracts";

export class VillageIdentityClient {
  constructor(private readonly baseUrl: string) {}

  async load(signal?: AbortSignal): Promise<VillageIdentitySession> {
    const response = await fetch(new URL("/api/identity", this.baseUrl), {
      credentials: "same-origin",
      headers: { accept: "application/json" },
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw new Error("UNAUTHENTICATED");
    return villageIdentitySessionSchema.parse(await response.json());
  }
}
