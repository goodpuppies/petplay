import { LogChannel } from "@mommysgoodpuppy/logchannel";
import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { P } from "../submodules/OpenVR_TS_Bindings_Deno/pointers.ts";
import { stringToPointer } from "../submodules/OpenVR_TS_Bindings_Deno/utils.ts";
import { getOpenVrLibraryPath } from "./nativeLibraryPaths.ts";

export type OpenVrInterfaceRequirement = "required" | "optional" | false;

export type OpenVrRuntimeRequest = {
  system?: OpenVrInterfaceRequirement;
  compositor?: OpenVrInterfaceRequirement;
  overlay?: OpenVrInterfaceRequirement;
  input?: OpenVrInterfaceRequirement;
  renderModels?: OpenVrInterfaceRequirement;
  identity?: OpenVrApplicationIdentity;
};

export type OpenVrApplicationIdentity = {
  appKey: string;
  name: string;
};

export type OpenVrRuntimePointers = {
  system: Deno.PointerValue | null;
  compositor: Deno.PointerValue | null;
  overlay: Deno.PointerValue | null;
  input: Deno.PointerValue | null;
  renderModels: Deno.PointerValue | null;
};

const EMPTY_POINTERS = (): OpenVrRuntimePointers => ({
  system: null,
  compositor: null,
  overlay: null,
  input: null,
  renderModels: null,
});

/**
 * Presence probes that need the library but no client runtime — what a
 * supervisor polls while SteamVR is missing.
 */
export type OpenVrPresence = {
  libraryLoaded: boolean;
  runtimeInstalled: boolean;
  hmdPresent: boolean;
};

/**
 * `VREvent_t` is copied whole by `PollNextEvent`; 256B is a comfortable
 * over-allocation (the struct starts with `eventType` and is far smaller), so
 * reading the type needs no union layout knowledge.
 */
const EVENT_BUFFER_BYTES = 256;
const MAX_EVENTS_PER_POLL = 32;

/** Events that mean the runtime itself is going away. */
const RUNTIME_EXIT_EVENTS = new Set<number>([
  OpenVR.EventType.VREvent_Quit,
  OpenVR.EventType.VREvent_DriverRequestedQuit,
  OpenVR.EventType.VREvent_RestartRequested,
]);

/** Owns one process-local OpenVR client runtime and its acquired interfaces. */
export class OpenVrRuntime {
  private pointers = EMPTY_POINTERS();
  private active = false;
  private applications: OpenVR.IVRApplications | null = null;
  private applicationManifestPath: string | null = null;
  private ownsApplicationManifest = false;
  /** `IVRSystem` wrapper, kept for event polling only. */
  private system: OpenVR.IVRSystem | null = null;
  private readonly eventBuffer = new Uint8Array(EVENT_BUFFER_BYTES);
  private readonly eventTypeView = new DataView(this.eventBuffer.buffer);

  constructor(private readonly logName = "OpenVR") {}

  /** True while this runtime holds a live client runtime. */
  isActive(): boolean {
    return this.active;
  }

  /**
   * `VR_IsRuntimeInstalled` / `VR_IsHmdPresent` without initializing a client
   * runtime. Loading the library is part of probing — it is cheap, and leaving
   * it loaded makes the following `initialize()` cheaper.
   */
  probePresence(): OpenVrPresence {
    if (!this.ensureLibrary()) {
      return { libraryLoaded: false, runtimeInstalled: false, hmdPresent: false };
    }
    return {
      libraryLoaded: true,
      runtimeInstalled: OpenVR.VR_IsRuntimeInstalled(),
      hmdPresent: OpenVR.VR_IsHmdPresent(),
    };
  }

