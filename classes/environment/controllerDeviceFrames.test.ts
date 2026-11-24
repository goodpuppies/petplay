import { assertEquals } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import {
  requestFollowRelease,
  setFollowReleaseSender,
  settleFollowRelease,
} from "./controllerDeviceFrames.ts";

Deno.test("a release lands on the renderer's answer, once", () => {
  let sent = -1;
  setFollowReleaseSender((_carry, seq) => (sent = seq, true));
  const landed: unknown[] = [];
  requestFollowRelease({ space: "right-ray" }, (pose) => landed.push(pose));
  settleFollowRelease(sent, [1]);
  settleFollowRelease(sent, [2]);
  assertEquals(landed, [[1]]);
  setFollowReleaseSender(null);
});

Deno.test("a release lands unshifted without a renderer or an answer", () => {
  using time = new FakeTime();
  const landed: unknown[] = [];
  requestFollowRelease({ space: "left-hand" }, (pose) => landed.push(pose));
  assertEquals(landed, [null]);
  setFollowReleaseSender(() => true);
  requestFollowRelease({ space: "left-hand" }, (pose) => landed.push(pose));
  time.tick(200);
  assertEquals(landed, [null, null]);
  setFollowReleaseSender(null);
});
