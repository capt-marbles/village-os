import type { MacProfileProtection } from "../browser/profile-protection.js";

/** Synthetic packaged proofs exercise their own concern, never host backup APIs. */
export const internalProofProfileProtection: MacProfileProtection = {
  runTmutil: async (arguments_) => ({
    stdout:
      arguments_[0] === "isexcluded"
        ? "[Excluded] internal packaged proof\n"
        : "",
  }),
};
