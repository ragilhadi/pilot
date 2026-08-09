/**
 * The one SHA-256 helper the domain shares. Content hashes appear in instruction provenance,
 * skill provenance, and prompt-template fingerprints; each of those had grown its own copy of
 * the same six lines.
 */

export type Sha256Digest = `sha256:${string}`;

export async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The same digest, prefixed for use as a provenance or fingerprint field. */
export async function sha256Digest(value: string): Promise<Sha256Digest> {
  return `sha256:${await sha256Hex(value)}`;
}
