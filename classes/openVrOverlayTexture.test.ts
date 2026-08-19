import { releaseAndDestroyOpenVrOverlay } from "./openVrOverlayTexture.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`Expected ${e}, received ${a}`);
}

Deno.test("OpenVR overlay release clears imported texture before destroying overlay", () => {
  const calls: string[] = [];
  const overlay = {
    HideOverlay: () => calls.push("hide"),
    ClearOverlayTexture: () => calls.push("clear"),
    WaitFrameSync: () => calls.push("wait"),
    DestroyOverlay: () => calls.push("destroy"),
  };

  releaseAndDestroyOpenVrOverlay(overlay as never, 42n);

  assertEquals(calls, ["hide", "clear", "wait", "destroy"]);
});
