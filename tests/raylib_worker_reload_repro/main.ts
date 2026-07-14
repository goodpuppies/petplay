import { PostalService } from "../../submodules/stageforge/mod.ts";

const mode = Deno.args.find((arg) => arg.startsWith("--mode="))?.split("=", 2)[1] ??
  "rlgl";
console.log(`[raylib-repro] parent pid=${Deno.pid} mode=${mode}`);

const postalservice = new PostalService();
const actorUrl = new URL("./actor.ts", import.meta.url);
const actorId = await postalservice.add(actorUrl.href, actorUrl.href);
console.log(`[raylib-repro] actor ready id=${actorId}`);

const before = await postalservice.PostMessage({
  target: actorId,
  type: "HEALTH",
  payload: null,
}, true);
console.log("[raylib-repro] health before reload", before);

const reloaded = await postalservice.reload(actorId);
console.log("[raylib-repro] reload returned", reloaded);

const after = await postalservice.PostMessage({
  target: actorId,
  type: "HEALTH",
  payload: null,
}, true);
console.log("[raylib-repro] health after reload", after);
console.log("[raylib-repro] PASS");
Deno.exit(0);