  /**
   * Drain queued `IVRSystem` events (bounded, so a chatty runtime cannot stall
   * a poll). `exiting` means SteamVR asked the client to quit or restart: the
   * caller must detach dependants before releasing this runtime, because the
   * interface vtables become dangling the moment `shutdown()` runs.
   */
  pollRuntimeEvents(): {
    exiting: boolean;
    handled: number;
    lastEventType: number | null;
    exitEventType: number | null;
  } {
    const system = this.system;
    if (system == null || !this.active) {
      return { exiting: false, handled: 0, lastEventType: null, exitEventType: null };
    }
    let handled = 0;
    let lastEventType: number | null = null;
    let exitEventType: number | null = null;
    for (let i = 0; i < MAX_EVENTS_PER_POLL; i++) {
      const eventPointer = Deno.UnsafePointer.of(this.eventBuffer) as
        | Deno.PointerValue<OpenVR.Event>
        | null;
      if (eventPointer == null) break;
      if (!system.PollNextEvent(eventPointer, EVENT_BUFFER_BYTES)) break;
      const eventType = this.eventTypeView.getUint32(0, true);
      handled += 1;
      lastEventType = eventType;
      if (RUNTIME_EXIT_EVENTS.has(eventType)) exitEventType = eventType;
    }
    return { exiting: exitEventType != null, handled, lastEventType, exitEventType };
  }

  initialize(request: OpenVrRuntimeRequest): OpenVrRuntimePointers {
    if (this.active) return this.pointers;

    console.log(`[${this.logName}] loading OpenVR bindings`);
    if (!this.ensureLibrary()) {
      throw new Error("Failed to load OpenVR");
    }

    const errorPointer = P.Int32P<OpenVR.InitError>();
    OpenVR.VR_InitInternal(
      errorPointer,
      OpenVR.ApplicationType.VRApplication_Overlay,
    );
    const initError = new Deno.UnsafePointerView(errorPointer).getInt32();
    if (initError !== OpenVR.InitError.VRInitError_None) {
      // Keep the library loaded: a supervisor polling for SteamVR retries this
      // path every few seconds, and dlopen/dlclose churn per attempt is pointless.
      throw new Error(
        `Failed to initialize OpenVR: ${OpenVR.InitError[initError]}`,
      );
    }
    this.active = true;

    try {
      if (request.identity) {
        this.identifyApplication(request.identity, errorPointer);
      }
      this.pointers.system = this.acquireInterface(
        request.system ?? false,
        OpenVR.IVRSystem_Version,
        "IVRSystem",
        errorPointer,
      );
      this.pointers.compositor = this.acquireInterface(
        request.compositor ?? false,
        OpenVR.IVRCompositor_Version,
        "IVRCompositor",
        errorPointer,
      );
      this.pointers.overlay = this.acquireInterface(
        request.overlay ?? false,
        OpenVR.IVROverlay_Version,
        "IVROverlay",
        errorPointer,
      );
      this.pointers.input = this.acquireInterface(
        request.input ?? false,
        OpenVR.IVRInput_Version,
        "IVRInput",
        errorPointer,
      );
      this.pointers.renderModels = this.acquireInterface(
        request.renderModels ?? false,
        OpenVR.IVRRenderModels_Version,
        "IVRRenderModels",
        errorPointer,
      );
      // Event polling is the only reason to wrap `IVRSystem` here; consumers
      // build their own wrappers from the raw pointer in their own worker.
      this.system = this.pointers.system == null
        ? null
        : new OpenVR.IVRSystem(this.pointers.system);
      LogChannel.log("actor", `${this.logName} runtime initialized.`);
      return this.pointers;
    } catch (error) {
      this.shutdown();
      throw error;
    }
  }

  /** Release the client runtime and native library in this process. */
  shutdown(): void {
    this.cleanupApplicationIdentity(true);
    if (this.active && OpenVR.isInitialized()) {
      OpenVR.VR_ShutdownInternal();
    }
    this.system = null;
    this.pointers = EMPTY_POINTERS();
    this.active = false;
    OpenVR.closeOpenVR();
    LogChannel.log("actor", `${this.logName} runtime shut down.`);
  }

  /**
   * Forget JS wrappers while leaving native release to imminent OS process
   * teardown. This avoids the known Linux shutdown race in vrclient.
   */
  deferReleaseToProcessExit(): void {
    this.cleanupApplicationIdentity(false);
    this.system = null;
    this.pointers = EMPTY_POINTERS();
    this.active = false;
    LogChannel.log(
      "actor",
      `${this.logName} runtime release deferred to process exit.`,
    );
  }

