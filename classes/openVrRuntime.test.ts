import { assertEquals } from "jsr:@std/assert";
import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { classifyOpenVrEvent } from "./openVrRuntime.ts";

Deno.test("classifyOpenVrEvent detects SteamLink/HMD reconnect and IPD changes without false positives on controllers", () => {
  // Runtime exit events
  assertEquals(
    classifyOpenVrEvent(OpenVR.EventType.VREvent_Quit, 0)?.kind,
    "exit",
  );

  // HMD reactivation / display reconnect / standby exit / universe change -> rebuild overlay
  assertEquals(
    classifyOpenVrEvent(OpenVR.EventType.VREvent_TrackedDeviceActivated, 0)?.kind,
    "rebuild-overlay",
  );
  assertEquals(
    classifyOpenVrEvent(OpenVR.EventType.VREvent_Compositor_DisplayReconnected, 0)?.kind,
    "rebuild-overlay",
  );
  assertEquals(
    classifyOpenVrEvent(OpenVR.EventType.VREvent_LeaveStandbyMode, 0)?.kind,
    "rebuild-overlay",
  );
  assertEquals(
    classifyOpenVrEvent(OpenVR.EventType.VREvent_ChaperoneUniverseHasChanged, 0)?.kind,
    "rebuild-overlay",
  );

  // Controller activation (device index != 0) must NOT rebuild the overlay
  assertEquals(
    classifyOpenVrEvent(OpenVR.EventType.VREvent_TrackedDeviceActivated, 3),
    null,
  );
  assertEquals(
    classifyOpenVrEvent(OpenVR.EventType.VREvent_TrackedDeviceUpdated, 3),
    null,
  );

  // IPD change and HMD update -> refresh eye geometry
  assertEquals(
    classifyOpenVrEvent(OpenVR.EventType.VREvent_IpdChanged, 0)?.kind,
    "refresh-eye-geometry",
  );
  assertEquals(
    classifyOpenVrEvent(OpenVR.EventType.VREvent_TrackedDeviceUpdated, 0)?.kind,
    "refresh-eye-geometry",
  );
});
