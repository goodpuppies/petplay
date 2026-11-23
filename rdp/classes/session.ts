/**
 * An RDP session has two independent random tokens carried in the link's URL fragment
 * (`#<id>.<secret>`, never sent to the page's host):
 *
 * - `id`: public rendezvous identifier (`rdp-<id>` on the topic server). Topic names are for
 *   discovery/scoping only, never security.
 * - `secret`: private auth credential presented when opening `rdp.ui` over the encrypted iroh
 *   connection.
 *
 * Using two independent random tokens avoids `crypto.subtle` / SHA-256, so the browser page works
 * on plain HTTP (e.g. direct Tailscale URLs without `tailscale serve`).
 */

function randomToken(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...buf)).replace(/\+/g, "-").replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function newSessionId(): string {
  return randomToken(12);
}

export function newSessionSecret(): string {
  return randomToken(24);
}

export function sessionTopic(id: string): string {
  return `rdp-${id}`;
}

export function formatSessionFragment(id: string, secret: string): string {
  return `${id}.${secret}`;
}

export function parseSessionFragment(fragment: string): { id: string; secret: string } | null {
  const dot = fragment.indexOf(".");
  if (dot <= 0) return null;
  const id = fragment.slice(0, dot);
  const secret = fragment.slice(dot + 1);
  if (id.length < 8 || secret.length < 16) return null;
  return { id, secret };
}

/** Constant-time comparison, so a wrong guess learns nothing from timing. */
export function sameSecret(a: unknown, b: string): boolean {
  if (typeof a !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < b.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
