import { LogChannel } from "@mommysgoodpuppy/logchannel";
import * as THREE from "three";
import raylib, * as raylibBindings from "../submodules/raylib_ts_bindings_deno/raylib_bindings.ts";
import type {
  ExtractionResult,
  GeometryAsset,
  GeometryAttributeAsset,
  InstancedRenderInstance,
  MaterialAsset,
  RenderFrame,
  RenderInstance,
} from "../submodules/raythree/src/lib.ts";
import type {
  WebXRRaythreeUiOrderInfo,
  WebXRRaythreeUiPanelSnapshot,
  WebXRRaythreeUiSnapshot,
} from "./webxrRaythreeUi.ts";

const MAX_MATERIAL_MAPS = 11;
const ZERO_POINTER = 0n;
const DEFAULT_RAYLIB_CAMERA: raylibBindings.Camera3D = {
  position: { x: 0, y: 0, z: 0 },
  target: { x: 0, y: 0, z: -1 },
  up: { x: 0, y: 1, z: 0 },
  fovy: 60,
  projection: raylibBindings.CameraProjection.CAMERA_PERSPECTIVE,
};

function isWebXrRaythreeDebugEnabled(): boolean {
  const configured = Deno.args
    .find((arg) => arg.startsWith("--webxr-raythree-debug="))
    ?.split("=", 2)[1]
    ?.trim()
    .toLowerCase();
  switch (configured) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    default:
      return false;
  }
}

const WEBXR_RAYTHREE_DEBUG = isWebXrRaythreeDebugEnabled();
const WEBXR_RAYTHREE_TEXT_FORCE_NON_INDEXED = false;

/**
 * A/B: set `--webxr-raythree-ui-panel-force-unbatched=1` to draw each uikit
 * panel with `drawUiPanel` (original path) instead of `tryDrawUiPanelsBatched`.
 * - If the keyboard looks **correct** with this on, the bug is in the batch
 *   path (data texture, shader, or `gl_VertexID`).
 * - If it still looks **wrong**, suspect snapshot `panel.data` / clipping, or
 *   the unbatched `UI_PANEL_*` path.
 * Use `--webxr-raythree-ui-panel-batch-debug=1` for a one-time CPU log
 * (texture size, uniform locations, sample packed floats). For GPU work,
 * temporarily replace the end of `UI_PANEL_BATCH_FRAGMENT_SHADER` with e.g.
 * `finalColor = vec4(fract(vPanelId/20.0),fract(vPanelId/3.0),0.0,1.0);` to
 * see whether `vPanelId` and `pfetch` vary per pixel.
 */
function isWebXrRaythreeUiPanelForceUnbatchedEnabled(): boolean {
  const configured = Deno.args
    .find((arg) => arg.startsWith("--webxr-raythree-ui-panel-force-unbatched="))
    ?.split("=", 2)[1]
    ?.trim()
    .toLowerCase();
  return configured === "1" || configured === "true" || configured === "yes" || configured === "on";
}

function isWebXrRaythreeUiPanelBatchDebugEnabled(): boolean {
  const configured = Deno.args
    .find((arg) => arg.startsWith("--webxr-raythree-ui-panel-batch-debug="))
    ?.split("=", 2)[1]
    ?.trim()
    .toLowerCase();
  return configured === "1" || configured === "true" || configured === "yes" || configured === "on";
}

const WEBXR_RAYTHREE_UI_PANEL_FORCE_UNBATCHED = isWebXrRaythreeUiPanelForceUnbatchedEnabled();
const WEBXR_RAYTHREE_UI_PANEL_BATCH_DEBUG = isWebXrRaythreeUiPanelBatchDebugEnabled();

function isWebXrRaythreeTextAssertEnabled(): boolean {
  const configured = Deno.args
    .find((arg) => arg.startsWith("--webxr-raythree-text-assert="))
    ?.split("=", 2)[1]
    ?.trim()
    .toLowerCase();
  switch (configured) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    default:
      return false;
  }
}

const WEBXR_RAYTHREE_TEXT_ASSERT = isWebXrRaythreeTextAssertEnabled();

type NativeMesh = {
  mesh: raylibBindings.Mesh;
  model?: raylibBindings.Model;
};

type NativeMaterial = {
  material: raylibBindings.Material;
  mapsBytes: Uint8Array;
  baseColor: [number, number, number, number];
  usesLighting: boolean;
  transparent: boolean;
  blendMode: raylibBindings.BlendMode;
  /** When true, draw with `rlEnableWireMode` and the same lighting `DrawMesh` as solid. */
  wireframe: boolean;
  /** Mirrors Three `Material.depthTest`; when false, draw passes rlgl depth test (HUD / laser on top). */
  depthTest: boolean;
  /** Mirrors Three `Material.depthWrite`. */
  depthWrite: boolean;
};

type LightingShader = {
  shader: raylibBindings.Shader;
  lightPositionLoc: number;
  lightColorLoc: number;
  ambientColorLoc: number;
  viewPositionLoc: number;
  lightIntensityLoc: number;
  lightRangeLoc: number;
  baseColorLoc: number;
};

type UiPanelShader = {
  shader: raylibBindings.Shader;
  mvpLoc: number;
  worldLoc: number;
  clippingLoc: number;
  backgroundColorLoc: number;
  borderColorLoc: number;
  borderSizeLoc: number;
  borderRadiusLoc: number;
  dimensionsLoc: number;
  depthOffsetLoc: number;
};

type UiTextShader = {
  shader: raylibBindings.Shader;
  mvpLoc: number;
  tintLoc: number;
  pxRangeLoc: number;
  atlasSizeLoc: number;
};

type UiTextBatchShader = {
  shader: raylibBindings.Shader;
};

type UiPanelBatchShader = {
  shader: raylibBindings.Shader;
  mvpLoc: number;
  /** `texture0` (MAP_ALBEDO) — for debug; bound via `material.maps` + DrawMesh, not SetShaderValueTexture. */
  texture0Loc: number;
};

type UiTextMeshCacheEntry = {
  mesh: NativeMesh;
  version: number;
};

const MSDF_ATLAS_PATH = new URL(
  "../submodules/threewebxrwebgpudeno/vendor/three-msdf-text-utils/demo/fonts/roboto/roboto-regular.png",
  import.meta.url,
);
// Typical msdfgen pxRange=4. Roboto atlas from three-msdf-text-utils was generated with this.
const MSDF_PX_RANGE = 4;

export class WebXRRaythreeRaylibRenderer {
  private readonly baseMaterial: raylibBindings.Material;
  private readonly lightingShader: LightingShader;
  private readonly uiPanelShader: UiPanelShader;
  private readonly uiTextShader: UiTextShader;
  private readonly uiPanelMesh: NativeMesh;
  private readonly uiMaterialBytes: Uint8Array;
  private readonly uiMaterial: raylibBindings.Material;
  private readonly uiTextMaterialBytes: Uint8Array;
  private readonly uiTextMaterial: raylibBindings.Material;
  private readonly geometries = new Map<number, NativeMesh>();
  private readonly geometryRevisions = new Map<number, number>();
  private readonly materials = new Map<number, NativeMaterial>();
  private readonly materialRevisions = new Map<number, number>();
  private readonly uiTextMeshes = new Map<string, UiTextMeshCacheEntry>();
  private readonly loggedTextGeometryValidation = new Set<string>();
  private uiMsdfAtlas: raylibBindings.Texture2D | null = null;
  private uiMsdfAtlasSize: [number, number] = [0, 0];
  private uiMsdfAtlasLoadFailed = false;
  private readonly instanceMatrix = new THREE.Matrix4();
  private readonly worldMatrix = new THREE.Matrix4();
  private readonly sortMatrix = new THREE.Matrix4();
  private readonly sortVector = new THREE.Vector3();
  private readonly transparentInstanceScratch: Array<RenderInstance | InstancedRenderInstance> =
    [];
  /** Filled from the current view matrix per frame; `getWorldMatrixViewDepth` reads it (do not re-enter before a sort has finished). */
  private readonly raylibMatrixScratch: raylibBindings.Matrix = {
    m0: 1, m1: 0, m2: 0, m3: 0, m4: 0, m5: 1, m6: 0, m7: 0, m8: 0, m9: 0, m10: 1, m11: 0, m12: 0, m13: 0,
    m14: 0, m15: 1,
  };
  private readonly uiMvpP = new THREE.Matrix4();
  private readonly uiMvpV = new THREE.Matrix4();
  private readonly uiMvpW = new THREE.Matrix4();
  private readonly uiMvp = new THREE.Matrix4();
  /** Precomputed `projection * view` for the current uikit pass (one per eye); MVP = uiMvpPV * world. */
  private readonly uiMvpPV = new THREE.Matrix4();
  private readonly uiTextBatchShader: UiTextBatchShader;
  private readonly uiTextBatchMaterialBytes: Uint8Array;
  private readonly uiTextBatchMaterial: raylibBindings.Material;
  private readonly uiPanelBatchShader: UiPanelBatchShader;
  private readonly uiPanelBatchMaterialBytes: Uint8Array;
  private readonly uiPanelBatchMaterial: raylibBindings.Material;
  private uiTextBatchMesh: NativeMesh | null = null;
  private textBatchPoolPos = new Float32Array(0);
  private textBatchPoolN = new Float32Array(0);
  private textBatchPoolUv = new Float32Array(0);
  private textBatchPoolC = new Uint8Array(0);
  private textBatchPoolCap = 0;
  private uiPanelDataBytes: Uint8Array | null = null;
  private uiPanelDataTexture: raylibBindings.Texture2D | null = null;
  private uiPanelDataTexH = 0;
  private uiPanelDataTexW = 9;
  private uiPanelBatchMesh: NativeMesh | null = null;
  private readonly clipV4 = new THREE.Vector4();
  private readonly identityMatrix16 = new Float32Array([
    1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
  ]);
  private lastBatchedTextAtlasId = 0;
  private readonly loggedTextCounts = new Set<number>();
  private readonly loggedWarnings = new Set<string>();
  private readonly loggedSkippedGeometryIds = new Set<number>();
  private readonly loggedProjectionSummary = new Set<string>();
  private loggedUiPanelBatchDebugOnce = false;
  private loggedUiPanelForceUnbatchedOnce = false;
  constructor() {
    this.baseMaterial = raylib.H.LoadMaterialDefault();
    this.lightingShader = createLightingShader();
    this.uiPanelShader = createUiPanelShader();
    this.uiTextShader = createUiTextShader();
    this.uiPanelMesh = createNativeMesh(createUiQuadGeometryAsset()) ??
      (() => {
        throw new Error("Failed to create raylib UI quad mesh");
      })();
    this.uiMaterialBytes = cloneMaterialMaps(this.baseMaterial);
    this.uiMaterial = {
      shader: this.uiPanelShader.shader,
      maps: pointerAddress(this.uiMaterialBytes),
      params: [...this.baseMaterial.params] as [number, number, number, number],
    } as unknown as raylibBindings.Material;
    this.uiTextMaterialBytes = cloneMaterialMaps(this.baseMaterial);
    this.uiTextMaterial = {
      shader: this.uiTextShader.shader,
      maps: pointerAddress(this.uiTextMaterialBytes),
      params: [...this.baseMaterial.params] as [number, number, number, number],
    } as unknown as raylibBindings.Material;
    this.uiTextBatchShader = createUiTextBatchShader();
    this.uiTextBatchMaterialBytes = cloneMaterialMaps(this.baseMaterial);
    this.uiTextBatchMaterial = {
      shader: this.uiTextBatchShader.shader,
      maps: pointerAddress(this.uiTextBatchMaterialBytes),
      params: [...this.baseMaterial.params] as [number, number, number, number],
    } as unknown as raylibBindings.Material;
    this.uiPanelBatchShader = createUiPanelBatchShader();
    this.uiPanelBatchMaterialBytes = cloneMaterialMaps(this.baseMaterial);
    this.uiPanelBatchMaterial = {
      shader: this.uiPanelBatchShader.shader,
      maps: pointerAddress(this.uiPanelBatchMaterialBytes),
      params: [...this.baseMaterial.params] as [number, number, number, number],
    } as unknown as raylibBindings.Material;
    const uiAlbedo = readMaterialMap(
      this.uiMaterialBytes,
      raylibBindings.MaterialMapIndex.MATERIAL_MAP_ALBEDO,
    );
    writeMaterialMap(
      this.uiMaterialBytes,
      raylibBindings.MaterialMapIndex.MATERIAL_MAP_ALBEDO,
      {
        ...uiAlbedo,
        color: raylib.WHITE,
      },
    );
  }

  private ensureMsdfAtlas(): raylibBindings.Texture2D | null {
    if (this.uiMsdfAtlas !== null || this.uiMsdfAtlasLoadFailed) {
      return this.uiMsdfAtlas;
    }
    try {
      const pathname = Deno.build.os === "windows"
        ? decodeURIComponent(MSDF_ATLAS_PATH.pathname.replace(/^\/+/, ""))
        : decodeURIComponent(MSDF_ATLAS_PATH.pathname);
      const image = raylib.H.LoadImage(pathname);
      // three-msdf-text-utils uses texture.flipY=true; match that upload convention in raylib.
      const imageHandle = raylibBindings.Image.createPointer(image);
      raylib.H.ImageFlipVertical(imageHandle.pointer);
      const flippedImage = imageHandle.read();
      const texture = raylib.H.LoadTextureFromImage(flippedImage);
      raylib.H.SetTextureFilter(texture, raylibBindings.TextureFilter.TEXTURE_FILTER_BILINEAR);
      raylib.H.SetTextureWrap(texture, raylibBindings.TextureWrap.TEXTURE_WRAP_CLAMP);
      this.uiMsdfAtlasSize = [flippedImage.width, flippedImage.height];
      raylib.H.UnloadImage(flippedImage);
      this.uiMsdfAtlas = texture;
      LogChannel.log(
        "webxrv2",
        `[webxr] msdf atlas loaded ${flippedImage.width}x${flippedImage.height} path=${pathname}`,
      );
      return this.uiMsdfAtlas;
    } catch (error) {
      this.uiMsdfAtlasLoadFailed = true;
      LogChannel.log("webxrv2", `[webxr] msdf atlas load failed: ${String(error)}`);
      return null;
    }
  }

