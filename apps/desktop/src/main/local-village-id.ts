const villageIdAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function createVillageId<Prefix extends string>(
  prefix: Prefix,
): `${Prefix}_${string}` {
  const bytes = crypto.getRandomValues(new Uint8Array(26));
  return `${prefix}_${[...bytes]
    .map((byte) => villageIdAlphabet[byte & 31])
    .join("")}`;
}
