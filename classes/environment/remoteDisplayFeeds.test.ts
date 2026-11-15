import { remoteDisplayOutput, resolveDisplayFeedProvider } from "./remoteDisplayFeeds.ts";
Deno.test("remote feed identity survives a provider restart and never enables local input", () => {
  const health = {
    running: true,
    frames: 1,
    width: 1280,
    height: 720,
    feedId: "desktop",
    feedName: "Friend's desktop",
  };
  const first = remoteDisplayOutput("remoteMedia@first", health)!;
  const next = remoteDisplayOutput("remoteMedia@next", health)!;
  if (
    first.id !== next.id || first.overlayHostActor === next.overlayHostActor ||
    next.input !== "none" || next.crop.width !== 1
  ) throw Error("Bad remote feed routing/identity");
  if (
    remoteDisplayOutput("remoteMedia@first", { ...health, running: false }) !== null ||
    remoteDisplayOutput("remoteMedia@first", { ...health, frames: 0 }) !== null
  ) throw Error("Unavailable video advertised as connected");
});

Deno.test("an unavailable feed cannot briefly route to local desktop before graph reconciliation", () => {
  const missing = resolveDisplayFeedProvider(undefined, "local-host");
  if (missing.actor !== null || missing.acceptsMouse) {
    throw Error("Missing remote feed fell through to local input");
  }
  const output = remoteDisplayOutput("remote-host", {
    running: true,
    frames: 1,
    width: 1280,
    height: 720,
  })!;
  const remote = resolveDisplayFeedProvider(output, "local-host");
  if (remote.actor !== "remote-host" || remote.acceptsMouse) {
    throw Error("Remote feed routed locally");
  }
});