  /**
   * `syncMs`: CPU + `UploadMesh` / material work when `assets.geometries` / `assets.materials` lists carry updates.
   * `frameMs`: `DrawMesh` + UI at eye resolution (dominates when batch lists are ~empty every frame).
   */
  renderExtraction(
    extraction: ExtractionResult,
    background: [number, number, number, number],
    matrices?: {
      projectionMatrix: Float32Array;
      viewMatrix: Float32Array;
    },
    debugContext?: string,
    ui?: WebXRRaythreeUiSnapshot,
    options?: { skipAssetSync?: boolean },
  ): {
    syncMs: number;
    frameMs: number;
    prepMs: number;
    opaqueMs: number;
    xparentMs: number;
    uiMs: number;
    uiSortPrepMs: number;
    uiPanelsMs: number;
    uiTextMs: number;
    uiPanelCount: number;
    uiTextCount: number;
    uiPanelDrawn: number;
    uiTextDrawn: number;
    endMs: number;
    batchGeometries: number;
    batchMaterials: number;
  } {
    const t0 = performance.now();
    if (options?.skipAssetSync !== true) {
      this.syncAssets(extraction, debugContext);
    }
    const t1 = performance.now();
    const phases = this.renderFrame(extraction.frame, background, matrices, ui);
    const t2 = performance.now();
    return {
      syncMs: t1 - t0,
      frameMs: t2 - t1,
      prepMs: phases.prepMs,
      opaqueMs: phases.opaqueMs,
      xparentMs: phases.xparentMs,
      uiMs: phases.uiMs,
      uiSortPrepMs: phases.uiSortPrepMs,
      uiPanelsMs: phases.uiPanelsMs,
      uiTextMs: phases.uiTextMs,
      uiPanelCount: phases.uiPanelCount,
      uiTextCount: phases.uiTextCount,
      uiPanelDrawn: phases.uiPanelDrawn,
      uiTextDrawn: phases.uiTextDrawn,
      endMs: phases.endMs,
      batchGeometries: extraction.assets.geometries.length,
      batchMaterials: extraction.assets.materials.length,
    };
  }

  dispose(): void {
    for (const geometry of this.geometries.values()) {
      this.unloadNativeMesh(geometry);
    }
    this.geometries.clear();
    this.geometryRevisions.clear();
    this.materials.clear();
    this.materialRevisions.clear();
    for (const entry of this.uiTextMeshes.values()) {
      this.unloadNativeMesh(entry.mesh);
    }
    this.uiTextMeshes.clear();
    if (this.uiMsdfAtlas !== null) {
      raylib.H.UnloadTexture(this.uiMsdfAtlas);
      this.uiMsdfAtlas = null;
      this.lastBatchedTextAtlasId = 0;
    }
    this.unloadNativeMesh(this.uiPanelMesh);
    if (this.uiTextBatchMesh !== null) {
      this.unloadNativeMesh(this.uiTextBatchMesh);
      this.uiTextBatchMesh = null;
    }
    if (this.uiPanelBatchMesh !== null) {
      this.unloadNativeMesh(this.uiPanelBatchMesh);
      this.uiPanelBatchMesh = null;
    }
    if (this.uiPanelDataTexture !== null) {
      raylib.H.UnloadTexture(this.uiPanelDataTexture);
      this.uiPanelDataTexture = null;
    }
    this.uiPanelDataBytes = null;
    raylib.H.UnloadShader(this.uiTextShader.shader);
    raylib.H.UnloadShader(this.uiTextBatchShader.shader);
    raylib.H.UnloadShader(this.uiPanelShader.shader);
    raylib.H.UnloadShader(this.uiPanelBatchShader.shader);
    raylib.H.UnloadShader(this.lightingShader.shader);
  }

  private syncAssets(extraction: ExtractionResult, debugContext?: string): void {
    let changedGeometryCount = 0;
    let changedMaterialCount = 0;

    for (const warning of extraction.warnings) {
      const key = `${warning.nodeId}:${warning.reason}`;
      if (this.loggedWarnings.has(key)) {
        continue;
      }
      this.loggedWarnings.add(key);
      debugLog(
        `warning node=${warning.nodeId} type=${warning.objectType} name=${
          warning.objectName || "<unnamed>"
        } reason=${warning.reason}`,
      );
    }

    for (const geometry of extraction.assets.geometries) {
      const previousRevision = this.geometryRevisions.get(geometry.id);
      if (previousRevision === geometry.revision) {
        continue;
      }
      changedGeometryCount++;
      const existing = this.geometries.get(geometry.id);
      if (existing !== undefined) {
        debugLog(
          `geometry unload ctx=${debugContext ?? "unknown"} id=${geometry.id} label=${
            geometry.debugLabel ?? "<unknown>"
          } rev=${previousRevision ?? "none"}->${geometry.revision}`,
        );
        this.unloadNativeMesh(existing);
        this.geometries.delete(geometry.id);
      }
      const nativeMesh = createNativeMesh(geometry);
      if (!nativeMesh) {
        if (!this.loggedSkippedGeometryIds.has(geometry.id)) {
          this.loggedSkippedGeometryIds.add(geometry.id);
          debugLog(
            `skipping geometry=${geometry.id} attrs=${describeGeometryAttributes(geometry)}`,
          );
        }
        continue;
      }
      this.geometries.set(geometry.id, nativeMesh);
      this.geometryRevisions.set(geometry.id, geometry.revision);
      debugLog(
        `geometry upload ctx=${debugContext ?? "unknown"} id=${geometry.id} label=${
          geometry.debugLabel ?? "<unknown>"
        } rev=${previousRevision ?? "none"}->${geometry.revision} attrs=${
          describeGeometryAttributes(geometry)
        }`,
      );
    }

    for (const material of extraction.assets.materials) {
      const previousRevision = this.materialRevisions.get(material.id);
      if (previousRevision === material.revision) {
        continue;
      }
      changedMaterialCount++;
      this.materials.set(
        material.id,
        createNativeMaterial(material, this.baseMaterial, this.lightingShader),
      );
      this.materialRevisions.set(material.id, material.revision);
    }

    if (changedGeometryCount > 0 || changedMaterialCount > 0) {
      debugLog(
        `sync ctx=${
          debugContext ?? "unknown"
        } geometriesChanged=${changedGeometryCount} materialsChanged=${changedMaterialCount} instances=${extraction.frame.instances.length}`,
      );
    }
  }

  private renderFrame(
    frame: RenderFrame,
    background: [number, number, number, number],
    matrices?: {
      projectionMatrix: Float32Array;
      viewMatrix: Float32Array;
    },
    ui?: WebXRRaythreeUiSnapshot,
  ): {
    prepMs: number;
    opaqueMs: number;
    xparentMs: number;
    uiMs: number;
    uiSortPrepMs: number;
    uiPanelsMs: number;
    uiTextMs: number;
    uiPanelCount: number;
    uiTextCount: number;
    uiPanelDrawn: number;
    uiTextDrawn: number;
    endMs: number;
  } {
    const tPrep0 = performance.now();
    applyLighting(this.lightingShader, frame);
    this.maybeLogProjectionSummary(frame);
    const viewMatrix = (matrices?.viewMatrix ?? frame.camera.viewMatrix) as Float32Array;
    const projectionMatrix = (matrices?.projectionMatrix ?? frame.camera.projectionMatrix) as Float32Array;
    this.sortMatrix.fromArray(viewMatrix as unknown as number[]);
    const scratch = this.transparentInstanceScratch;
    scratch.length = 0;
    for (let i = 0; i < frame.instances.length; i++) {
      const inst = frame.instances[i]!;
      if (this.materials.get(inst.materialId)?.transparent === true) {
        scratch.push(inst);
      }
    }
    scratch.sort((left, right) =>
      this.getInstanceViewDepth(right) - this.getInstanceViewDepth(left)
    );
    const transparentInstances = scratch;

    raylib.H.ClearBackground(toRaylibColor(background));
    raylib.H.BeginMode3D(DEFAULT_RAYLIB_CAMERA);
    raylib.H.rlSetMatrixProjection(
      this.matrixForDraw((matrices?.projectionMatrix ?? frame.camera.projectionMatrix) as ArrayLike<number>),
    );
    raylib.H.rlSetMatrixModelview(
      this.matrixForDraw(viewMatrix),
    );
    const tPrep1 = performance.now();

    for (const instance of frame.instances) {
      const nativeMesh = this.geometries.get(instance.geometryId);
      const nativeMaterial = this.materials.get(instance.materialId);
      if (!nativeMesh || !nativeMaterial || nativeMaterial.transparent) {
        continue;
      }

      this.drawInstance(nativeMesh, nativeMaterial, instance);
    }
    const tOpq1 = performance.now();

    raylib.H.BeginBlendMode(raylib.BlendMode.BLEND_ALPHA);
    for (const instance of transparentInstances) {
      const nativeMesh = this.geometries.get(instance.geometryId);
      const nativeMaterial = this.materials.get(instance.materialId);
      if (!nativeMesh || !nativeMaterial) {
        continue;
      }

      this.drawInstance(nativeMesh, nativeMaterial, instance);
    }
    const tXpr1 = performance.now();
    let uiSortPrepMs = 0;
    let uiPanelsMs = 0;
    let uiTextMs = 0;
    let uiPanelCount = 0;
    let uiTextCount = 0;
    let uiPanelDrawn = 0;
    let uiTextDrawn = 0;
    if (ui !== undefined) {
      setUiDepthMaskEnabled(false);
      setUiDepthTestEnabled(false);
      setUiBackfaceCullingEnabled(false);
      try {
        const uiPhases = this.drawUiSnapshot(ui, viewMatrix, projectionMatrix);
        uiSortPrepMs = uiPhases.sortPrepMs;
        uiPanelsMs = uiPhases.panelsMs;
        uiTextMs = uiPhases.textMs;
        uiPanelCount = uiPhases.panelCount;
        uiTextCount = uiPhases.textCount;
        uiPanelDrawn = uiPhases.panelDrawn;
        uiTextDrawn = uiPhases.textDrawn;
      } finally {
        setUiBackfaceCullingEnabled(true);
        setUiDepthTestEnabled(true);
        setUiDepthMaskEnabled(true);
      }
    }
    const tUi1 = performance.now();
    raylib.H.EndBlendMode();

    raylib.H.EndMode3D();
    const tEnd1 = performance.now();
    return {
      prepMs: tPrep1 - tPrep0,
      opaqueMs: tOpq1 - tPrep1,
      xparentMs: tXpr1 - tOpq1,
      uiMs: tUi1 - tXpr1,
      uiSortPrepMs,
      uiPanelsMs,
      uiTextMs,
      uiPanelCount,
      uiTextCount,
      uiPanelDrawn,
      uiTextDrawn,
      endMs: tEnd1 - tUi1,
    };
  }

  /**
   * Renders uikit with one `DrawMesh` + many uniform sets per panel (and one draw per text mesh).
   * Hitting sub‑millisecond UI time at native res needs far fewer draw calls (instanced or packed
   * instance buffer + one draw; possibly lighter fragment work), not only halving per-eye work.
   */
  private drawUiSnapshot(
    ui: WebXRRaythreeUiSnapshot,
    viewMatrix: Float32Array,
    projectionMatrix: Float32Array,
  ): {
    sortPrepMs: number;
    panelsMs: number;
    textMs: number;
    panelCount: number;
    textCount: number;
    panelDrawn: number;
    textDrawn: number;
  } {
    const t0 = performance.now();
    this.uiMvpP.fromArray(projectionMatrix as unknown as number[]);
    this.uiMvpV.fromArray(viewMatrix as unknown as number[]);
    this.uiMvpPV.copy(this.uiMvpP).multiply(this.uiMvpV);

    const panels = [...ui.panels].sort((left, right) => {
      if (left.renderOrder !== right.renderOrder) {
        return left.renderOrder - right.renderOrder;
      }
      const orderDifference = compareUiOrderInfo(left.orderInfo, right.orderInfo);
      if (orderDifference !== 0) {
        return orderDifference;
      }
      if (left.instanceIndex !== right.instanceIndex) {
        return left.instanceIndex - right.instanceIndex;
      }
      return this.getWorldMatrixViewDepth(right.worldMatrix) -
        this.getWorldMatrixViewDepth(left.worldMatrix);
    });
    const texts = [...ui.texts].sort((left, right) =>
      this.getWorldMatrixViewDepth(right.worldMatrix) -
        this.getWorldMatrixViewDepth(left.worldMatrix)
    );
    const t1 = performance.now();

    if (WEBXR_RAYTHREE_UI_PANEL_FORCE_UNBATCHED && !this.loggedUiPanelForceUnbatchedOnce) {
      this.loggedUiPanelForceUnbatchedOnce = true;
      LogChannel.log(
        "webxrv2",
        "[webxr] UI panels: force-unbatched (per-panel drawUiPanel); batch path skipped. " +
          "Remove --webxr-raythree-ui-panel-force-unbatched=1 to re-test batching.",
      );
    }

    const panelBatched = WEBXR_RAYTHREE_UI_PANEL_FORCE_UNBATCHED
      ? null
      : this.tryDrawUiPanelsBatched(panels, this.uiMvpPV);
    let panelDrawn = 0;
    if (panelBatched === null) {
      for (const panel of panels) {
        if (this.drawUiPanel(panel, this.uiMvpPV)) {
          panelDrawn++;
        }
      }
    } else {
      panelDrawn = panelBatched;
    }
    const t2 = performance.now();

    const textBatched = this.tryDrawUiTextBatched(texts, this.uiMvpPV);
    let textDrawn = 0;
    if (textBatched === null) {
      for (const text of texts) {
        if (this.drawUiText(text, this.uiMvpPV)) {
          textDrawn++;
        }
      }
    } else {
      textDrawn = textBatched;
    }
    const t3 = performance.now();

    if (ui.texts.length > 0 && !this.loggedTextCounts.has(ui.texts.length)) {
      this.loggedTextCounts.add(ui.texts.length);
      debugLog(`ui text snapshot count=${ui.texts.length} renderer=billboard`);
    }

    return {
      sortPrepMs: t1 - t0,
      panelsMs: t2 - t1,
      textMs: t3 - t2,
      panelCount: ui.panels.length,
      textCount: ui.texts.length,
      panelDrawn,
      textDrawn,
    };
  }

  private setUiShaderMvp(
    shader: raylibBindings.Shader,
    mvpLoc: number,
    projView: THREE.Matrix4,
    world: ArrayLike<number>,
  ): void {
    if (mvpLoc < 0) {
      return;
    }
    const worldEl = this.uiMvpW.elements;
    for (let i = 0; i < 16; i++) {
      worldEl[i] = Number(world[i]);
    }
    this.uiMvp.copy(projView).multiply(this.uiMvpW);
    raylib.H.SetShaderValueMatrix(
      shader,
      mvpLoc,
      this.matrixForDraw(this.uiMvp.elements),
    );
  }

  private isUikitPanelCulled(panel: WebXRRaythreeUiPanelSnapshot): boolean {
    const width = Math.max(0, Number(panel.data[14] ?? 0));
    const height = Math.max(0, Number(panel.data[15] ?? 0));
    if (width <= 0 || height <= 0) {
      return true;
    }
    let wsum = 0;
    for (let j = 0; j < 16; j++) {
      wsum += Math.abs(panel.worldMatrix[j] ?? 0);
    }
    if (wsum < 1e-8) {
      return true;
    }
    const borderTop = Math.max(0, Number(panel.data[0] ?? 0));
    const borderRight = Math.max(0, Number(panel.data[1] ?? 0));
    const borderBottom = Math.max(0, Number(panel.data[2] ?? 0));
    const borderLeft = Math.max(0, Number(panel.data[3] ?? 0));
    const bgA = panel.data[7] ?? 0;
    const brdA = panel.data[12] ?? 0;
    if (
      bgA <= 1e-4 &&
      (brdA <= 1e-4 || (borderTop <= 0 && borderRight <= 0 && borderBottom <= 0 && borderLeft <= 0))
    ) {
      return true;
    }
    return false;
  }

