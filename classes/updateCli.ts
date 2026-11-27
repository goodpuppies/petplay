/**
 * `petplay --update…`: the updater from the command line, and the process Settings → Install
 * runs to apply an update (so the ~500 MB of hashing and writing never runs in a scene worker).
 *
 * With `--json` every line on stdout is one JSON object: `{"event":"progress",…}` while working,
 * then `{"event":"done",…}` or `{"event":"error","message":…}`.
 */
import { describeBuild } from "./buildInfo.ts";
import { getSetting } from "./settings.ts";
import {
  applyUpdate,
  type BuildCandidate,
  checkForUpdate,
  effectiveChannel,
  isChannelId,
  listChannels,
  rollbackUpdate,
  type UpdateProgress,
} from "./updater.ts";

export async function runUpdateCli(args: readonly string[]): Promise<number> {
  const json = args.includes("--json");
  const emit = (event: Record<string, unknown>) => {
    if (json) console.log(JSON.stringify(event));
  };
  const say = (line: string) => {
    if (!json) console.log(line);
  };
  try {
    const channelArg = args.find((a) => a.startsWith("--channel="))?.slice("--channel=".length);
    if (channelArg != null && !isChannelId(channelArg)) {
      throw new Error(`Not a channel: ${channelArg} (use stable or owner/repo#branch)`);
    }
    const channel = channelArg ?? effectiveChannel(readChannelSetting());

    if (args.includes("--update-channels")) {
      const listing = await listChannels({ extraRepos: readExtraRepos() });
      emit({ event: "done", channels: listing.channels, warnings: listing.warnings });
      for (const candidate of listing.channels) say(describeCandidate(candidate));
      for (const warning of listing.warnings) say(`(could not read ${warning})`);
      return 0;
    }

    if (args.includes("--update-rollback")) {
      const result = await rollbackUpdate();
      emit({ event: "done", result });
      say(`Rolled back to ${result.installed.version}. Restart PetPlay to run it.`);
      return 0;
    }

    const check = await checkForUpdate({ channel });
    if (args.includes("--update-check")) {
      emit({ event: "done", check });
      say(`This is ${describeBuild()}.`);
      say(
        check.candidate
          ? `${describeCandidate(check.candidate)} (${check.status})`
          : `${channel}: no build for this platform`,
      );
      return 0;
    }

    // --update
    if (!check.canApply || !check.candidate) {
      throw new Error(`Cannot update: ${check.reason ?? "nothing to install"}`);
    }
    if (check.status === "up-to-date" && !args.includes("--force")) {
      emit({ event: "done", check, result: null });
      say(`Already on ${check.candidate.version} (${channel}).`);
      return 0;
    }
    if (!json && !args.includes("--yes")) {
      const { ask } = await import("./cli.ts");
      const verb = check.status === "switch" ? "Switch to" : "Update to";
      if (!await ask(`${verb} ${describeCandidate(check.candidate)}? [Y/n] `, true)) return 1;
    }
    let lastLine = 0;
    const result = await applyUpdate(check.candidate, {
      onProgress: (progress) => {
        emit({ event: "progress", ...progress });
        const now = Date.now();
        if (!json && (now - lastLine > 1000 || progress.phase !== "downloading")) {
          lastLine = now;
          console.log(describeProgress(progress));
        }
      },
    });
    emit({ event: "done", check, result });
    say(
      `Installed ${result.installed.version} at ${result.targetPath} (${
        result.mode === "delta"
          ? `fetched ${mb(result.downloadedBytes)}, reused ${mb(result.reusedBytes)}`
          : `downloaded ${mb(result.downloadedBytes)}`
      }). Restart PetPlay to run it.`,
    );
    return 0;
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    emit({ event: "error", message: text });
    if (!json) console.error(text);
    return 1;
  }
}

function readChannelSetting(): string | null {
  try {
    return getSetting("updateChannel");
  } catch {
    return null;
  }
}

function readExtraRepos(): string[] {
  try {
    return getSetting("updateRepos");
  } catch {
    return [];
  }
}

export function describeCandidate(candidate: BuildCandidate): string {
  const when = candidate.publishedAt?.slice(0, 16).replace("T", " ") ?? "";
  const commit = candidate.commit ? ` ${candidate.commit.slice(0, 7)}` : "";
  return `${candidate.channel}: ${candidate.version}${commit} ${when}`.trim();
}

export function describeProgress(progress: UpdateProgress): string {
  switch (progress.phase) {
    case "preparing":
      return "Preparing…";
    case "indexing":
      return "Finding what this PetPlay already has…";
    case "downloading": {
      const of = progress.totalBytes ? ` of ${mb(progress.totalBytes)}` : "";
      const pct = progress.totalBytes
        ? ` ${Math.min(100, Math.floor((progress.receivedBytes / progress.totalBytes) * 100))}%`
        : "";
      const reused = progress.reusedBytes ? `, ${mb(progress.reusedBytes)} reused` : "";
      return `Downloading ${mb(progress.receivedBytes)}${of}${pct}${reused}`;
    }
    case "verifying":
      return "Verifying SHA-256…";
    case "testing":
      return "Checking the new build starts…";
    case "installing":
      return "Installing…";
  }
}

function mb(bytes: number): string {
  return `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB`;
}
