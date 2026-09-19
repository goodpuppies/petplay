function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("display overlay host owns the process-local OpenVR presentation boundary", async () => {
  const main = await Deno.readTextFile(
    new URL("../petplay/main.ts", import.meta.url),
  );
  const host = await Deno.readTextFile(
    new URL("../petplay/displayOverlayHost.ts", import.meta.url),
  );

  assert(
    /PostMan\.create\(\s*"\.\/displayOverlayHost\.ts",\s*import\.meta\.url,\s*\{\s*worker:\s*"process"\s*\}/s
      .test(main),
    "displayOverlayHost must remain process-backed",
  );
  assert(
    host.includes('appKey: "petplay.display-overlay-host"'),
    "displayOverlayHost must have an OpenVR identity distinct from the parent Deno process",
  );
  assert(
    host.includes('overlay: "required"'),
    "displayOverlayHost must acquire IVROverlay inside its own process",
  );
  assert(
    !host.includes("INITOVROVERLAY:"),
    "displayOverlayHost must not accept a native IVROverlay pointer over IPC",
  );
});
