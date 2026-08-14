import { randomBytes } from "node:crypto";

const idAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function createInternalProofId(prefix: "act" | "rcp" | "chk"): string {
  const bytes = randomBytes(26);
  let value = "";
  for (const byte of bytes) value += idAlphabet[byte & 31];
  return `${prefix}_${value}`;
}