  /** @returns `true` if a panel quad was submitted to the GPU. */
  private drawUiPanel(
    panel: WebXRRaythreeUiSnapshot["panels"][number],
    projView: THREE.Matrix4,
  ): boolean {
    if (this.isUikitPanelCulled(panel)) {
      return false;
    }
    const width = Math.max(0, Number(panel.data[14] ?? 0));
    const height = Math.max(0, Number(panel.data[15] ?? 0));
    const borderTop = Math.max(0, Number(panel.data[0] ?? 0));
    const borderRight = Math.max(0, Number(panel.data[1] ?? 0));
    const borderBottom = Math.max(0, Number(panel.data[2] ?? 0));
    const borderLeft = Math.max(0, Number(panel.data[3] ?? 0));
    const backgroundColor = readUiColor(panel.data, 4);
    const borderColor = readUiColor(panel.data, 9);
    setShaderVec4(
      this.uiPanelShader.shader,
      this.uiPanelShader.backgroundColorLoc,
      toShaderColor(backgroundColor),
    );
    setShaderVec4(
      this.uiPanelShader.shader,
      this.uiPanelShader.borderColorLoc,
      toShaderColor(borderColor),
    );
    setShaderVec4(
      this.uiPanelShader.shader,
      this.uiPanelShader.borderSizeLoc,
      [borderTop, borderRight, borderBottom, borderLeft],
    );
    setShaderVec4(
      this.uiPanelShader.shader,
      this.uiPanelShader.borderRadiusLoc,
      unpackUiBorderRadius(panel.data[8] ?? 0),
    );
    setShaderVec2(
      this.uiPanelShader.shader,
      this.uiPanelShader.dimensionsLoc,
      width,
      height,
    );
    setShaderFloat(
      this.uiPanelShader.shader,
      this.uiPanelShader.depthOffsetLoc,
      computeUiDepthOffset(panel.orderInfo, panel.instanceIndex),
    );
    if (this.uiPanelShader.worldLoc >= 0) {
      raylib.H.SetShaderValueMatrix(
        this.uiPanelShader.shader,
        this.uiPanelShader.worldLoc,
        this.matrixForDraw(panel.worldMatrix),
      );
    }
    if (this.uiPanelShader.clippingLoc >= 0) {
      raylib.H.SetShaderValueMatrix(
        this.uiPanelShader.shader,
        this.uiPanelShader.clippingLoc,
        this.matrixForDraw(panel.clipping),
      );
    }
    this.setUiShaderMvp(
      this.uiPanelShader.shader,
      this.uiPanelShader.mvpLoc,
      projView,
      panel.worldMatrix,
    );
    this.drawUiQuad(panel.worldMatrix);
    return true;
  }

  private drawUiQuad(
    worldMatrix: ArrayLike<number>,
  ): void {
    raylib.H.DrawMesh(
      this.uiPanelMesh.mesh,
      this.uiMaterial,
      this.matrixForDraw(worldMatrix),
    );
  }

  /** @returns `true` if a text mesh was submitted to the GPU. */
  private drawUiText(
    text: WebXRRaythreeUiSnapshot["texts"][number],
    projView: THREE.Matrix4,
  ): boolean {
    if (text.text.length === 0 || text.color[3] <= 0 || text.geometry == null) {
      return false;
    }
    const atlas = this.ensureMsdfAtlas();
    if (atlas === null) {
      return false;
    }
    const mesh = this.getUiTextMesh(text);
    if (mesh === null) {
      return false;
    }

    const albedoMap = readMaterialMap(
      this.uiTextMaterialBytes,
      raylibBindings.MaterialMapIndex.MATERIAL_MAP_ALBEDO,
    );
    writeMaterialMap(
      this.uiTextMaterialBytes,
      raylibBindings.MaterialMapIndex.MATERIAL_MAP_ALBEDO,
      { ...albedoMap, texture: atlas, color: raylib.WHITE },
    );

    setShaderVec4(this.uiTextShader.shader, this.uiTextShader.tintLoc, [
      text.color[0],
      text.color[1],
      text.color[2],
      text.color[3],
    ]);
    setShaderFloat(this.uiTextShader.shader, this.uiTextShader.pxRangeLoc, MSDF_PX_RANGE);
    setShaderVec2(
      this.uiTextShader.shader,
      this.uiTextShader.atlasSizeLoc,
      this.uiMsdfAtlasSize[0],
      this.uiMsdfAtlasSize[1],
    );

    this.setUiShaderMvp(
      this.uiTextShader.shader,
      this.uiTextShader.mvpLoc,
      projView,
      text.worldMatrix,
    );
    raylib.H.DrawMesh(mesh.mesh, this.uiTextMaterial, this.matrixForDraw(text.worldMatrix));
    return true;
  }

  private getUiTextMesh(
    text: WebXRRaythreeUiSnapshot["texts"][number],
  ): NativeMesh | null {
    const geometry = text.geometry;
    if (geometry === undefined) return null;
    const key = createUiTextGeometryKey(text.text, geometry);
    maybeValidateMsdfGeometry(text.text, geometry, this.loggedTextGeometryValidation);
    const existing = this.uiTextMeshes.get(key);
    if (existing !== undefined && existing.version === geometry.version) {
      return existing.mesh;
    }
    if (existing !== undefined) {
      this.unloadNativeMesh(existing.mesh);
      this.uiTextMeshes.delete(key);
    }
    const mesh = createNativeMeshFromMsdfBuffers(
      geometry.positions,
      geometry.uvs,
      geometry.indices,
      text.text,
    );
    if (mesh === null) return null;
    this.uiTextMeshes.set(key, { mesh, version: geometry.version });
    return mesh;
  }

  private maybeLogProjectionSummary(frame: RenderFrame): void {
    if (!WEBXR_RAYTHREE_DEBUG || frame.camera.type !== "perspective") {
      return;
    }
    const summary = [
      frame.camera.type,
      frame.camera.fovYRadians?.toFixed(4) ?? "na",
      frame.camera.projectionMatrix[0]?.toFixed(4) ?? "na",
      frame.camera.projectionMatrix[5]?.toFixed(4) ?? "na",
      frame.camera.near.toFixed(4),
      frame.camera.far.toFixed(4),
    ].join("|");
    if (this.loggedProjectionSummary.has(summary)) {
      return;
    }
    this.loggedProjectionSummary.add(summary);
    debugLog(
      `camera type=${frame.camera.type} fovY=${frame.camera.fovYRadians?.toFixed(4) ?? "na"} ` +
        `proj00=${frame.camera.projectionMatrix[0]?.toFixed(4) ?? "na"} ` +
        `proj11=${frame.camera.projectionMatrix[5]?.toFixed(4) ?? "na"} ` +
        `near=${frame.camera.near.toFixed(4)} far=${frame.camera.far.toFixed(4)}`,
    );
  }

  private drawNativeMesh(
    nativeMesh: NativeMesh,
    material: NativeMaterial,
    worldMatrix: ArrayLike<number>,
  ): void {
    const restoreDepthTest = !material.depthTest;
    const restoreDepthMask = !material.depthWrite;
    if (restoreDepthTest) {
      setUiDepthTestEnabled(false);
    }
    if (restoreDepthMask) {
      setUiDepthMaskEnabled(false);
    }
    try {
      if (material.wireframe) {
        if (material.usesLighting) {
          setShaderVec4(
            this.lightingShader.shader,
            this.lightingShader.baseColorLoc,
            material.baseColor,
          );
        }
        if (material.transparent && material.blendMode !== raylibBindings.BlendMode.BLEND_ALPHA) {
          raylib.H.EndBlendMode();
          raylib.H.BeginBlendMode(material.blendMode);
        }
        setWireModeEnabled(true);
        try {
          raylib.H.DrawMesh(
            nativeMesh.mesh,
            material.material,
            this.matrixForDraw(worldMatrix),
          );
        } finally {
          setWireModeEnabled(false);
        }
        if (material.transparent && material.blendMode !== raylibBindings.BlendMode.BLEND_ALPHA) {
          raylib.H.EndBlendMode();
          raylib.H.BeginBlendMode(raylibBindings.BlendMode.BLEND_ALPHA);
        }
        return;
      }

      if (material.usesLighting) {
        setShaderVec4(
          this.lightingShader.shader,
          this.lightingShader.baseColorLoc,
          material.baseColor,
        );
      }

      if (material.transparent && material.blendMode !== raylibBindings.BlendMode.BLEND_ALPHA) {
        raylib.H.EndBlendMode();
        raylib.H.BeginBlendMode(material.blendMode);
      }
      raylib.H.DrawMesh(
        nativeMesh.mesh,
        material.material,
        this.matrixForDraw(worldMatrix),
      );
      if (material.transparent && material.blendMode !== raylibBindings.BlendMode.BLEND_ALPHA) {
        raylib.H.EndBlendMode();
        raylib.H.BeginBlendMode(raylibBindings.BlendMode.BLEND_ALPHA);
      }
    } finally {
      if (restoreDepthTest) {
        setUiDepthTestEnabled(true);
      }
      if (restoreDepthMask) {
        setUiDepthMaskEnabled(true);
      }
    }
  }

  private drawInstance(
    nativeMesh: NativeMesh,
    nativeMaterial: NativeMaterial,
    instance: RenderInstance | InstancedRenderInstance,
  ): void {
    if (isInstancedInstance(instance)) {
      this.worldMatrix.fromArray(instance.worldMatrix as unknown as number[]);
      for (let index = 0; index < instance.instanceCount; index++) {
        this.instanceMatrix.fromArray(
          instance.instanceMatrices as unknown as number[],
          index * 16,
        );
        this.instanceMatrix.premultiply(this.worldMatrix);
        this.drawNativeMesh(nativeMesh, nativeMaterial, this.instanceMatrix.elements);
      }
      return;
    }

    this.drawNativeMesh(nativeMesh, nativeMaterial, instance.worldMatrix);
  }

  private getInstanceViewDepth(
    instance: RenderInstance | InstancedRenderInstance,
  ): number {
    return this.getWorldMatrixViewDepth(instance.worldMatrix);
  }

  private getWorldMatrixViewDepth(
    worldMatrix: ArrayLike<number>,
  ): number {
    this.sortVector.set(
      Number(worldMatrix[12] ?? 0),
      Number(worldMatrix[13] ?? 0),
      Number(worldMatrix[14] ?? 0),
    );
    this.sortVector.applyMatrix4(this.sortMatrix);
    return -this.sortVector.z;
  }

  /** Fills and returns `this.raylibMatrixScratch` — safe for one immediate FFI/DrawMesh use per call. */
  private matrixForDraw(elements: ArrayLike<number>): raylibBindings.Matrix {
    const m = this.raylibMatrixScratch;
    m.m0 = Number(elements[0]);
    m.m4 = Number(elements[4]);
    m.m8 = Number(elements[8]);
    m.m12 = Number(elements[12]);
    m.m1 = Number(elements[1]);
    m.m5 = Number(elements[5]);
    m.m9 = Number(elements[9]);
    m.m13 = Number(elements[13]);
    m.m2 = Number(elements[2]);
    m.m6 = Number(elements[6]);
    m.m10 = Number(elements[10]);
    m.m14 = Number(elements[14]);
    m.m3 = Number(elements[3]);
    m.m7 = Number(elements[7]);
    m.m11 = Number(elements[11]);
    m.m15 = Number(elements[15]);
    return m;
  }

  private ensureUikitPanelDataTexture(rowCount: number): void {
    const h = Math.max(rowCount, 1);
    if (
      this.uiPanelDataBytes !== null && h <= this.uiPanelDataTexH &&
      this.uiPanelDataTexture !== null
    ) {
      return;
    }
    if (this.uiPanelDataTexture !== null) {
      raylib.H.UnloadTexture(this.uiPanelDataTexture);
      this.uiPanelDataTexture = null;
    }
    this.uiPanelDataTexH = h;
    const w = this.uiPanelDataTexW;
    const fmt = raylib.PixelFormat.PIXELFORMAT_UNCOMPRESSED_R32G32B32A32;
    const byteLen = Number(raylib.H.GetPixelDataSize(w, h, fmt));
    const bytes = new Uint8Array(byteLen);
    this.uiPanelDataBytes = bytes;
    // `UnloadImage` frees `im.data` with raylib's allocator. JS heap pointers
    // (UnsafePointer.of(bytes)) must not be passed through — copy into MemAlloc.
    const heap = raylib.H.MemAlloc(byteLen);
    const heapAddr = voidPointerToBigint(heap);
    if (heapAddr === ZERO_POINTER) {
      this.uiPanelDataBytes = null;
      this.uiPanelDataTexH = 0;
      return;
    }
    const heapPtr = pointerFromAddress(heapAddr);
    if (heapPtr === null) {
      this.uiPanelDataBytes = null;
      this.uiPanelDataTexH = 0;
      return;
    }
    new Uint8Array(
      new Deno.UnsafePointerView(heapPtr).getArrayBuffer(byteLen),
    ).set(bytes);
    const image: raylib.Image = {
      data: heapAddr as unknown as raylib.Image["data"],
      width: w,
      height: h,
      mipmaps: 1,
      format: fmt,
    };
    const imageHandle = raylibBindings.Image.createPointer(image);
    const im = imageHandle.read();
    this.uiPanelDataTexture = raylib.H.LoadTextureFromImage(im);
    raylib.H.UnloadImage(im);
    raylib.H.SetTextureFilter(
      this.uiPanelDataTexture,
      raylibBindings.TextureFilter.TEXTURE_FILTER_POINT,
    );
    raylib.H.SetTextureWrap(
      this.uiPanelDataTexture,
      raylibBindings.TextureWrap.TEXTURE_WRAP_CLAMP,
    );
  }

