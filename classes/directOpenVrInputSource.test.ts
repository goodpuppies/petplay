import { describeStaleActionOriginMismatch } from "./directOpenVrInputSource.ts";

const INVALID = 0xffff_ffff;

function assertEquals(actual: unknown, expected: unknown): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`Expected ${String(expected)}, got ${String(actual)}`);
  }
}

Deno.test("matching active action origins report no mismatch", () => {
  assertEquals(
    describeStaleActionOriginMismatch(
      { expectedDeviceIndex: 9, actionActive: true, originDeviceIndex: 9 },
      { expectedDeviceIndex: 10, actionActive: true, originDeviceIndex: 10 },
      INVALID,
    ),
    null,
  );
});

Deno.test("stale hand-tracking origins after switching to physical controllers report mismatch", () => {
  assertEquals(
    describeStaleActionOriginMismatch(
      { expectedDeviceIndex: 9, actionActive: true, originDeviceIndex: 12 },
      { expectedDeviceIndex: 10, actionActive: true, originDeviceIndex: 11 },
      INVALID,
    ),
    "left expected=9 origin=12, right expected=10 origin=11",
  );
});

Deno.test("inactive action for a connected expected controller reports mismatch", () => {
  assertEquals(
    describeStaleActionOriginMismatch(
      { expectedDeviceIndex: 9, actionActive: false, originDeviceIndex: null },
      { expectedDeviceIndex: 10, actionActive: true, originDeviceIndex: 10 },
      INVALID,
    ),
    "left expected=9 active=false",
  );
});

Deno.test("absent controllers (INVALID) are ignored", () => {
  assertEquals(
    describeStaleActionOriginMismatch(
      { expectedDeviceIndex: INVALID, actionActive: false, originDeviceIndex: null },
      { expectedDeviceIndex: INVALID, actionActive: false, originDeviceIndex: null },
      INVALID,
    ),
    null,
  );
});
