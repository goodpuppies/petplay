import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { createStruct } from "../submodules/OpenVR_TS_Bindings_Deno/utils.ts";
import type { OpenVrHmdEmulationPose } from "./openVrOverlayFramePacing.ts";

export type Matrix34Rows = [
  [number, number, number, number],
  [number, number, number, number],
  [number, number, number, number],
];

export function composeMatrix34(a: Matrix34Rows, b: Matrix34Rows): Matrix34Rows {
  const result: Matrix34Rows = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 4; column++) {
      result[row][column] = a[row][0] * b[0][column] +
        a[row][1] * b[1][column] +
        a[row][2] * b[2][column] +
        (column === 3 ? a[row][3] : 0);
    }
  }
  return result;
}

function matrix34ToPose(m: Matrix34Rows): OpenVrHmdEmulationPose {
  const matrix = new Float32Array([
    m[0][0],
    m[1][0],
    m[2][0],
    0,
    m[0][1],
    m[1][1],
    m[2][1],
    0,
    m[0][2],
    m[1][2],
    m[2][2],
    0,
    m[0][3],
    m[1][3],
    m[2][3],
    1,
  ]);
  const trace = m[0][0] + m[1][1] + m[2][2];
  let x: number;
  let y: number;
  let z: number;
  let w: number;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    w = 0.25 * s;
    x = (m[2][1] - m[1][2]) / s;
    y = (m[0][2] - m[2][0]) / s;
    z = (m[1][0] - m[0][1]) / s;
  } else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) {
    const s = Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2;
    w = (m[2][1] - m[1][2]) / s;
    x = 0.25 * s;
    y = (m[0][1] + m[1][0]) / s;
    z = (m[0][2] + m[2][0]) / s;
  } else if (m[1][1] > m[2][2]) {
    const s = Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2;
    w = (m[0][2] - m[2][0]) / s;
    x = (m[0][1] + m[1][0]) / s;
    y = 0.25 * s;
    z = (m[1][2] + m[2][1]) / s;
  } else {
    const s = Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2;
    w = (m[1][0] - m[0][1]) / s;
    x = (m[0][2] + m[2][0]) / s;
    y = (m[1][2] + m[2][1]) / s;
    z = 0.25 * s;
  }
  return {
    matrix,
    position: [m[0][3], m[1][3], m[2][3]],
    quaternion: [x, y, z, w],
  };
}

export function composeTrackedDeviceTipPose(
  trackedDevicePose: OpenVrHmdEmulationPose,
  trackingToTip: Matrix34Rows,
): OpenVrHmdEmulationPose {
  const m = trackedDevicePose.matrix;
  const worldFromDevice: Matrix34Rows = [
    [m[0], m[4], m[8], m[12]],
    [m[1], m[5], m[9], m[13]],
    [m[2], m[6], m[10], m[14]],
  ];
  return matrix34ToPose(composeMatrix34(worldFromDevice, trackingToTip));
}

const GET_STRING_TRACKED_DEVICE_PROPERTY = {
  parameters: ["u32", "i32", "pointer", "u32", "pointer"],
  result: "u32",
} as const;

class OpenVrTrackedDeviceStringReader {
  readonly #getString: Deno.UnsafeFnPointer<typeof GET_STRING_TRACKED_DEVICE_PROPERTY>;

  constructor(systemPointer: Deno.PointerObject) {
    const table = new Deno.UnsafePointerView(systemPointer);
    const fn = Deno.UnsafePointer.create(table.getBigUint64(216));
    if (!fn) throw new Error("IVRSystem.GetStringTrackedDeviceProperty is unavailable");
    this.#getString = new Deno.UnsafeFnPointer(
      fn as Deno.PointerObject<typeof GET_STRING_TRACKED_DEVICE_PROPERTY>,
      GET_STRING_TRACKED_DEVICE_PROPERTY,
    );
  }

  get(index: number, property: OpenVR.TrackedDeviceProperty): string | null {
    const buffer = new Uint8Array(512);
    const error = new Int32Array(1);
    const length = Number(this.#getString.call(
      index,
      property,
      Deno.UnsafePointer.of(buffer),
      buffer.byteLength,
      Deno.UnsafePointer.of(error),
    ));
    if (error[0] !== OpenVR.TrackedPropertyError.TrackedProp_Success || length <= 1) {
      return null;
    }
    return new TextDecoder().decode(buffer.subarray(0, Math.min(length - 1, buffer.length)));
  }
}

const LEGACY_TARGET_RAY_OFFSET: Matrix34Rows = (() => {
  const angle = -0.7;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [[1, 0, 0, 0], [0, c, -s, -s * 0.055], [0, s, c, c * 0.055]];
})();

export class OpenVrControllerTipPoseResolver {
  readonly #renderModels: OpenVR.IVRRenderModels;
  readonly #strings: OpenVrTrackedDeviceStringReader;
  readonly #tipByRenderModel = new Map<string, Matrix34Rows | null>();
  readonly #controllerState = new Uint8Array(64);
  readonly #modeState = createStruct<OpenVR.RenderModel_ControllerMode_State>(
    { bScrollWheelVisible: false },
    OpenVR.RenderModel_ControllerMode_StateStruct,
  );

  constructor(
    systemPointer: Deno.PointerObject,
    renderModelsPointer: Deno.PointerObject,
    private readonly onResolved?: (index: number, renderModel: string, found: boolean) => void,
  ) {
    this.#strings = new OpenVrTrackedDeviceStringReader(systemPointer);
    this.#renderModels = new OpenVR.IVRRenderModels(renderModelsPointer);
  }

  resolve(index: number, trackedDevicePose: OpenVrHmdEmulationPose): OpenVrHmdEmulationPose {
    const renderModel = this.#strings.get(
      index,
      OpenVR.TrackedDeviceProperty.Prop_RenderModelName_String,
    );
    if (!renderModel) {
      return composeTrackedDeviceTipPose(trackedDevicePose, LEGACY_TARGET_RAY_OFFSET);
    }
    let tip = this.#tipByRenderModel.get(renderModel);
    if (tip === undefined) {
      tip = this.#readTip(renderModel);
      this.#tipByRenderModel.set(renderModel, tip);
      this.onResolved?.(index, renderModel, tip != null);
    }
    return composeTrackedDeviceTipPose(trackedDevicePose, tip ?? LEGACY_TARGET_RAY_OFFSET);
  }

  #readTip(renderModel: string): Matrix34Rows | null {
    if (!this.#renderModels.RenderModelHasComponent(renderModel, "tip")) return null;
    const component = createStruct<OpenVR.RenderModel_ComponentState>(
      null,
      OpenVR.RenderModel_ComponentStateStruct,
    );
    const ok = this.#renderModels.GetComponentState(
      renderModel,
      "tip",
      Deno.UnsafePointer.of(this.#controllerState) as Deno.PointerValue<OpenVR.ControllerState>,
      this.#modeState[0],
      component[0],
    );
    if (!ok) return null;
    return OpenVR.RenderModel_ComponentStateStruct.read(component[1]).mTrackingToComponentLocal
      .m as Matrix34Rows;
  }
}