  /**
   * One `DrawMesh` for all uikit panel quads. Returns drawn count, `null` to fall back to per-panel draws.
   */
  private tryDrawUiPanelsBatched(
    panels: WebXRRaythreeUiPanelSnapshot[],
    projView: THREE.Matrix4,
  ): number | null {
    const drawn: WebXRRaythreeUiPanelSnapshot[] = [];
    for (const p of panels) {
      if (!this.isUikitPanelCulled(p)) {
        drawn.push(p);
      }
    }
    if (drawn.length === 0) {
      return 0;
    }
    if (drawn.length > 255) {
      return null;
    }
    this.ensureUikitPanelDataTexture(drawn.length);
    if (this.uiPanelDataBytes === null || this.uiPanelDataTexture === null) {
      return null;
    }
    const f = new Float32Array(
      this.uiPanelDataBytes.buffer,
      this.uiPanelDataBytes.byteOffset,
      this.uiPanelDataBytes.length / 4,
    );
    for (let i = 0; i < drawn.length; i++) {
      packUikitPanelRow(f, i, drawn[i]!);
    }
    const up = Deno.UnsafePointer.of(
      this.uiPanelDataBytes as unknown as BufferSource,
    );
    if (up === null) {
      return null;
    }
    raylib.H.UpdateTexture(this.uiPanelDataTexture, up);
    if (this.uiPanelBatchMesh !== null) {
      this.unloadNativeMesh(this.uiPanelBatchMesh);
      this.uiPanelBatchMesh = null;
    }
    const vCount = 6 * drawn.length;
    const pos = new Float32Array(vCount * 3);
    const nrm = new Float32Array(vCount * 3);
    const uv = new Float32Array(vCount * 2);
    const col = new Uint8Array(vCount * 4);
    for (let pi = 0; pi < drawn.length; pi++) {
      const panel = drawn[pi]!;
      this.worldMatrix.fromArray(panel.worldMatrix as unknown as number[]);
      for (let v = 0; v < 6; v++) {
        const o3 = (pi * 6 + v) * 3;
        this.clipV4.set(
          UI_QUAD6_POS[v * 3]!,
          UI_QUAD6_POS[v * 3 + 1]!,
          UI_QUAD6_POS[v * 3 + 2]!,
          1,
        );
        this.clipV4.applyMatrix4(this.worldMatrix);
        pos[o3] = this.clipV4.x;
        pos[o3 + 1] = this.clipV4.y;
        pos[o3 + 2] = this.clipV4.z;
        nrm[o3] = 0;
        nrm[o3 + 1] = 0;
        nrm[o3 + 2] = 1;
        const o2 = (pi * 6 + v) * 2;
        uv[o2] = UI_QUAD6_UV[v * 2]!;
        uv[o2 + 1] = UI_QUAD6_UV[v * 2 + 1]!;
        const o4 = (pi * 6 + v) * 4;
        // Panel row index comes from `gl_VertexID/6` in the batch panel shader, not from color.
        col[o4] = 255;
        col[o4 + 1] = 255;
        col[o4 + 2] = 255;
        col[o4 + 3] = 255;
      }
    }
    const triCount = vCount / 3;
    const meshHandle = raylibBindings.Mesh.createPointer({
      vertexCount: vCount,
      triangleCount: triCount,
      vertices: pointerAddress(pos),
      texcoords: pointerAddress(uv),
      texcoords2: ZERO_POINTER,
      normals: pointerAddress(nrm),
      tangents: ZERO_POINTER,
      colors: pointerAddress(col),
      indices: ZERO_POINTER,
      animVertices: ZERO_POINTER,
      animNormals: ZERO_POINTER,
      boneIds: ZERO_POINTER,
      boneWeights: ZERO_POINTER,
      boneMatrices: ZERO_POINTER,
      boneCount: 0,
      vaoId: 0,
      vboId: ZERO_POINTER,
    } as unknown as raylibBindings.Mesh);
    raylib.H.UploadMesh(meshHandle.pointer, false);
    const uploaded = meshHandle.read();
    const sanitized = sanitizeUploadedMesh(uploaded);
    meshHandle.write(sanitized);
    this.uiPanelBatchMesh = { mesh: sanitized };
    if (this.uiPanelBatchShader.mvpLoc >= 0) {
      raylib.H.SetShaderValueMatrix(
        this.uiPanelBatchShader.shader,
        this.uiPanelBatchShader.mvpLoc,
        this.matrixForDraw(projView.elements as unknown as number[]),
      );
    }
    // Bind panel data like the MSDF text batch: put it on MATERIAL_MAP_ALBEDO so
    // DrawMesh() runs rlEnableTexture (glBindTexture) for the sampler. setShaderValueTexture
    // for a custom uPanelData only sets the uniform; rlgl never binds the id before rlDrawVertexArray.
    const panelDataAlbedo = readMaterialMap(
      this.uiPanelBatchMaterialBytes,
      raylibBindings.MaterialMapIndex.MATERIAL_MAP_ALBEDO,
    );
    writeMaterialMap(
      this.uiPanelBatchMaterialBytes,
      raylibBindings.MaterialMapIndex.MATERIAL_MAP_ALBEDO,
      {
        ...panelDataAlbedo,
        texture: this.uiPanelDataTexture,
        color: raylib.WHITE,
      },
    );
    if (WEBXR_RAYTHREE_UI_PANEL_BATCH_DEBUG && !this.loggedUiPanelBatchDebugOnce) {
      this.loggedUiPanelBatchDebugOnce = true;
      const fmt = raylib.PixelFormat.PIXELFORMAT_UNCOMPRESSED_R32G32B32A32;
      const row0h = f.subarray(0, 16);
      const row1h = drawn.length > 1 ? f.subarray(36, 36 + 16) : null;
      LogChannel.log(
        "webxrv2",
        "[webxr] UI panel batch (one-shot): " +
          `drawn=${drawn.length} tex=${this.uiPanelDataTexW}x${this.uiPanelDataTexH} ` +
          `format=${fmt} mvpLoc=${this.uiPanelBatchShader.mvpLoc} texture0Loc=${this.uiPanelBatchShader.texture0Loc} ` +
          `vertexCount=${vCount} (vPanelId=gl_VertexID/6) ` +
          `row0_16f_border_bg_brdrad=[${Array.from(row0h).map((x) => x.toFixed(4)).join(", ")}] ` +
          (row1h != null
            ? `row1_16f=[${Array.from(row1h).map((x) => x.toFixed(4)).join(", ")}]`
            : "row1=—"),
      );
    }
    raylib.H.DrawMesh(
      this.uiPanelBatchMesh.mesh,
      this.uiPanelBatchMaterial,
      this.matrixForDraw(this.identityMatrix16),
    );
    return drawn.length;
  }

  private ensureTextBatchPool(vertexCount: number): void {
    if (this.textBatchPoolCap >= vertexCount) {
      return;
    }
    this.textBatchPoolCap = Math.max(Math.ceil(vertexCount * 1.2), 1024);
    this.textBatchPoolPos = new Float32Array(this.textBatchPoolCap * 3);
    this.textBatchPoolN = new Float32Array(this.textBatchPoolCap * 3);
    this.textBatchPoolUv = new Float32Array(this.textBatchPoolCap * 2);
    this.textBatchPoolC = new Uint8Array(this.textBatchPoolCap * 4);
  }

  /**
   * One `DrawMesh` for all MSDF labels. Returns drawn *string* count, `null` to use per-text `DrawMesh`.
   */
  private tryDrawUiTextBatched(
    texts: WebXRRaythreeUiSnapshot["texts"],
    projView: THREE.Matrix4,
  ): number | null {
    const atlas = this.ensureMsdfAtlas();
    if (atlas === null) {
      return null;
    }
    if (atlas.id !== this.lastBatchedTextAtlasId) {
      const albedoMap = readMaterialMap(
        this.uiTextBatchMaterialBytes,
        raylibBindings.MaterialMapIndex.MATERIAL_MAP_ALBEDO,
      );
      writeMaterialMap(
        this.uiTextBatchMaterialBytes,
        raylibBindings.MaterialMapIndex.MATERIAL_MAP_ALBEDO,
        {
          ...albedoMap,
          texture: atlas,
          color: raylib.WHITE,
        },
      );
      this.lastBatchedTextAtlasId = atlas.id;
    }
    const work: Array<{
      g: MsdfCpuGeometry;
      m: THREE.Matrix4;
      color: [number, number, number, number];
    }> = [];
    for (const t of texts) {
      if (t.text.length === 0 || t.color[3] <= 0 || t.geometry == null) {
        continue;
      }
      let g = buildMsdfGeometryCpu(
        t.geometry.positions,
        t.geometry.uvs,
        t.geometry.indices,
        t.text,
      );
      if (g == null) {
        continue;
      }
      if (!g.expanded) {
        const ex = expandIndexedMsdfTriangles(
          g.positions3D,
          g.uvs,
          g.indices!,
        );
        g = {
          ...g,
          ...ex,
          expanded: true,
          indices: null,
          triangleCount: ex.vertexCount / 3,
        };
      }
      this.uiMvpW.fromArray(t.worldMatrix as unknown as number[]);
      this.uiMvp.copy(projView).multiply(this.uiMvpW);
      work.push({ g, m: this.uiMvp.clone(), color: t.color });
    }
    if (work.length === 0) {
      return 0;
    }
    let totalV = 0;
    for (const w of work) {
      totalV += w.g.vertexCount;
    }
    if (totalV > 500000) {
      return null;
    }
    this.ensureTextBatchPool(totalV);
    let wx = 0;
    for (const it of work) {
      for (let i = 0; i < it.g.vertexCount; i++) {
        this.clipV4.set(
          it.g.positions3D[i * 3]!,
          it.g.positions3D[i * 3 + 1]!,
          it.g.positions3D[i * 3 + 2]!,
          1,
        );
        this.clipV4.applyMatrix4(it.m);
        const o3 = wx * 3;
        this.textBatchPoolPos[o3] = this.clipV4.x;
        this.textBatchPoolPos[o3 + 1] = this.clipV4.y;
        this.textBatchPoolPos[o3 + 2] = this.clipV4.z;
        this.textBatchPoolN[o3] = this.clipV4.w;
        this.textBatchPoolN[o3 + 1] = 0;
        this.textBatchPoolN[o3 + 2] = 0;
        const o2 = wx * 2;
        this.textBatchPoolUv[o2] = it.g.uvs[i * 2]!;
        this.textBatchPoolUv[o2 + 1] = it.g.uvs[i * 2 + 1]!;
        const o4 = wx * 4;
        this.textBatchPoolC[o4] = Math.round(it.color[0] * 255);
        this.textBatchPoolC[o4 + 1] = Math.round(it.color[1] * 255);
        this.textBatchPoolC[o4 + 2] = Math.round(it.color[2] * 255);
        this.textBatchPoolC[o4 + 3] = Math.round(it.color[3] * 255);
        wx++;
      }
    }
    if (this.uiTextBatchMesh !== null) {
      this.unloadNativeMesh(this.uiTextBatchMesh);
      this.uiTextBatchMesh = null;
    }
    const th = raylibBindings.Mesh.createPointer({
      vertexCount: totalV,
      triangleCount: totalV / 3,
      vertices: pointerAddress(this.textBatchPoolPos.subarray(0, totalV * 3)),
      texcoords: pointerAddress(this.textBatchPoolUv.subarray(0, totalV * 2)),
      texcoords2: ZERO_POINTER,
      normals: pointerAddress(this.textBatchPoolN.subarray(0, totalV * 3)),
      tangents: ZERO_POINTER,
      colors: pointerAddress(this.textBatchPoolC.subarray(0, totalV * 4)),
      indices: ZERO_POINTER,
      animVertices: ZERO_POINTER,
      animNormals: ZERO_POINTER,
      boneIds: ZERO_POINTER,
      boneWeights: ZERO_POINTER,
      boneMatrices: ZERO_POINTER,
      boneCount: 0,
      vaoId: 0,
      vboId: ZERO_POINTER,
    } as unknown as raylibBindings.Mesh);
    raylib.H.UploadMesh(th.pointer, false);
    const uText = th.read();
    const sText = sanitizeUploadedMesh(uText);
    th.write(sText);
    this.uiTextBatchMesh = { mesh: sText };
    raylib.H.DrawMesh(
      this.uiTextBatchMesh.mesh,
      this.uiTextBatchMaterial,
      this.matrixForDraw(this.identityMatrix16),
    );
    return work.length;
  }

  private unloadNativeMesh(nativeMesh: NativeMesh): void {
    if (nativeMesh.model !== undefined) {
      raylib.H.UnloadModel(nativeMesh.model);
      return;
    }
    unloadUploadedMeshGpuOnly(nativeMesh.mesh);
  }
}

function createNativeMaterial(
  asset: MaterialAsset,
  baseMaterial: raylibBindings.Material,
  lightingShader: LightingShader,
): NativeMaterial {
  // MaterialAsset.baseColor from raythree extract is sRGB 0-1 per channel (see colorToTriplet in extract).
  // Raylib map color uses 0-255; multiply here before toRaylibColor.
  const mapsBytes = cloneMaterialMaps(baseMaterial);
  const albedoMap = readMaterialMap(
    mapsBytes,
    raylibBindings.MaterialMapIndex.MATERIAL_MAP_ALBEDO,
  );
  writeMaterialMap(
    mapsBytes,
    raylibBindings.MaterialMapIndex.MATERIAL_MAP_ALBEDO,
    {
      ...albedoMap,
      color: toRaylibColor([
        asset.baseColor[0] * 255,
        asset.baseColor[1] * 255,
        asset.baseColor[2] * 255,
        asset.baseColor[3] * 255,
      ]),
    },
  );

  const usesLighting = asset.kind === "standard";
  const material = {
    shader: usesLighting ? lightingShader.shader : baseMaterial.shader,
    maps: pointerAddress(mapsBytes),
    params: [...baseMaterial.params] as [number, number, number, number],
  } as unknown as raylibBindings.Material;

  return {
    material,
    mapsBytes,
    baseColor: asset.baseColor,
    usesLighting,
    transparent: asset.state.transparent || asset.opacity < 0.999,
    blendMode: toRaylibBlendMode(asset.state.blendMode),
    wireframe: asset.state.wireframe === true,
    depthTest: asset.state.depthTest !== false,
    depthWrite: asset.state.depthWrite !== false,
  };
}

function toRaylibBlendMode(
  blendMode: MaterialAsset["state"]["blendMode"],
): raylibBindings.BlendMode {
  switch (blendMode) {
    case "add":
      return raylibBindings.BlendMode.BLEND_ADDITIVE;
    case "multiply":
      return raylibBindings.BlendMode.BLEND_MULTIPLIED;
    case "alpha":
    case "opaque":
    default:
      return raylibBindings.BlendMode.BLEND_ALPHA;
  }
}

function createLightingShader(): LightingShader {
  const shader = raylib.H.LoadShaderFromMemory(
    LIGHTING_VERTEX_SHADER,
    LIGHTING_FRAGMENT_SHADER,
  );

  return {
    shader,
    lightPositionLoc: raylib.H.GetShaderLocation(shader, "uLightPosition"),
    lightColorLoc: raylib.H.GetShaderLocation(shader, "uLightColor"),
    ambientColorLoc: raylib.H.GetShaderLocation(shader, "uAmbientColor"),
    viewPositionLoc: raylib.H.GetShaderLocation(shader, "uViewPosition"),
    lightIntensityLoc: raylib.H.GetShaderLocation(shader, "uLightIntensity"),
    lightRangeLoc: raylib.H.GetShaderLocation(shader, "uLightRange"),
    baseColorLoc: raylib.H.GetShaderLocation(shader, "uBaseColor"),
  };
}

