/**
 * The background update check of a release build: a few minutes after start and every six hours,
 * asks the update channel (Settings → Install) for its newest build and shows a headset toast
 * once per new build. It never installs anything; Settings → Install → INSTALL does.
 *
 * Runs in the server process, which reads settings from disk each time (the scene worker owns
 * and writes them). Off with `updateAutoCheck: false`, and in source checkouts.
 */
import { getSettingsPath, parseSettings } from "./settings.ts";
import { checkForUpdate, effectiveChannel } from "./updater.ts";

const FIRST_CHECK_MS = 3 * 60 * 1000;
const INTERVAL_MS = 6 * 60 * 60 * 1000;

export type UpdateToast = { title: string; content: string };

export function startUpdateWatcher(toast: (toast: UpdateToast) => void): () => void {
  if (!Deno.build.standalone) return () => {};
  const notified = new Set<string>();
  const run = async () => {
    let settings;
    try {
      settings = parseSettings(await Deno.readTextFile(getSettingsPath())).settings;
    } catch {
      settings = parseSettings("{}").settings;
    }
    if (!settings.updateAutoCheck) return;
    try {
      const check = await checkForUpdate({ channel: effectiveChannel(settings.updateChannel) });
      const candidate = check.candidate;
      // A channel the user picked on purpose offers its build even when it is a "switch".
      const wanted = check.status === "update" ||
        (check.status === "switch" && settings.updateChannel != null);
      if (!candidate || !wanted || notified.has(candidate.tag)) return;
      notified.add(candidate.tag);
      console.log(`[updater] ${candidate.version} is available on ${check.channel}`);
      toast({
        title: `PetPlay ${candidate.version} available`,
        content: `${check.channel}: Settings → Install → INSTALL`,
      });
    } catch (error) {
      console.warn(
        `[updater] background check failed: ${error instanceof Error ? error.message : error}`,
      );
    }
  };
  let interval: ReturnType<typeof setInterval> | undefined;
  const first = setTimeout(() => {
    void run();
    interval = setInterval(() => void run(), INTERVAL_MS);
  }, FIRST_CHECK_MS);
  return () => {
    clearTimeout(first);
    if (interval != null) clearInterval(interval);
  };
}
