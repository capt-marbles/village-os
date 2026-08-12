export const profileDirectoryMode = 0o700;

export type ProfilePostureInput = {
  encryptionAvailable: boolean;
  platform: NodeJS.Platform;
};

export type ProfilePosture = { ok: true } | { ok: false; warning: string };

export function evaluateProfilePosture(input: ProfilePostureInput): ProfilePosture {
  if (input.platform !== "darwin") {
    return { ok: false, warning: "This compatibility spike supports macOS only; LinkedIn view will not open." };
  }
  if (!input.encryptionAvailable) {
    return {
      ok: false,
      warning: "Supported OS credential encryption is unavailable; LinkedIn view will not open.",
    };
  }
  return { ok: true };
}
