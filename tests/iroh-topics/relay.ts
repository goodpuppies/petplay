/** A local `iroh-relay --dev` on a free loopback port, for tests that need the relay path. */
import { fromFileUrl } from "@std/path";

export async function startDevRelay(): Promise<{ url: string; stop(): Promise<void> }> {
  const probe = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (probe.addr as Deno.NetAddr).port;
  probe.close();
  const dir = await Deno.makeTempDir({ prefix: "pp-relay-" });
  const config = `${dir}/relay.toml`;
  await Deno.writeTextFile(
    config,
    [
      "enable_relay = true",
      `http_bind_addr = "127.0.0.1:${port}"`,
      "enable_quic_addr_discovery = false",
      "enable_metrics = false",
    ].join("\n") + "\n",
  );
  const binary = Deno.env.get("PETPLAY_IROH_RELAY_BINARY") ??
    fromFileUrl(
      new URL(
        "../../submodules/petplay_mediatransport/target/tools/bin/iroh-relay",
        import.meta.url,
      ),
    );
  const child = new Deno.Command(binary, {
    args: ["--dev", "--config-path", config],
    stdout: "null",
    stderr: "null",
  }).spawn();
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      await (await fetch(`${url}/ping`)).body?.cancel();
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  return {
    url,
    async stop() {
      child.kill();
      await child.status;
      await Deno.remove(dir, { recursive: true });
    },
  };
}
