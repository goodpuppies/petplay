/**
 * A short-lived self-signed certificate for a WebTransport listener that browsers reach by
 * pinning its hash (`serverCertificateHashes`) instead of trusting a CA. Pinning requires ECDSA
 * P-256 (or similar) and a validity of at most 14 days, so it is renewed well before then.
 * Generated with openssl; the key never leaves memory after the temporary files are removed.
 */
import type { WebTransportCertificate } from "../../submodules/stageforge/mod.ts";

/** Days a certificate is valid; browsers refuse pinned certificates over 14. */
export const CERT_DAYS = 13;
/** Renew this long before expiry, so a tab connecting near the end still succeeds. */
export const CERT_RENEW_MS = (CERT_DAYS - 1) * 24 * 60 * 60 * 1000;

export async function selfSignedCertificate(name = "petplay"): Promise<WebTransportCertificate> {
  const dir = await Deno.makeTempDir({ prefix: "petplay-cert-" });
  try {
    const { code, stderr } = await new Deno.Command("openssl", {
      args: [
        "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
        "-keyout", `${dir}/key.pem`, "-out", `${dir}/cert.pem`, "-days", String(CERT_DAYS),
        "-nodes", "-subj", `/CN=${name}`,
      ],
      stdout: "null",
      stderr: "piped",
    }).output();
    if (code !== 0) throw new Error(`openssl: ${new TextDecoder().decode(stderr).trim()}`);
    return {
      cert: await Deno.readTextFile(`${dir}/cert.pem`),
      key: await Deno.readTextFile(`${dir}/key.pem`),
    };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}