function createUiPanelShader(): UiPanelShader {
  const shader = raylib.H.LoadShaderFromMemory(
    UI_PANEL_VERTEX_SHADER,
    UI_PANEL_FRAGMENT_SHADER,
  );
  return {
    shader,
    mvpLoc: raylib.H.GetShaderLocation(shader, "mvp"),
    worldLoc: raylib.H.GetShaderLocation(shader, "uWorld"),
    clippingLoc: raylib.H.GetShaderLocation(shader, "uClipping"),
    backgroundColorLoc: raylib.H.GetShaderLocation(shader, "uBackgroundColor"),
    borderColorLoc: raylib.H.GetShaderLocation(shader, "uBorderColor"),
    borderSizeLoc: raylib.H.GetShaderLocation(shader, "uBorderSize"),
    borderRadiusLoc: raylib.H.GetShaderLocation(shader, "uBorderRadius"),
    dimensionsLoc: raylib.H.GetShaderLocation(shader, "uDimensions"),
    depthOffsetLoc: raylib.H.GetShaderLocation(shader, "uDepthOffset"),
  };
}

function createUiTextShader(): UiTextShader {
  const shader = raylib.H.LoadShaderFromMemory(
    UI_TEXT_VERTEX_SHADER,
    UI_TEXT_FRAGMENT_SHADER,
  );
  return {
    shader,
    mvpLoc: raylib.H.GetShaderLocation(shader, "mvp"),
    tintLoc: raylib.H.GetShaderLocation(shader, "uTint"),
    pxRangeLoc: raylib.H.GetShaderLocation(shader, "uPxRange"),
    atlasSizeLoc: raylib.H.GetShaderLocation(shader, "uAtlasSize"),
  };
}

function createUiTextBatchShader(): UiTextBatchShader {
  const shader = raylib.H.LoadShaderFromMemory(
    UI_TEXT_BATCH_VERTEX_SHADER,
    UI_TEXT_BATCH_FRAGMENT_SHADER,
  );
  return { shader };
}

function createUiPanelBatchShader(): UiPanelBatchShader {
  const shader = raylib.H.LoadShaderFromMemory(
    UI_PANEL_BATCH_VERTEX_SHADER,
    UI_PANEL_BATCH_FRAGMENT_SHADER,
  );
  return {
    shader,
    mvpLoc: raylib.H.GetShaderLocation(shader, "mvp"),
    texture0Loc: raylib.H.GetShaderLocation(shader, "texture0"),
  };
}

function applyLighting(shader: LightingShader, frame: RenderFrame): void {
  let ar = 0.1;
  let ag = 0.1;
  let ab = 0.12;
  let point: (typeof frame.lights)[number] | undefined;
  for (const light of frame.lights) {
    if (light.type === "ambient") {
      ar += light.color[0] * light.intensity;
      ag += light.color[1] * light.intensity;
      ab += light.color[2] * light.intensity;
    } else if (
      point === undefined && light.type === "point" && light.position !== undefined
    ) {
      point = light;
    }
  }
  const ambientColor: [number, number, number] = [ar, ag, ab];

  const lightPosition = point?.position ?? [0, 6, 0];
  const lightColor = point?.color ?? [1, 1, 1];
  const lightIntensity = point?.intensity ?? 0;
  const lightRange = point?.distance ?? 0;

  setShaderVec3(shader.shader, shader.lightPositionLoc, lightPosition);
  setShaderVec3(shader.shader, shader.lightColorLoc, lightColor);
  setShaderVec3(shader.shader, shader.ambientColorLoc, ambientColor);
  setShaderVec3(shader.shader, shader.viewPositionLoc, frame.camera.position);
  setShaderFloat(shader.shader, shader.lightIntensityLoc, lightIntensity);
  setShaderFloat(shader.shader, shader.lightRangeLoc, lightRange);
}

function writeMaterialMap(
  bytes: Uint8Array,
  index: number,
  value: raylibBindings.MaterialMap,
): void {
  const offset = index * raylibBindings.MaterialMap.byteSize;
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset + offset,
    raylibBindings.MaterialMap.byteSize,
  );
  raylibBindings.MaterialMap.writeBytes(value, view);
}

function readMaterialMap(
  bytes: Uint8Array,
  index: number,
): raylibBindings.MaterialMap {
  const offset = index * raylibBindings.MaterialMap.byteSize;
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset + offset,
    raylibBindings.MaterialMap.byteSize,
  );
  return raylibBindings.MaterialMap.readBytes(view);
}

function cloneMaterialMaps(
  baseMaterial: raylibBindings.Material,
): Uint8Array {
  const bytes = new Uint8Array(
    raylibBindings.MaterialMap.byteSize * MAX_MATERIAL_MAPS,
  );
  const mapsPointer = pointerFromAddress(baseMaterial.maps);
  if (mapsPointer === null) {
    return bytes;
  }

  new Deno.UnsafePointerView(mapsPointer).copyInto(bytes);
  return bytes;
}

function createUiQuadGeometryAsset(): GeometryAsset {
  return {
    id: -1,
    topology: "triangles",
    revision: 1,
    debugLabel: "raylib-ui-quad",
    attributes: {
      position: {
        itemSize: 3,
        count: 6,
        normalized: false,
        componentType: "Float32Array",
        array: new Float32Array([
          -0.5,
          -0.5,
          0,
          0.5,
          -0.5,
          0,
          0.5,
          0.5,
          0,
          -0.5,
          -0.5,
          0,
          0.5,
          0.5,
          0,
          -0.5,
          0.5,
          0,
        ]),
      },
      uv: {
        itemSize: 2,
        count: 6,
        normalized: false,
        componentType: "Float32Array",
        array: new Float32Array([
          0,
          1,
          1,
          1,
          1,
          0,
          0,
          1,
          1,
          0,
          0,
          0,
        ]),
      },
      normal: {
        itemSize: 3,
        count: 6,
        normalized: false,
        componentType: "Float32Array",
        array: new Float32Array([
          0,
          0,
          1,
          0,
          0,
          1,
          0,
          0,
          1,
          0,
          0,
          1,
          0,
          0,
          1,
          0,
          0,
          1,
        ]),
      },
    },
  };
}

function readUiColor(
  data: Float32Array,
  offset: number,
): [number, number, number, number] {
  return [
    Math.round((data[offset] ?? 0) * 255),
    Math.round((data[offset + 1] ?? 0) * 255),
    Math.round((data[offset + 2] ?? 0) * 255),
    Math.round((data[offset + 3] ?? 0) * 255),
  ];
}

function unpackUiBorderRadius(
  packedRadius: number,
): [number, number, number, number] {
  return [
    Math.floor(packedRadius / 125000) % 50,
    Math.floor(packedRadius / 2500) % 50,
    Math.floor(packedRadius / 50) % 50,
    Math.floor(packedRadius) % 50,
  ].map((value) => value * 0.01) as [number, number, number, number];
}

function toShaderColor(
  color: [number, number, number, number],
): [number, number, number, number] {
  return [
    color[0] / 255,
    color[1] / 255,
    color[2] / 255,
    color[3] / 255,
  ];
}

function compareUiOrderInfo(
  left: WebXRRaythreeUiOrderInfo | undefined,
  right: WebXRRaythreeUiOrderInfo | undefined,
): number {
  if (left == null || right == null) {
    return 0;
  }
  return (left.majorIndex - right.majorIndex) ||
    (left.minorIndex - right.minorIndex) ||
    (left.elementType - right.elementType) ||
    (left.patchIndex - right.patchIndex);
}

function computeUiDepthOffset(
  orderInfo: WebXRRaythreeUiOrderInfo | undefined,
  instanceIndex: number,
): number {
  const groupOffset = orderInfo == null ? 0 : orderInfo.majorIndex * 0.000001 +
    orderInfo.minorIndex * 0.00000001 +
    orderInfo.elementType * 0.000000001 +
    orderInfo.patchIndex * 0.00000000001;
  return groupOffset + instanceIndex * 0.0000001;
}

const _uikitQuadGeo = createUiQuadGeometryAsset();
const UI_QUAD6_POS = new Float32Array(
  _uikitQuadGeo.attributes.position!.array as ArrayLike<number>,
);
const UI_QUAD6_UV = new Float32Array(
  _uikitQuadGeo.attributes.uv!.array as ArrayLike<number>,
);

/**
 * 9×RGBAf texels (36 floats) per row; row index = instanced id in
 * [UI_PANEL_BATCH_FRAGMENT_SHADER](webxrRaythreeRaylibRenderer.ts).
 */
function packUikitPanelRow(
  destFloats: Float32Array,
  row: number,
  panel: WebXRRaythreeUiPanelSnapshot,
): void {
  const base = row * 36;
  const d = panel.data;
  const c = panel.clipping;
  for (let i = 0; i < 4; i++) {
    destFloats[base + i] = d[i] ?? 0;
  }
  const bg = toShaderColor(readUiColor(d, 4));
  destFloats[base + 4] = bg[0]!;
  destFloats[base + 5] = bg[1]!;
  destFloats[base + 6] = bg[2]!;
  destFloats[base + 7] = bg[3]!;
  const br = toShaderColor(readUiColor(d, 9));
  destFloats[base + 8] = br[0]!;
  destFloats[base + 9] = br[1]!;
  destFloats[base + 10] = br[2]!;
  destFloats[base + 11] = br[3]!;
  const rad = unpackUiBorderRadius(d[8] ?? 0);
  destFloats[base + 12] = rad[0]!;
  destFloats[base + 13] = rad[1]!;
  destFloats[base + 14] = rad[2]!;
  destFloats[base + 15] = rad[3]!;
  const w = Math.max(0, Number(d[14] ?? 0));
  const h = Math.max(0, Number(d[15] ?? 0));
  const dep = computeUiDepthOffset(panel.orderInfo, panel.instanceIndex);
  destFloats[base + 16] = w;
  destFloats[base + 17] = h;
  destFloats[base + 18] = dep;
  destFloats[base + 19] = 0;
  for (let i = 0; i < 16; i++) {
    destFloats[base + 20 + i] = c[i] ?? 0;
  }
}

function setShaderVec2(
  shader: raylibBindings.Shader,
  location: number,
  x: number,
  y: number,
): void {
  const values = new Float32Array([x, y]);
  const pointer = Deno.UnsafePointer.of(values);
  if (pointer === null) {
    return;
  }
  raylib.H.SetShaderValue(
    shader,
    location,
    pointer,
    raylibBindings.ShaderUniformDataType.SHADER_UNIFORM_VEC2,
  );
}

function toFloat32ArrayLoose(value: unknown): Float32Array {
  if (value instanceof Float32Array) return value;
  if (Array.isArray(value)) return Float32Array.from(value as ArrayLike<number>);
  if (value != null && typeof value === "object") {
    const maybeLength = (value as { length?: number }).length;
    if (typeof maybeLength === "number") {
      return Float32Array.from(value as ArrayLike<number>);
    }
    // JSON-serialized typed array: {"0": x, "1": y, ...} — sort numeric keys.
    const keys = Object.keys(value as Record<string, number>)
      .filter((key) => /^\d+$/.test(key))
      .sort((a, b) => Number(a) - Number(b));
    const out = new Float32Array(keys.length);
    for (let i = 0; i < keys.length; i++) {
      out[i] = Number((value as Record<string, number>)[keys[i]]);
    }
    return out;
  }
  return new Float32Array(0);
}

function toUint16ArrayLoose(value: unknown): Uint16Array {
  if (value instanceof Uint16Array) return value.slice();
  if (value instanceof Uint32Array) return new Uint16Array(value);
  if (Array.isArray(value)) return Uint16Array.from(value as ArrayLike<number>);
  if (value != null && typeof value === "object") {
    const maybeLength = (value as { length?: number }).length;
    if (typeof maybeLength === "number") {
      return Uint16Array.from(value as ArrayLike<number>);
    }
    const keys = Object.keys(value as Record<string, number>)
      .filter((key) => /^\d+$/.test(key))
      .sort((a, b) => Number(a) - Number(b));
    const out = new Uint16Array(keys.length);
    for (let i = 0; i < keys.length; i++) {
      out[i] = Number((value as Record<string, number>)[keys[i]]);
    }
    return out;
  }
  return new Uint16Array(0);
}

type MsdfCpuGeometry = {
  positions3D: Float32Array;
  uvs: Float32Array;
  normals: Float32Array;
  colors: Uint8Array;
  indices: Uint16Array | null;
  vertexCount: number;
  triangleCount: number;
  expanded: boolean;
};

/**
 * CPU-side MSDF triangulation (same as {@link createNativeMeshFromMsdfBuffers} before GPU upload);
 * used to merge many labels into a single `DrawMesh`.
 */
function buildMsdfGeometryCpu(
  positionsRaw: unknown,
  uvsRaw: unknown,
  indicesRaw: unknown,
  label?: string,
): MsdfCpuGeometry | null {
  const positions2D = toFloat32ArrayLoose(positionsRaw);
  const uvs = toFloat32ArrayLoose(uvsRaw);
  const vertexCount = positions2D.length / 2;
  if (vertexCount <= 0) return null;
  const positions3D = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) {
    positions3D[i * 3] = positions2D[i * 2]!;
    positions3D[i * 3 + 1] = positions2D[i * 2 + 1]!;
    positions3D[i * 3 + 2] = 0;
  }
  const normals = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) {
    normals[i * 3 + 2] = 1;
  }
  const indicesAny = toIndexArrayLoose(indicesRaw);
  const topology = analyzeMsdfIndexTopology(indicesAny, vertexCount);
  const useExpandedTriangles = WEBXR_RAYTHREE_TEXT_FORCE_NON_INDEXED || topology.maxIndex > 65535;
  if (WEBXR_RAYTHREE_TEXT_ASSERT) {
    assertMsdfTopologyInvariants(topology, label ?? "<text>");
  }
  if (useExpandedTriangles) {
    debugLog(
      `msdf index expansion text="${label ?? "<text>"}" maxIndex=${topology.maxIndex} ` +
        `indices=${indicesAny.length} vertices=${vertexCount}`,
    );
    const expanded = expandIndexedMsdfTriangles(positions3D, uvs, indicesAny);
    const expandedNormals = new Float32Array(expanded.vertexCount * 3);
    for (let i = 0; i < expanded.vertexCount; i++) {
      expandedNormals[i * 3 + 2] = 1;
    }
    const expandedColors = buildOpaqueWhiteColors(expanded.vertexCount);
    return {
      positions3D: expanded.positions3D,
      uvs: expanded.uvs,
      normals: expandedNormals,
      colors: expandedColors,
      indices: null,
      vertexCount: expanded.vertexCount,
      triangleCount: expanded.vertexCount / 3,
      expanded: true,
    };
  }

  const colors = buildOpaqueWhiteColors(vertexCount);
  const indices = toUint16ArrayLoose(indicesAny);
  if (WEBXR_RAYTHREE_TEXT_ASSERT) {
    assertMsdfConversionInvariants(positions2D, positions3D, uvs, indices, label ?? "<text>");
  }
  return {
    positions3D,
    uvs: uvs.slice(),
    normals,
    colors,
    indices,
    vertexCount,
    triangleCount: indices.length / 3,
    expanded: false,
  };
}

