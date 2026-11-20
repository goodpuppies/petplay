/**
 * An RDP session is one random secret, carried in the link's URL fragment (never sent to the
 * page's host). The topic actors meet on is derived from it, because the topic server is public
 * and relays topic names in the clear: anyone listening learns the hash, not the secret. A tab
 * proves it knows the secret when it opens the `rdp.ui` transport; the offer travels over the
 * iroh connection, which is end-to-end encrypted.
 */

export function newSessionSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function sessionTopic(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`rdp:${secret}`));
  const hex = [...new Uint8Array(digest).slice(0, 16)]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  return `rdp-${hex}`;
}

/** Constant-time comparison, so a wrong guess learns nothing from timing. */
export function sameSecret(a: unknown, b: string): boolean {
  if (typeof a !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < b.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
