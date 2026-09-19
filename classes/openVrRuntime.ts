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

/** Owns one process-local OpenVR client runtime and its acquired interfaces. */
export class OpenVrRuntime {
  private pointers = EMPTY_POINTERS();
  private active = false;
  private applications: OpenVR.IVRApplications | null = null;
  private applicationManifestPath: string | null = null;
  private ownsApplicationManifest = false;

  constructor(private readonly logName = "OpenVR") {}

  initialize(request: OpenVrRuntimeRequest): OpenVrRuntimePointers {
    if (this.active) return this.pointers;

    console.log(`[${this.logName}] loading OpenVR bindings`);
    if (!OpenVR.initializeOpenVR(getOpenVrLibraryPath())) {
      throw new Error("Failed to load OpenVR");
    }

    const errorPointer = P.Int32P<OpenVR.InitError>();
    OpenVR.VR_InitInternal(
      errorPointer,
      OpenVR.ApplicationType.VRApplication_Overlay,
    );
    const initError = new Deno.UnsafePointerView(errorPointer).getInt32();
    if (initError !== OpenVR.InitError.VRInitError_None) {
      OpenVR.closeOpenVR();
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
    this.pointers = EMPTY_POINTERS();
    this.active = false;
    LogChannel.log(
      "actor",
      `${this.logName} runtime release deferred to process exit.`,
    );
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