function createNativeMeshFromMsdfBuffers(
  positionsRaw: unknown,
  uvsRaw: unknown,
  indicesRaw: unknown,
  label?: string,
): NativeMesh | null {
  const built = buildMsdfGeometryCpu(positionsRaw, uvsRaw, indicesRaw, label);
  if (built == null) {
    return null;
  }
  if (built.expanded) {
    const meshHandle = raylibBindings.Mesh.createPointer({
      vertexCount: built.vertexCount,
      triangleCount: built.triangleCount,
      vertices: pointerAddress(built.positions3D),
      texcoords: pointerAddress(built.uvs),
      texcoords2: ZERO_POINTER,
      normals: pointerAddress(built.normals),
      tangents: ZERO_POINTER,
      colors: pointerAddress(built.colors),
      indices: ZERO_POINTER,
      animVertices: ZERO_POINTER,
      animNormals: ZERO_POINTER,
      boneIds: ZERO_POINTER,
      boneWeights: ZERO_POINTER,
      boneMatrices: ZERO_POINTER,
      boneCount: 0,
      vaoId: 0,
      vboId: ZERO_POINTER,
    } as unknown as raylibBindings.Mesh);

    raylib.H.UploadMesh(meshHandle.pointer, false);
    const uploaded = meshHandle.read();
    const sanitized = sanitizeUploadedMesh(uploaded);
    meshHandle.write(sanitized);
    return { mesh: sanitized };
  }

  const meshHandle = raylibBindings.Mesh.createPointer({
    vertexCount: built.vertexCount,
    triangleCount: built.triangleCount,
    vertices: pointerAddress(built.positions3D),
    texcoords: pointerAddress(built.uvs),
    texcoords2: ZERO_POINTER,
    normals: pointerAddress(built.normals),
    tangents: ZERO_POINTER,
    colors: pointerAddress(built.colors),
    indices: pointerAddress(built.indices!),
    animVertices: ZERO_POINTER,
    animNormals: ZERO_POINTER,
    boneIds: ZERO_POINTER,
    boneWeights: ZERO_POINTER,
    boneMatrices: ZERO_POINTER,
    boneCount: 0,
    vaoId: 0,
    vboId: ZERO_POINTER,
  } as unknown as raylibBindings.Mesh);

  raylib.H.UploadMesh(meshHandle.pointer, false);
  const uploaded = meshHandle.read();
  const sanitized = sanitizeUploadedMesh(uploaded);
  meshHandle.write(sanitized);
  return { mesh: sanitized };
}

function toIndexArrayLoose(value: unknown): Uint16Array | Uint32Array {
  if (value instanceof Uint16Array) return value.slice();
  if (value instanceof Uint32Array) return value.slice();
  if (Array.isArray(value)) {
    const max = value.reduce((acc, entry) => Math.max(acc, Number(entry) || 0), 0);
    return max > 65535
      ? Uint32Array.from(value as ArrayLike<number>)
      : Uint16Array.from(value as ArrayLike<number>);
  }
  if (value != null && typeof value === "object") {
    const maybeLength = (value as { length?: number }).length;
    if (typeof maybeLength === "number") {
      const materialized = Array.from(value as ArrayLike<number>);
      const max = materialized.reduce((acc, entry) => Math.max(acc, Number(entry) || 0), 0);
      return max > 65535 ? Uint32Array.from(materialized) : Uint16Array.from(materialized);
    }
    const keys = Object.keys(value as Record<string, number>)
      .filter((key) => /^\d+$/.test(key))
      .sort((a, b) => Number(a) - Number(b));
    const max = keys.reduce(
      (acc, key) => Math.max(acc, Number((value as Record<string, number>)[key]) || 0),
      0,
    );
    if (max > 65535) {
      const out = new Uint32Array(keys.length);
      for (let i = 0; i < keys.length; i++) {
        out[i] = Number((value as Record<string, number>)[keys[i]]);
      }
      return out;
    }
    const out = new Uint16Array(keys.length);
    for (let i = 0; i < keys.length; i++) {
      out[i] = Number((value as Record<string, number>)[keys[i]]);
    }
    return out;
  }
  return new Uint16Array(0);
}

function analyzeMsdfIndexTopology(
  indices: Uint16Array | Uint32Array,
  vertexCount: number,
): { maxIndex: number; minIndex: number; indexCount: number; vertexCount: number } {
  let maxIndex = 0;
  let minIndex = Number.POSITIVE_INFINITY;
  for (let i = 0; i < indices.length; i++) {
    const idx = Number(indices[i] ?? 0);
    if (idx > maxIndex) maxIndex = idx;
    if (idx < minIndex) minIndex = idx;
  }
  if (!Number.isFinite(minIndex)) minIndex = 0;
  return { maxIndex, minIndex, indexCount: indices.length, vertexCount };
}

function assertMsdfTopologyInvariants(
  topology: { maxIndex: number; minIndex: number; indexCount: number; vertexCount: number },
  label: string,
): void {
  if (topology.indexCount === 0) {
    throw new Error(`[msdf-assert] ${label}: topology has empty index buffer`);
  }
  if (topology.indexCount % 3 !== 0) {
    throw new Error(
      `[msdf-assert] ${label}: topology index count not multiple of 3: ${topology.indexCount}`,
    );
  }
  if (topology.minIndex < 0 || topology.maxIndex >= topology.vertexCount) {
    throw new Error(
      `[msdf-assert] ${label}: topology index range invalid min=${topology.minIndex} max=${topology.maxIndex} vertices=${topology.vertexCount}`,
    );
  }
}

function expandIndexedMsdfTriangles(
  positions3D: Float32Array,
  uvs: Float32Array,
  indices: Uint16Array | Uint32Array,
): { positions3D: Float32Array; uvs: Float32Array; vertexCount: number } {
  const vertexCount = indices.length;
  const expandedPositions = new Float32Array(vertexCount * 3);
  const expandedUvs = new Float32Array(vertexCount * 2);
  for (let i = 0; i < indices.length; i++) {
    const srcIndex = Number(indices[i] ?? 0);
    expandedPositions[i * 3] = positions3D[srcIndex * 3] ?? 0;
    expandedPositions[i * 3 + 1] = positions3D[srcIndex * 3 + 1] ?? 0;
    expandedPositions[i * 3 + 2] = positions3D[srcIndex * 3 + 2] ?? 0;
    expandedUvs[i * 2] = uvs[srcIndex * 2] ?? 0;
    expandedUvs[i * 2 + 1] = uvs[srcIndex * 2 + 1] ?? 0;
  }
  return { positions3D: expandedPositions, uvs: expandedUvs, vertexCount };
}

function createUiTextGeometryKey(
  text: string,
  geometry: WebXRRaythreeUiSnapshot["texts"][number]["geometry"],
): string {
  if (geometry == null) {
    return text;
  }
  return `${text}\u241f${geometry.positions.length}\u241f${geometry.uvs.length}\u241f${geometry.indices.length}\u241f${geometry.version}\u241f${
    quickFloat32Hash(geometry.positions)
  }\u241f${quickFloat32Hash(geometry.uvs)}\u241f${quickIndexHash(geometry.indices)}`;
}