  private ensureLibrary(): boolean {
    // Idempotent: re-calling `initializeOpenVR` would leak the previous
    // `Deno.DynamicLibrary` handle, and a probe may have loaded it already.
    if (OpenVR.isInitialized()) return true;
    return OpenVR.initializeOpenVR(getOpenVrLibraryPath());
  }

  private identifyApplication(
    identity: OpenVrApplicationIdentity,
    errorPointer: Deno.PointerValue<OpenVR.InitError>,
  ): void {
    if (!identity.appKey.trim()) throw new Error("OpenVR application key must not be empty");
    const applicationsPointer = this.acquireInterface(
      "required",
      OpenVR.IVRApplications_Version,
      "IVRApplications",
      errorPointer,
    );
    this.applications = new OpenVR.IVRApplications(applicationsPointer);

    const manifestPath = Deno.makeTempFileSync({
      prefix: "petplay-openvr-",
      suffix: ".vrmanifest",
    });
    this.applicationManifestPath = manifestPath;
    Deno.writeTextFileSync(
      manifestPath,
      JSON.stringify({
        source: "petplay",
        applications: [{
          app_key: identity.appKey,
          launch_type: "binary",
          [openVrManifestBinaryPathField()]: Deno.execPath(),
          strings: { en_us: { name: identity.name } },
        }],
      }),
    );

    const addError = this.applications.AddApplicationManifest(
      manifestPath,
      true,
    );
    if (
      addError !== OpenVR.ApplicationError.VRApplicationError_None &&
      addError !== OpenVR.ApplicationError.VRApplicationError_AppKeyAlreadyExists
    ) {
      throw new Error(
        `Failed to register OpenVR application ${identity.appKey}: ${
          OpenVR.ApplicationError[addError]
        }`,
      );
    }
    this.ownsApplicationManifest = addError === OpenVR.ApplicationError.VRApplicationError_None;

    const identifyError = this.applications.IdentifyApplication(
      Deno.pid,
      identity.appKey,
    );
    if (identifyError !== OpenVR.ApplicationError.VRApplicationError_None) {
      throw new Error(
        `Failed to identify OpenVR application ${identity.appKey}: ${
          OpenVR.ApplicationError[identifyError]
        }`,
      );
    }
    LogChannel.log(
      "actor",
      `${this.logName} identified PID ${Deno.pid} as ${identity.appKey}.`,
    );
  }

  private cleanupApplicationIdentity(removeRegistration: boolean): void {
    const manifestPath = this.applicationManifestPath;
    if (
      removeRegistration && this.ownsApplicationManifest && manifestPath &&
      this.applications
    ) {
      try {
        this.applications.RemoveApplicationManifest(manifestPath);
      } catch {
        // SteamVR may already be stopping.
      }
    }
    if (manifestPath) {
      try {
        Deno.removeSync(manifestPath);
      } catch {
        // It may already have been removed during partial initialization.
      }
    }
    this.applications = null;
    this.applicationManifestPath = null;
    this.ownsApplicationManifest = false;
  }

  private acquireInterface(
    requirement: OpenVrInterfaceRequirement,
    version: string,
    label: string,
    errorPointer: Deno.PointerValue<OpenVR.InitError>,
  ): Deno.PointerValue | null {
    if (requirement === false) return null;
    const pointer = OpenVR.VR_GetGenericInterface(
      stringToPointer(version),
      errorPointer,
    );
    const error = new Deno.UnsafePointerView(errorPointer).getInt32();
    if (error === OpenVR.InitError.VRInitError_None && pointer != null) {
      return pointer;
    }
    const message = `Failed to get ${label}: ${OpenVR.InitError[error]}`;
    if (requirement === "optional") {
      LogChannel.log("actor", `${this.logName}: ${message}`);
      return null;
    }
    throw new Error(message);
  }
}

function openVrManifestBinaryPathField(): string {
  switch (Deno.build.os) {
    case "windows":
      return "binary_path_windows";
    case "darwin":
      return "binary_path_osx";
    default:
      return "binary_path_linux";
  }
}
