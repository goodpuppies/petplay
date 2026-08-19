import { selectActiveControllerIndex } from "./openVrControllerSelection.ts";

const INVALID = 0xffff_ffff;

function assertEquals(actual: unknown, expected: unknown): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`Expected ${String(expected)}, got ${String(actual)}`);
  }
}

Deno.test("active cached controller remains selected", () => {
  assertEquals(
    selectActiveControllerIndex({
      cachedIndex: 7,
      roleIndex: 9,
      invalidIndex: INVALID,
      maxDeviceCount: 16,
      isActiveControllerForRole: (index) => index === 7 || index === 9,
    }),
    7,
  );
});

Deno.test("inactive cached and assigned devices yield to an active same-role controller", () => {
  assertEquals(
    selectActiveControllerIndex({
      cachedIndex: 3,
      roleIndex: 3,
      invalidIndex: INVALID,
      maxDeviceCount: 16,
      isActiveControllerForRole: (index) => index === 11,
    }),
    11,
  );
});

Deno.test("returns the OpenVR invalid index when no controller is active", () => {
  assertEquals(
    selectActiveControllerIndex({
      cachedIndex: 3,
      roleIndex: INVALID,
      invalidIndex: INVALID,
      maxDeviceCount: 16,
      isActiveControllerForRole: () => false,
    }),
    INVALID,
  );
});
