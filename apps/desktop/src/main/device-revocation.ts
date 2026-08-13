export type DeviceAuthorization =
  { ok: true } | { ok: false; code: "DEVICE_REVOKED" };

/** Process-local denial cache; coordinator persistence remains cloud-owned. */
export class DeviceRevocationRegistry {
  private readonly revoked = new Set<string>();

  revoke(deviceId: string): void {
    this.revoked.add(deviceId);
  }

  authorize(deviceId: string): DeviceAuthorization {
    return this.revoked.has(deviceId)
      ? { ok: false, code: "DEVICE_REVOKED" }
      : { ok: true };
  }
}
