export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function waitFor<T>(
  what: string,
  probe: () => T | null | undefined | false | Promise<T | null | undefined | false>,
  timeoutMs: number,
  intervalMs = 500,
): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (performance.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    }
    await sleep(intervalMs);
  }
}

/** Live PIDs whose `comm` is exactly `name` (zombies excluded). */
export function pidsNamed(name: string): number[] {
  const found: number[] = [];
  for (const entry of Deno.readDirSync("/proc")) {
    if (!/^\d+$/.test(entry.name)) continue;
    try {
      const stat = Deno.readTextFileSync(`/proc/${entry.name}/stat`);
      const comm = stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")"));
      const status = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
      if (comm === name && status !== "Z") found.push(Number(entry.name));
    } catch {
      // The process exited while we looked.
    }
  }
  return found;
}

/** Match a workload's argv, excluding shell command text and the caller's ancestry. */
export function pidsMatching(...fragments: string[]): number[] {
  const ancestors = new Set<number>();
  let current = Deno.pid;
  while (current > 0 && !ancestors.has(current)) {
    ancestors.add(current);
    try {
      const fields = Deno.readTextFileSync(`/proc/${current}/stat`).split(") ").at(-1)!.split(" ");
      current = Number(fields[1]);
    } catch {
      break;
    }
  }
  const found: number[] = [];
  for (const entry of Deno.readDirSync("/proc")) {
    const pid = Number(entry.name);
    if (!/^\d+$/.test(entry.name) || ancestors.has(pid)) continue;
    try {
      const fields = Deno.readTextFileSync(`/proc/${pid}/stat`).split(") ").at(-1)!.split(" ");
      if (fields[0] === "Z") continue;
      const argv = Deno.readTextFileSync(`/proc/${pid}/cmdline`).split("\0").filter(Boolean);
      const executable = argv[0]?.split("/").at(-1);
      if (
        ["bash", "sh", "dash", "zsh", "fish"].includes(executable ?? "") &&
        argv.some((a) => /^-[a-z]*c[a-z]*$/.test(a))
      ) continue;
      // Do not match across argv boundaries or find script contents in a shell -c argument.
      if (fragments.every((fragment) => argv.some((arg) => arg.includes(fragment)))) {
        found.push(pid);
      }
    } catch { /* Process exited during the snapshot. */ }
  }
  return found;
}

/** The desktop session's X/Wayland/DBus variables, taken from the running Steam client. */
export function desktopEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const pid of pidsNamed("steam")) {
    try {
      for (const entry of Deno.readTextFileSync(`/proc/${pid}/environ`).split("\0")) {
        const [key, ...rest] = entry.split("=");
        if (
          [
            "DISPLAY",
            "XAUTHORITY",
            "XDG_RUNTIME_DIR",
            "WAYLAND_DISPLAY",
            "DBUS_SESSION_BUS_ADDRESS",
          ].includes(key)
        ) {
          env[key] = rest.join("=");
        }
      }
      if (env.DISPLAY) return env;
    } catch {
      // Try the next Steam process.
    }
  }
  if (Deno.env.get("DISPLAY")) {
    return { DISPLAY: Deno.env.get("DISPLAY")!, XAUTHORITY: Deno.env.get("XAUTHORITY") ?? "" };
  }
  throw new Error("no desktop session found (Steam not running and DISPLAY unset)");
}