function quickFloat32Hash(values: Float32Array): string {
  let hash = 2166136261 >>> 0;
  const stride = Math.max(1, Math.floor(values.length / 64));
  for (let i = 0; i < values.length; i += stride) {
    const bits = new Uint32Array(new Float32Array([values[i]]).buffer)[0] ?? 0;
    hash ^= bits;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  hash ^= values.length;
  return hash.toString(16);
}

function quickIndexHash(values: Uint16Array | Uint32Array): string {
  let hash = 2166136261 >>> 0;
  const stride = Math.max(1, Math.floor(values.length / 64));
  for (let i = 0; i < values.length; i += stride) {
    hash ^= Number(values[i] ?? 0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  hash ^= values.length;
  return hash.toString(16);
}

function maybeValidateMsdfGeometry(
  label: string,
  geometry: NonNullable<WebXRRaythreeUiSnapshot["texts"][number]["geometry"]>,
  logged: Set<string>,
): void {
  if (!WEBXR_RAYTHREE_TEXT_ASSERT) {
    return;
  }
  const key = createUiTextGeometryKey(label, geometry);
  if (logged.has(key)) {
    return;
  }
  logged.add(key);
  const positions = geometry.positions;
  const uvs = geometry.uvs;
  const indices = geometry.indices;
  const vertexCount = Math.floor(positions.length / 2);
  if (positions.length % 2 !== 0) {
    throw new Error(
      `[msdf-assert] ${label}: positions length must be even, got ${positions.length}`,
    );
  }
  if (uvs.length !== vertexCount * 2) {
    throw new Error(
      `[msdf-assert] ${label}: uv length mismatch expected=${vertexCount * 2} got=${uvs.length}`,
    );
  }
  if (indices.length % 3 !== 0) {
    throw new Error(
      `[msdf-assert] ${label}: index length must be multiple of 3, got ${indices.length}`,
    );
  }
  let maxIndex = 0;
  for (let i = 0; i < indices.length; i++) {
    const idx = Number(indices[i] ?? 0);
    if (idx > maxIndex) maxIndex = idx;
  }
  if (maxIndex >= vertexCount) {
    throw new Error(
      `[msdf-assert] ${label}: index out of bounds max=${maxIndex} vertexCount=${vertexCount}`,
    );
  }
  for (let i = 0; i < uvs.length; i += 2) {
    const u = uvs[i] ?? 0;
    const v = uvs[i + 1] ?? 0;
    if (u < -0.001 || u > 1.001 || v < -0.001 || v > 1.001) {
      throw new Error(`[msdf-assert] ${label}: uv out of range at i=${i / 2} uv=(${u},${v})`);
    }
  }
  debugLog(
    `msdf-assert ok text="${label}" vertices=${vertexCount} triangles=${indices.length / 3} ` +
      `uvHash=${quickFloat32Hash(uvs)} posHash=${quickFloat32Hash(positions)}`,
  );
}

function assertMsdfConversionInvariants(
  positions2D: Float32Array,
  positions3D: Float32Array,
  uvs: Float32Array,
  indices: Uint16Array,
  label: string,
): void {
  const vertexCount = Math.floor(positions2D.length / 2);
  if (positions3D.length !== vertexCount * 3) {
    throw new Error(
      `[msdf-assert] ${label}: converted position length mismatch expected=${
        vertexCount * 3
      } got=${positions3D.length}`,
    );
  }
  if (uvs.length !== vertexCount * 2) {
    throw new Error(
      `[msdf-assert] ${label}: converted uv length mismatch expected=${
        vertexCount * 2
      } got=${uvs.length}`,
    );
  }
  if (indices.length === 0) {
    throw new Error(`[msdf-assert] ${label}: converted index buffer is empty`);
  }
  for (let i = 0; i < vertexCount; i++) {
    const px = positions2D[i * 2] ?? 0;
    const py = positions2D[i * 2 + 1] ?? 0;
    const rx = positions3D[i * 3] ?? 0;
    const ry = positions3D[i * 3 + 1] ?? 0;
    const rz = positions3D[i * 3 + 2] ?? 0;
    if (Math.abs(px - rx) > 1e-6 || Math.abs(py - ry) > 1e-6 || Math.abs(rz) > 1e-6) {
      throw new Error(
        `[msdf-assert] ${label}: position conversion mismatch i=${i} src=(${px},${py}) dst=(${rx},${ry},${rz})`,
      );
    }
  }
}

function createNativeMesh(asset: GeometryAsset): NativeMesh | null {
  const prepared = prepareGeometryBuffers(asset);
  if (!prepared) {
    return null;
  }
  const meshHandle = raylibBindings.Mesh.createPointer({
    vertexCount: prepared.vertexCount,
    triangleCount: prepared.triangleCount,
    vertices: pointerAddress(prepared.vertices),
    texcoords: pointerAddress(prepared.texcoords),
    texcoords2: ZERO_POINTER,
    normals: pointerAddress(prepared.normals),
    tangents: ZERO_POINTER,
    colors: pointerAddress(prepared.colors),
    indices: prepared.indices === null ? ZERO_POINTER : pointerAddress(prepared.indices),
    animVertices: ZERO_POINTER,
    animNormals: ZERO_POINTER,
    boneIds: ZERO_POINTER,
    boneWeights: ZERO_POINTER,
    boneMatrices: ZERO_POINTER,
    boneCount: 0,
    vaoId: 0,
    vboId: ZERO_POINTER,
  } as unknown as raylibBindings.Mesh);

  raylib.H.UploadMesh(meshHandle.pointer, false);
  const uploaded = meshHandle.read();
  const sanitized = sanitizeUploadedMesh(uploaded);
  meshHandle.write(sanitized);
  return { mesh: sanitized };
}

function sanitizeUploadedMesh(mesh: raylibBindings.Mesh): raylibBindings.Mesh {
  const hasIndices = (mesh.indices as unknown as bigint) !== ZERO_POINTER;
  return {
    ...mesh,
    vertices: ZERO_POINTER,
    texcoords: ZERO_POINTER,
    texcoords2: ZERO_POINTER,
    normals: ZERO_POINTER,
    tangents: ZERO_POINTER,
    colors: ZERO_POINTER,
    // DrawMesh() uses mesh.indices != NULL to choose indexed rendering path.
    indices: hasIndices ? 1n : ZERO_POINTER,
    animVertices: ZERO_POINTER,
    animNormals: ZERO_POINTER,
    boneIds: ZERO_POINTER,
    boneWeights: ZERO_POINTER,
    boneMatrices: ZERO_POINTER,
  } as unknown as raylibBindings.Mesh;
}

const RL_MESH_VBO_COUNT = 7;

function unloadUploadedMeshGpuOnly(mesh: raylibBindings.Mesh): void {
  const symbols = getUiRlglSymbols();
  if (mesh.vaoId > 0) {
    symbols.rlUnloadVertexArray(mesh.vaoId);
  }
  const vboPointer = pointerFromAddress(mesh.vboId);
  if (vboPointer !== null) {
    const raw = new Deno.UnsafePointerView(vboPointer).getArrayBuffer(RL_MESH_VBO_COUNT * 4);
    const view = new DataView(raw);
    for (let i = 0; i < RL_MESH_VBO_COUNT; i++) {
      const id = view.getUint32(i * 4, true);
      if (id > 0) {
        symbols.rlUnloadVertexBuffer(id);
      }
    }
    raylib.H.MemFree(vboPointer);
  }
}

type PreparedGeometryBuffers = {
  vertexCount: number;
  triangleCount: number;
  vertices: Float32Array;
  texcoords: Float32Array;
  normals: Float32Array;
  colors: Uint8Array;
  indices: Uint16Array | null;
};

function prepareGeometryBuffers(asset: GeometryAsset): PreparedGeometryBuffers | null {
  const position = asset.attributes.position;
  if (
    position === undefined ||
    position.itemSize !== 3 ||
    position.count <= 0
  ) {
    return null;
  }

  const texcoord = asset.attributes.uv;
  const normal = asset.attributes.normal;
  const color = asset.attributes.color;

  if (asset.index !== undefined) {
    return expandIndexedGeometry(asset, position, texcoord, normal, color);
  }

  const vertexCount = position.count;
  if (vertexCount % 3 !== 0) {
    return null;
  }
  const vertices = toFloat32Array(position.array);
  const texcoords = texcoord === undefined
    ? new Float32Array(vertexCount * 2)
    : toFloat32Array(texcoord.array);
  const normals = normal === undefined
    ? new Float32Array(vertexCount * 3)
    : toFloat32Array(normal.array);
  const colors = color === undefined
    ? buildOpaqueWhiteColors(vertexCount)
    : toColorBytes(color.array);

  return {
    vertexCount,
    triangleCount: vertexCount / 3,
    vertices,
    texcoords,
    normals,
    colors,
    indices: null,
  };
}

function describeGeometryAttributes(asset: GeometryAsset): string {
  const parts = Object.entries(asset.attributes).map(([name, attribute]) =>
    `${name}[itemSize=${attribute.itemSize},count=${attribute.count},type=${attribute.componentType}]`
  );
  return parts.join(", ");
}

function expandIndexedGeometry(
  asset: GeometryAsset,
  position: GeometryAttributeAsset,
  texcoord: GeometryAttributeAsset | undefined,
  normal: GeometryAttributeAsset | undefined,
  color: GeometryAttributeAsset | undefined,
): PreparedGeometryBuffers {
  const index = asset.index;
  if (index === undefined) {
    throw new Error(`Geometry ${asset.id} requested indexed expansion without an index buffer.`);
  }

  const expandedVertexCount = index.count;
  const positions = new Float32Array(expandedVertexCount * 3);
  const texcoords = new Float32Array(expandedVertexCount * 2);
  const normals = new Float32Array(expandedVertexCount * 3);
  const colors = new Uint8Array(expandedVertexCount * 4);

  for (let expanded = 0; expanded < index.count; expanded++) {
    const source = index.array[expanded];
    positions.set(readTuple(position.array, source, 3), expanded * 3);
    if (texcoord !== undefined) {
      texcoords.set(readTuple(texcoord.array, source, 2), expanded * 2);
    }
    if (normal !== undefined) {
      normals.set(readTuple(normal.array, source, 3), expanded * 3);
    }
    if (color !== undefined) {
      colors.set(toColorTuple(color.array, source), expanded * 4);
    } else {
      colors.set([255, 255, 255, 255], expanded * 4);
    }
  }

  return {
    vertexCount: expandedVertexCount,
    triangleCount: expandedVertexCount / 3,
    vertices: positions,
    texcoords,
    normals,
    colors,
    indices: null,
  };
}

function readTuple(array: ArrayLike<number>, index: number, itemSize: number): number[] {
  const start = index * itemSize;
  return Array.from({ length: itemSize }, (_, offset) => Number(array[start + offset] ?? 0));
}

function toFloat32Array(array: ArrayLike<number>): Float32Array {
  return array instanceof Float32Array ? array.slice() : Float32Array.from(array);
}

function toColorBytes(array: ArrayLike<number>): Uint8Array {
  if (array instanceof Uint8Array) {
    return array.slice();
  }
  const bytes = new Uint8Array(array.length);
  for (let index = 0; index < array.length; index++) {
    const value = Number(array[index] ?? 1);
    bytes[index] = value <= 1 ? Math.round(value * 255) : Math.round(value);
  }
  return bytes;
}

function toColorTuple(array: ArrayLike<number>, index: number): [number, number, number, number] {
  const offset = index * 4;
  const rgba = [array[offset], array[offset + 1], array[offset + 2], array[offset + 3]];
  return rgba.map((value, channelIndex) => {
    const fallback = channelIndex === 3 ? 1 : 0;
    const numeric = Number(value ?? fallback);
    return numeric <= 1 ? Math.round(numeric * 255) : Math.round(numeric);
  }) as [number, number, number, number];
}

function buildOpaqueWhiteColors(vertexCount: number): Uint8Array {
  const colors = new Uint8Array(vertexCount * 4);
  for (let index = 0; index < vertexCount; index++) {
    colors.set([255, 255, 255, 255], index * 4);
  }
  return colors;
}

function isInstancedInstance(
  instance: RenderInstance | InstancedRenderInstance,
): instance is InstancedRenderInstance {
  return instance.kind === "instancedMesh";
}

function voidPointerToBigint(p: raylibBindings.VoidPointer): bigint {
  if (typeof p === "bigint") {
    return p;
  }
  return Deno.UnsafePointer.value(p as Deno.PointerValue<unknown>);
}

function pointerAddress(value: unknown): bigint {
  const pointer = Deno.UnsafePointer.of(value as BufferSource);
  if (pointer === null) {
    return ZERO_POINTER;
  }
  return Deno.UnsafePointer.value(pointer);
}

function pointerFromAddress(address: unknown): Deno.PointerValue<unknown> {
  if (typeof address !== "bigint" || address === ZERO_POINTER) {
    return null;
  }
  return Deno.UnsafePointer.create(address);
}

function toRaylibColor(
  rgba: [number, number, number, number],
): raylibBindings.Color {
  return {
    r: Math.max(0, Math.min(255, Math.round(rgba[0]))),
    g: Math.max(0, Math.min(255, Math.round(rgba[1]))),
    b: Math.max(0, Math.min(255, Math.round(rgba[2]))),
    a: Math.max(0, Math.min(255, Math.round(rgba[3]))),
  };
}

function setShaderVec3(
  shader: raylibBindings.Shader,
  location: number,
  value: [number, number, number],
): void {
  if (location < 0) {
    return;
  }
  const vec = new Float32Array(value);
  raylib.H.SetShaderValue(
    shader,
    location,
    Deno.UnsafePointer.of(vec),
    raylibBindings.ShaderUniformDataType.SHADER_UNIFORM_VEC3,
  );
}

function setShaderFloat(
  shader: raylibBindings.Shader,
  location: number,
  value: number,
): void {
  if (location < 0) {
    return;
  }
  const scalar = new Float32Array([value]);
  raylib.H.SetShaderValue(
    shader,
    location,
    Deno.UnsafePointer.of(scalar),
    raylibBindings.ShaderUniformDataType.SHADER_UNIFORM_FLOAT,
  );
}

function setShaderVec4(
  shader: raylibBindings.Shader,
  location: number,
  value: [number, number, number, number],
): void {
  if (location < 0) {
    return;
  }
  const vec = new Float32Array(value);
  raylib.H.SetShaderValue(
    shader,
    location,
    Deno.UnsafePointer.of(vec),
    raylibBindings.ShaderUniformDataType.SHADER_UNIFORM_VEC4,
  );
}

function debugLog(message: string): void {
  if (!WEBXR_RAYTHREE_DEBUG) {
    return;
  }
  LogChannel.log("webxrraythree", `[webxr-raythree] ${message}`);
}

type UiRlglSymbols = {
  rlUnloadVertexArray: {
    parameters: ["u32"];
    result: "void";
  };
  rlUnloadVertexBuffer: {
    parameters: ["u32"];
    result: "void";
  };
  rlDisableDepthTest: {
    parameters: [];
    result: "void";
  };
  rlEnableDepthTest: {
    parameters: [];
    result: "void";
  };
  rlDisableDepthMask: {
    parameters: [];
    result: "void";
  };
  rlEnableDepthMask: {
    parameters: [];
    result: "void";
  };
  rlDisableBackfaceCulling: {
    parameters: [];
    result: "void";
  };
  rlEnableBackfaceCulling: {
    parameters: [];
    result: "void";
  };
  /** Sets `glPolygonMode` to `GL_LINE` (desktop GL only; no-op on GLES). */
  rlEnableWireMode: {
    parameters: [];
    result: "void";
  };
  rlDisableWireMode: {
    parameters: [];
    result: "void";
  };
};

let uiRlglLibrary: Deno.DynamicLibrary<UiRlglSymbols> | undefined;

function getUiRlglSymbols(): Deno.DynamicLibrary<UiRlglSymbols>["symbols"] {
  uiRlglLibrary ??= Deno.dlopen(
    raylibBindings.getDefaultRaylibLibraryName(),
    {
      rlUnloadVertexArray: {
        parameters: ["u32"],
        result: "void",
      },
      rlUnloadVertexBuffer: {
        parameters: ["u32"],
        result: "void",
      },
      rlDisableDepthTest: {
        parameters: [],
        result: "void",
      },
      rlEnableDepthTest: {
        parameters: [],
        result: "void",
      },
      rlDisableDepthMask: {
        parameters: [],
        result: "void",
      },
      rlEnableDepthMask: {
        parameters: [],
        result: "void",
      },
      rlDisableBackfaceCulling: {
        parameters: [],
        result: "void",
      },
      rlEnableBackfaceCulling: {
        parameters: [],
        result: "void",
      },
      rlEnableWireMode: {
        parameters: [],
        result: "void",
      },
      rlDisableWireMode: {
        parameters: [],
        result: "void",
      },
    } satisfies UiRlglSymbols,
  );
  return uiRlglLibrary.symbols;
}

function setUiDepthMaskEnabled(enabled: boolean): void {
  const symbols = getUiRlglSymbols();
  if (enabled) {
    symbols.rlEnableDepthMask();
    return;
  }
  symbols.rlDisableDepthMask();
}

function setUiDepthTestEnabled(enabled: boolean): void {
  const symbols = getUiRlglSymbols();
  if (enabled) {
    symbols.rlEnableDepthTest();
    return;
  }
  symbols.rlDisableDepthTest();
}

function setUiBackfaceCullingEnabled(enabled: boolean): void {
  const symbols = getUiRlglSymbols();
  if (enabled) {
    symbols.rlEnableBackfaceCulling();
    return;
  }
  symbols.rlDisableBackfaceCulling();
}

/** Toggles `rlEnableWireMode` / `rlDisableWireMode` (desktop GL; no-op on GLES). */
function setWireModeEnabled(enabled: boolean): void {
  const symbols = getUiRlglSymbols();
  if (enabled) {
    symbols.rlEnableWireMode();
    return;
  }
  symbols.rlDisableWireMode();
}

const LIGHTING_VERTEX_SHADER = /*glsl*/ `#version 330
in vec3 vertexPosition;
in vec2 vertexTexCoord;
in vec3 vertexNormal;
in vec4 vertexColor;

uniform mat4 mvp;
uniform mat4 matModel;

out vec3 fragPosition;
out vec3 fragNormal;
out vec2 fragTexCoord;
out vec4 fragColor;

void main() {
  vec4 worldPosition = matModel * vec4(vertexPosition, 1.0);
  fragPosition = worldPosition.xyz;
  fragNormal = normalize(mat3(transpose(inverse(matModel))) * vertexNormal);
  fragTexCoord = vertexTexCoord;
  fragColor = vertexColor;
  gl_Position = mvp * vec4(vertexPosition, 1.0);
}
`;

const LIGHTING_FRAGMENT_SHADER = /*glsl*/ `#version 330
in vec3 fragPosition;
in vec3 fragNormal;
in vec2 fragTexCoord;
in vec4 fragColor;

uniform sampler2D texture0;
uniform vec4 uBaseColor;
uniform vec3 uLightPosition;
uniform vec3 uLightColor;
uniform vec3 uAmbientColor;
uniform vec3 uViewPosition;
uniform float uLightIntensity;
uniform float uLightRange;

out vec4 finalColor;

void main() {
  vec4 albedo = texture(texture0, fragTexCoord) * uBaseColor * fragColor;
  if (albedo.a <= 0.001) discard;
  vec3 normal = normalize(fragNormal);
  vec3 lightVector = uLightPosition - fragPosition;
  float lightDistance = max(length(lightVector), 0.0001);
  vec3 lightDirection = lightVector / lightDistance;

  float attenuation = 1.0 / (1.0 + 0.09 * lightDistance + 0.032 * lightDistance * lightDistance);
  if (uLightRange > 0.0) {
    attenuation *= clamp(1.0 - (lightDistance / uLightRange), 0.0, 1.0);
  }

  float diffuse = max(dot(normal, lightDirection), 0.0);
  vec3 viewDirection = normalize(uViewPosition - fragPosition);
  vec3 halfVector = normalize(lightDirection + viewDirection);
  float specular = pow(max(dot(normal, halfVector), 0.0), 24.0) * 0.18;

  vec3 lighting = uAmbientColor + uLightColor * (diffuse + specular) * uLightIntensity * attenuation;
  finalColor = vec4(albedo.rgb * lighting, albedo.a);
}
`;

const UI_PANEL_VERTEX_SHADER = /*glsl*/ `#version 330
in vec3 vertexPosition;
in vec2 vertexTexCoord;
in vec3 vertexNormal;
in vec4 vertexColor;

uniform mat4 mvp;
uniform mat4 uWorld;

out vec2 fragUv;
out vec3 vWorldPos;

void main() {
  fragUv = vertexTexCoord;
  vWorldPos = (uWorld * vec4(vertexPosition, 1.0)).xyz;
  gl_Position = mvp * vec4(vertexPosition, 1.0);
}
`;

const UI_PANEL_FRAGMENT_SHADER = /*glsl*/ `#version 330
in vec2 fragUv;
in vec3 vWorldPos;
out vec4 finalColor;

uniform mat4 uClipping;
uniform vec4 uBackgroundColor;
uniform vec4 uBorderColor;
uniform vec4 uBorderSize;
uniform vec4 uBorderRadius;
uniform vec2 uDimensions;
uniform float uDepthOffset;

float min4(vec4 value) {
  vec2 tmp = min(value.xy, value.zw);
  return min(tmp.x, tmp.y);
}

float max4(vec4 value) {
  vec2 tmp = max(value.xy, value.zw);
  return max(tmp.x, tmp.y);
}

vec2 radiusDistance(float radius, vec2 outside, vec2 border, vec2 borderSize) {
  vec2 outerRadius = vec2(radius);
  vec2 innerRadius = max(vec2(0.0), outerRadius - borderSize);
  vec2 radiusWeightUnnorm = abs(innerRadius - border);
  float sum = radiusWeightUnnorm.x + radiusWeightUnnorm.y;
  vec2 radiusWeight = sum > 0.0 ? radiusWeightUnnorm / sum : vec2(0.5);
  return vec2(
    radius - distance(outside, outerRadius),
    dot(radiusWeight, innerRadius) - distance(border, innerRadius)
  );
}

vec2 calculateCornerIntersection(float cornerRadius, vec2 borderSizes, float aspectRatio) {
  float tmp1 = cornerRadius - borderSizes.y;
  vec2 xIntersection = vec2(tmp1, tmp1 / aspectRatio);

  float tmp2 = cornerRadius - borderSizes.x;
  vec2 yIntersection = vec2(tmp2 * aspectRatio, tmp2);

  return min(xIntersection, yIntersection);
}

void main() {
  vec4 plane;
  float distanceToPlane;
  float planeDistanceGradient;
  float clipOpacity = 1.0;
  for (int i = 0; i < 4; i++) {
    plane = uClipping[i];
    distanceToPlane = dot(vWorldPos, plane.xyz) + plane.w;
    planeDistanceGradient = fwidth(distanceToPlane) * 0.5;
    clipOpacity *= smoothstep(-planeDistanceGradient, planeDistanceGradient, distanceToPlane);
    if (clipOpacity < 0.01) {
      discard;
    }
  }

  vec2 dimensions = max(uDimensions, vec2(0.0001));
  float aspectRatio = dimensions.x / dimensions.y;
  vec4 borderSize = uBorderSize / dimensions.yyyy;
  vec2 uvFlipped = vec2(fragUv.x, 1.0 - fragUv.y);

  vec4 vOutsideDistance = vec4(
    uvFlipped.y,
    (1.0 - uvFlipped.x) * aspectRatio,
    1.0 - uvFlipped.y,
    uvFlipped.x * aspectRatio
  );
  vec4 vBorderDistance = vOutsideDistance - borderSize;
  vec2 distanceValues = vec2(min4(vOutsideDistance), min4(vBorderDistance));

  vec4 negateBorderDistance = vec4(1.0) - vBorderDistance;
  float maxWeight = max4(negateBorderDistance);
  vec4 borderWeight = step(maxWeight, negateBorderDistance);
  vec4 insideBorder = vec4(0.0);

  vec2 cornerPos;
  float cornerRadius;
  vec2 cornerBorderSizes;

  if (all(lessThan(vOutsideDistance.wx, uBorderRadius.xx))) {
    cornerPos = vOutsideDistance.wx;
    cornerRadius = uBorderRadius.x;
    cornerBorderSizes = borderSize.wx;
    distanceValues = radiusDistance(cornerRadius, cornerPos, vBorderDistance.wx, cornerBorderSizes);
    vec2 lineIntersection = calculateCornerIntersection(cornerRadius, cornerBorderSizes, aspectRatio);
    insideBorder.wx = max(vec2(0.0), lineIntersection - vBorderDistance.wx);
  } else if (all(lessThan(vOutsideDistance.yx, uBorderRadius.yy))) {
    cornerPos = vOutsideDistance.yx;
    cornerRadius = uBorderRadius.y;
    cornerBorderSizes = borderSize.yx;
    distanceValues = radiusDistance(cornerRadius, cornerPos, vBorderDistance.yx, cornerBorderSizes);
    vec2 lineIntersection = calculateCornerIntersection(cornerRadius, cornerBorderSizes, aspectRatio);
    insideBorder.yx = max(vec2(0.0), lineIntersection - vBorderDistance.yx);
  } else if (all(lessThan(vOutsideDistance.yz, uBorderRadius.zz))) {
    cornerPos = vOutsideDistance.yz;
    cornerRadius = uBorderRadius.z;
    cornerBorderSizes = borderSize.yz;
    distanceValues = radiusDistance(cornerRadius, cornerPos, vBorderDistance.yz, cornerBorderSizes);
    vec2 lineIntersection = calculateCornerIntersection(cornerRadius, cornerBorderSizes, aspectRatio);
    insideBorder.yz = max(vec2(0.0), lineIntersection - vBorderDistance.yz);
  } else if (all(lessThan(vOutsideDistance.zw, uBorderRadius.ww))) {
    cornerPos = vOutsideDistance.zw;
    cornerRadius = uBorderRadius.w;
    cornerBorderSizes = borderSize.zw;
    distanceValues = radiusDistance(cornerRadius, cornerPos, vBorderDistance.zw, cornerBorderSizes);
    vec2 lineIntersection = calculateCornerIntersection(cornerRadius, cornerBorderSizes, aspectRatio);
    insideBorder.zw = max(vec2(0.0), lineIntersection - vBorderDistance.zw);
  }

  float insideBorderSum = dot(insideBorder, vec4(1.0));
  if (insideBorderSum > 0.0) {
    borderWeight = insideBorder / insideBorderSum;
  }

  vec2 distanceGradient = fwidth(distanceValues);
  float outer = smoothstep(-distanceGradient.x, distanceGradient.x, distanceValues.x);
  float inner = smoothstep(-distanceGradient.y, distanceGradient.y, distanceValues.y);
  float transition = 1.0 - step(0.1, outer - inner) * (1.0 - inner);

  float fullBackgroundOpacity = uBackgroundColor.a;
  float fullBorderOpacity = min(1.0, uBorderColor.a + fullBackgroundOpacity);
  float outOpacity = clipOpacity * outer * mix(fullBorderOpacity, fullBackgroundOpacity, transition);
  if (outOpacity < 0.01) {
    discard;
  }

  vec3 mainColor = uBackgroundColor.rgb;
  float borderMix = uBorderColor.a / max(fullBorderOpacity, 0.001);
  vec3 rgb = mix(mix(mainColor, uBorderColor.rgb, borderMix), mainColor, transition);
  gl_FragDepth = max(0.0, gl_FragCoord.z - uDepthOffset);
  finalColor = vec4(rgb, outOpacity);
}
`;

const UI_TEXT_VERTEX_SHADER = /*glsl*/ `#version 330
in vec3 vertexPosition;
in vec2 vertexTexCoord;

uniform mat4 mvp;

out vec2 fragUv;

void main() {
  fragUv = vertexTexCoord;
  gl_Position = mvp * vec4(vertexPosition, 1.0);
}
`;

const UI_TEXT_FRAGMENT_SHADER = /*glsl*/ `#version 330
in vec2 fragUv;
out vec4 finalColor;

uniform sampler2D texture0;
uniform vec4 uTint;

float median(float r, float g, float b) {
  return max(min(r, g), min(max(r, g), b));
}

void main() {
  vec3 msd = texture(texture0, fragUv).rgb;
  float sigDist = median(msd.r, msd.g, msd.b) - 0.5;
  float alpha = clamp(sigDist / fwidth(sigDist) + 0.5, 0.0, 1.0);
  if (alpha < 0.01) discard;
  finalColor = vec4(uTint.rgb, uTint.a * alpha);
}
`;

const UI_TEXT_BATCH_VERTEX_SHADER = /*glsl*/ `#version 330
in vec3 vertexPosition;
in vec3 vertexNormal;
in vec2 vertexTexCoord;
in vec4 vertexColor;
out vec2 fragUv;
out vec4 fragTint;
void main() {
  fragUv = vertexTexCoord;
  gl_Position = vec4(vertexPosition.xy, vertexPosition.z, vertexNormal.x);
  // Mesh u8 colors are already normalized 0-1 in the pipe; do not divide by 255 again.
  fragTint = vertexColor;
}
`;

const UI_TEXT_BATCH_FRAGMENT_SHADER = /*glsl*/ `#version 330
in vec2 fragUv;
in vec4 fragTint;
out vec4 finalColor;
uniform sampler2D texture0;
float median(float r, float g, float b) {
  return max(min(r, g), min(max(r, g), b));
}
void main() {
  vec3 msd = texture(texture0, fragUv).rgb;
  float sigDist = median(msd.r, msd.g, msd.b) - 0.5;
  float alpha = clamp(sigDist / fwidth(sigDist) + 0.5, 0.0, 1.0);
  if (alpha < 0.01) discard;
  finalColor = vec4(fragTint.rgb, fragTint.a * alpha);
}
`;

const UI_PANEL_BATCH_VERTEX_SHADER = /*glsl*/ `#version 330
in vec3 vertexPosition;
in vec2 vertexTexCoord;
in vec4 vertexColor;
uniform mat4 mvp;
out vec2 fragUv;
out vec3 vWorldPos;
flat out int vPanelId;
void main() {
  fragUv = vertexTexCoord;
  vWorldPos = vertexPosition;
  // One batched tri-list quad = 6 non-indexed verts. Row in uPanelData must match
  // packed panel N (see packUikitPanelRow). Do not encode N in vertexColor (unreliable).
  vPanelId = gl_VertexID / 6;
  gl_Position = mvp * vec4(vertexPosition, 1.0);
}
`;

const UI_PANEL_BATCH_FRAGMENT_SHADER = /*glsl*/ `#version 330
in vec2 fragUv;
in vec3 vWorldPos;
flat in int vPanelId;
out vec4 finalColor;
/* Panel float data: bound via material albedo so DrawMesh glBindTexture runs (see tryDrawUiPanelsBatched). */
uniform sampler2D texture0;

float min4(vec4 value) {
  vec2 tmp = min(value.xy, value.zw);
  return min(tmp.x, tmp.y);
}
float max4(vec4 value) {
  vec2 tmp = max(value.xy, value.zw);
  return max(tmp.x, tmp.y);
}
vec2 radiusDistance(float radius, vec2 outside, vec2 border, vec2 borderSize) {
  vec2 outerRadius = vec2(radius);
  vec2 innerRadius = max(vec2(0.0), outerRadius - borderSize);
  vec2 radiusWeightUnnorm = abs(innerRadius - border);
  float sum = radiusWeightUnnorm.x + radiusWeightUnnorm.y;
  vec2 radiusWeight = sum > 0.0 ? radiusWeightUnnorm / sum : vec2(0.5);
  return vec2(
    radius - distance(outside, outerRadius),
    dot(radiusWeight, innerRadius) - distance(border, innerRadius)
  );
}
vec2 calculateCornerIntersection(float cornerRadius, vec2 borderSizes, float aspectRatio) {
  float tmp1 = cornerRadius - borderSizes.y;
  vec2 xIntersection = vec2(tmp1, tmp1 / aspectRatio);
  float tmp2 = cornerRadius - borderSizes.x;
  vec2 yIntersection = vec2(tmp2 * aspectRatio, tmp2);
  return min(xIntersection, yIntersection);
}
vec4 pfetch(int c) {
  return texelFetch(texture0, ivec2(c, vPanelId), 0);
}
void main() {
  vec4 uBorderSize = pfetch(0);
  vec4 uBackgroundColor = pfetch(1);
  vec4 uBorderColor = pfetch(2);
  vec4 uBorderRadius = pfetch(3);
  vec4 uDD = pfetch(4);
  vec2 uDimensions = uDD.xy;
  float uDepthOffset = uDD.z;
  mat4 uClipping = mat4(pfetch(5), pfetch(6), pfetch(7), pfetch(8));

  vec4 plane;
  float distanceToPlane;
  float planeDistanceGradient;
  float clipOpacity = 1.0;
  for (int i = 0; i < 4; i++) {
    plane = uClipping[i];
    distanceToPlane = dot(vWorldPos, plane.xyz) + plane.w;
    planeDistanceGradient = fwidth(distanceToPlane) * 0.5;
    clipOpacity *= smoothstep(-planeDistanceGradient, planeDistanceGradient, distanceToPlane);
    if (clipOpacity < 0.01) {
      discard;
    }
  }
  vec2 dimensions = max(uDimensions, vec2(0.0001));
  float aspectRatio = dimensions.x / dimensions.y;
  vec4 borderSize = uBorderSize / dimensions.yyyy;
  vec2 uvFlipped = vec2(fragUv.x, 1.0 - fragUv.y);
  vec4 vOutsideDistance = vec4(
    uvFlipped.y,
    (1.0 - uvFlipped.x) * aspectRatio,
    1.0 - uvFlipped.y,
    uvFlipped.x * aspectRatio
  );
  vec4 vBorderDistance = vOutsideDistance - borderSize;
  vec2 distanceValues = vec2(min4(vOutsideDistance), min4(vBorderDistance));
  vec4 negateBorderDistance = vec4(1.0) - vBorderDistance;
  float maxWeight = max4(negateBorderDistance);
  vec4 borderWeight = step(maxWeight, negateBorderDistance);
  vec4 insideBorder = vec4(0.0);
  vec2 cornerPos;
  float cornerRadius;
  vec2 cornerBorderSizes;
  if (all(lessThan(vOutsideDistance.wx, uBorderRadius.xx))) {
    cornerPos = vOutsideDistance.wx;
    cornerRadius = uBorderRadius.x;
    cornerBorderSizes = borderSize.wx;
    distanceValues = radiusDistance(cornerRadius, cornerPos, vBorderDistance.wx, cornerBorderSizes);
    vec2 lineIntersection = calculateCornerIntersection(cornerRadius, cornerBorderSizes, aspectRatio);
    insideBorder.wx = max(vec2(0.0), lineIntersection - vBorderDistance.wx);
  } else if (all(lessThan(vOutsideDistance.yx, uBorderRadius.yy))) {
    cornerPos = vOutsideDistance.yx;
    cornerRadius = uBorderRadius.y;
    cornerBorderSizes = borderSize.yx;
    distanceValues = radiusDistance(cornerRadius, cornerPos, vBorderDistance.yx, cornerBorderSizes);
    vec2 lineIntersection = calculateCornerIntersection(cornerRadius, cornerBorderSizes, aspectRatio);
    insideBorder.yx = max(vec2(0.0), lineIntersection - vBorderDistance.yx);
  } else if (all(lessThan(vOutsideDistance.yz, uBorderRadius.zz))) {
    cornerPos = vOutsideDistance.yz;
    cornerRadius = uBorderRadius.z;
    cornerBorderSizes = borderSize.yz;
    distanceValues = radiusDistance(cornerRadius, cornerPos, vBorderDistance.yz, cornerBorderSizes);
    vec2 lineIntersection = calculateCornerIntersection(cornerRadius, cornerBorderSizes, aspectRatio);
    insideBorder.yz = max(vec2(0.0), lineIntersection - vBorderDistance.yz);
  } else if (all(lessThan(vOutsideDistance.zw, uBorderRadius.ww))) {
    cornerPos = vOutsideDistance.zw;
    cornerRadius = uBorderRadius.w;
    cornerBorderSizes = borderSize.zw;
    distanceValues = radiusDistance(cornerRadius, cornerPos, vBorderDistance.zw, cornerBorderSizes);
    vec2 lineIntersection = calculateCornerIntersection(cornerRadius, cornerBorderSizes, aspectRatio);
    insideBorder.zw = max(vec2(0.0), lineIntersection - vBorderDistance.zw);
  }
  float insideBorderSum = dot(insideBorder, vec4(1.0));
  if (insideBorderSum > 0.0) {
    borderWeight = insideBorder / insideBorderSum;
  }
  vec2 distanceGradient = fwidth(distanceValues);
  float outer = smoothstep(-distanceGradient.x, distanceGradient.x, distanceValues.x);
  float inner = smoothstep(-distanceGradient.y, distanceGradient.y, distanceValues.y);
  float transition = 1.0 - step(0.1, outer - inner) * (1.0 - inner);
  float fullBackgroundOpacity = uBackgroundColor.a;
  float fullBorderOpacity = min(1.0, uBorderColor.a + fullBackgroundOpacity);
  float outOpacity = clipOpacity * outer * mix(fullBorderOpacity, fullBackgroundOpacity, transition);
  if (outOpacity < 0.01) {
    discard;
  }
  vec3 mainColor = uBackgroundColor.rgb;
  float borderMix = uBorderColor.a / max(fullBorderOpacity, 0.001);
  vec3 rgb = mix(mix(mainColor, uBorderColor.rgb, borderMix), mainColor, transition);
  gl_FragDepth = max(0.0, gl_FragCoord.z - uDepthOffset);
  finalColor = vec4(rgb, outOpacity);
}
`;
