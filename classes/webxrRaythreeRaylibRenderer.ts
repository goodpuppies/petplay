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
  return configured === "1" || configured === "true" || configured === "yes" ||
    configured === "on";
}

function isWebXrRaythreeUiPanelBatchDebugEnabled(): boolean {
  const configured = Deno.args
    .find((arg) => arg.startsWith("--webxr-raythree-ui-panel-batch-debug="))
    ?.split("=", 2)[1]
    ?.trim()
    .toLowerCase();
  return configured === "1" || configured === "true" || configured === "yes" ||
    configured === "on";
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
  /** Mirrors Three `Material.colorWrite`; false draws depth-only occluders. */
  colorWrite: boolean;
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
  hasTextureLoc: number;
  uvTransformLoc: number;
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
  mvpLoc: number;
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

type UiTextCpuGeometryCacheEntry = {
  geometry: MsdfCpuGeometry;
  version: number;
};

type DynamicNativeMesh = NativeMesh & {
  vertexCount: number;
};

/**
 * MSDF atlases by font id, mirroring `MSDF_FONTS` in `msdf-text.tsx`. The three
 * side bakes glyph UVs against one of these; this is the matching texture.
 *
 * Icons are a font here rather than images, so they need no path of their own —
 * only that the atlas be selectable per text run.
 */
const MSDF_ATLAS_PATHS: Record<string, URL> = {
  roboto: new URL(
    "../submodules/threewebxrwebgpudeno/vendor/three-msdf-text-utils/demo/fonts/roboto/roboto-regular.png",
    import.meta.url,
  ),
  "material-icons": new URL(
    "../resources/fonts/material-icons/material-icons.png",
    import.meta.url,
  ),
};

const DEFAULT_MSDF_FONT = "roboto";

/**
 * Four clip planes that never cut anything.
 *
 * The shader tests `dot(worldPos, plane.xyz) + plane.w > 0`, so "never clip" is
 * a zero normal with a large positive offset — every point is then trivially
 * inside. Filling this with large *negative* values instead (the obvious guess)
 * makes the distance negative everywhere and discards the whole quad.
 */
const UI_IMAGE_NO_CLIP = new Float32Array([
  0,
  0,
  0,
  1e6,
  0,
  0,
  0,
  1e6,
  0,
  0,
  0,
  1e6,
  0,
  0,
  0,
  1e6,
]);

/**
 * UV scale/offset that makes an image `cover` its panel without distortion.
 *
 * The shorter axis is left at 1 and the longer one is scaled down, which crops
 * rather than letterboxes. `focus` picks which part of the cropped axis
 * survives — 0.5 centres it, 1 keeps the far edge.
 */
function computeCoverUv(
  imageWidth: number,
  imageHeight: number,
  panelWidth: number,
  panelHeight: number,
  fit: "cover" | "stretch",
  focus: [number, number],
): [number, number, number, number] {
  if (fit === "stretch" || imageWidth <= 0 || imageHeight <= 0) {
    return [1, 1, 0, 0];
  }
  const imageAspect = imageWidth / imageHeight;
  const panelAspect = panelWidth / Math.max(panelHeight, 0.0001);
  // Scale the axis that has surplus, so the other one fills exactly.
  const scaleX = imageAspect > panelAspect ? panelAspect / imageAspect : 1;
  const scaleY = imageAspect > panelAspect ? 1 : imageAspect / panelAspect;
  return [scaleX, scaleY, (1 - scaleX) * focus[0], (1 - scaleY) * focus[1]];
}

/**
 * Images available to the UI, by id.
 *
 * Only a string id crosses the snapshot boundary — the renderer owns loading
 * and caching, exactly as it does for the MSDF atlases above. That keeps
 * pixel data out of the per-frame snapshot entirely.
 *
 * A registry covers the static cases (a wallpaper, a logo). Dynamic sources —
 * album art, window thumbnails — will want a `registerUiTexture(id, pixels)`
 * companion; deliberately not built until a caller needs it.
 */
const UI_TEXTURE_PATHS: Record<string, URL> = {
  wallpaper: new URL("../resources/ui/wallpaper.png", import.meta.url),
};
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
  private readonly uiTextCpuGeometries = new WeakMap<
    object,
    UiTextCpuGeometryCacheEntry
  >();
  private readonly loggedTextGeometryValidation = new Set<string>();
  private readonly uiTextures = new Map<string, raylibBindings.Texture2D>();
  private readonly uiTextureSizes = new Map<string, [number, number]>();
  private readonly uiTextureLoadFailed = new Set<string>();
  private readonly uiMsdfAtlases = new Map<string, raylibBindings.Texture2D>();
  private readonly uiMsdfAtlasSizes = new Map<string, [number, number]>();
  private readonly uiMsdfAtlasLoadFailed = new Set<string>();
  private readonly instanceMatrix = new THREE.Matrix4();
  private readonly worldMatrix = new THREE.Matrix4();
  private readonly sortMatrix = new THREE.Matrix4();
  private readonly sortVector = new THREE.Vector3();
  private readonly transparentInstanceScratch: Array<
    RenderInstance | InstancedRenderInstance
  > = [];
  /** Filled from the current view matrix per frame; `getWorldMatrixViewDepth` reads it (do not re-enter before a sort has finished). */
  private readonly raylibMatrixScratch: raylibBindings.Matrix = {
    m0: 1,
    m1: 0,
    m2: 0,
    m3: 0,
    m4: 0,
    m5: 1,
    m6: 0,
    m7: 0,
    m8: 0,
    m9: 0,
    m10: 1,
    m11: 0,
    m12: 0,
    m13: 0,
    m14: 0,
    m15: 1,
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
  private readonly uiTextBatchMeshes = new Map<
    string,
    {
      mesh: DynamicNativeMesh;
      texts: WebXRRaythreeUiSnapshot["texts"];
    }
  >();
  private textBatchPoolPos = new Float32Array(0);
  private textBatchPoolN = new Float32Array(0);
  private textBatchPoolUv = new Float32Array(0);
  private textBatchPoolC = new Uint8Array(0);
  private textBatchPoolCap = 0;
  private uiPanelDataBytes: Uint8Array | null = null;
  private uiPanelDataTexture: raylibBindings.Texture2D | null = null;
  private uiPanelDataTexH = 0;
  private uiPanelDataTexW = 9;
  private uiPanelBatchMesh: DynamicNativeMesh | null = null;
  private uiPanelBatchPoolPos = new Float32Array(0);
  private uiPanelBatchPoolN = new Float32Array(0);
  private uiPanelBatchPoolUv = new Float32Array(0);
  private uiPanelBatchPoolC = new Uint8Array(0);
  private readonly clipV4 = new THREE.Vector4();
  private readonly identityMatrix16 = new Float32Array([
    1,
    0,
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    0,
    1,
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

  private ensureUiTexture(textureId: string): raylibBindings.Texture2D | null {
    const existing = this.uiTextures.get(textureId);
    if (existing !== undefined) {
      return existing;
    }
    if (this.uiTextureLoadFailed.has(textureId)) {
      return null;
    }
    const path = UI_TEXTURE_PATHS[textureId];
    if (path === undefined) {
      this.uiTextureLoadFailed.add(textureId);
      LogChannel.log("webxrv2", `[webxr] unknown ui texture \`${textureId}\``);
      return null;
    }
    try {
      const bytes = Deno.readFileSync(path);
      const image = raylib.H.LoadImageFromMemory(
        ".png",
        Deno.UnsafePointer.of(bytes) as Deno.PointerValue<number>,
        bytes.length,
      );
      const texture = raylib.H.LoadTextureFromImage(image);
      raylib.H.SetTextureFilter(
        texture,
        raylibBindings.TextureFilter.TEXTURE_FILTER_BILINEAR,
      );
      raylib.H.SetTextureWrap(texture, raylibBindings.TextureWrap.TEXTURE_WRAP_CLAMP);
      this.uiTextureSizes.set(textureId, [image.width, image.height]);
      raylib.H.UnloadImage(image);
      this.uiTextures.set(textureId, texture);
      LogChannel.log(
        "webxrv2",
        `[webxr] ui texture \`${textureId}\` loaded ${image.width}x${image.height}`,
      );
      return texture;
    } catch (error) {
      this.uiTextureLoadFailed.add(textureId);
      LogChannel.log(
        "webxrv2",
        `[webxr] ui texture \`${textureId}\` load failed: ${String(error)}`,
      );
      return null;
    }
  }

  private ensureMsdfAtlas(
    fontId: string = DEFAULT_MSDF_FONT,
  ): raylibBindings.Texture2D | null {
    const existing = this.uiMsdfAtlases.get(fontId);
    if (existing !== undefined) {
      return existing;
    }
    if (this.uiMsdfAtlasLoadFailed.has(fontId)) {
      return null;
    }
    const path = MSDF_ATLAS_PATHS[fontId];
    if (path === undefined) {
      this.uiMsdfAtlasLoadFailed.add(fontId);
      LogChannel.log("webxrv2", `[webxr] unknown msdf font \`${fontId}\``);
      return null;
    }
    try {
      const atlasBytes = Deno.readFileSync(path);
      const image = raylib.H.LoadImageFromMemory(
        ".png",
        Deno.UnsafePointer.of(atlasBytes) as Deno.PointerValue<number>,
        atlasBytes.length,
      );
      // three-msdf-text-utils uses texture.flipY=true; match that upload convention in raylib.
      const imageHandle = raylibBindings.Image.createPointer(image);
      raylib.H.ImageFlipVertical(imageHandle.pointer);
      const flippedImage = imageHandle.read();
      const texture = raylib.H.LoadTextureFromImage(flippedImage);
      raylib.H.SetTextureFilter(
        texture,
        raylibBindings.TextureFilter.TEXTURE_FILTER_BILINEAR,
      );
      raylib.H.SetTextureWrap(
        texture,
        raylibBindings.TextureWrap.TEXTURE_WRAP_CLAMP,
      );
      this.uiMsdfAtlasSizes.set(fontId, [flippedImage.width, flippedImage.height]);
      raylib.H.UnloadImage(flippedImage);
      this.uiMsdfAtlases.set(fontId, texture);
      LogChannel.log(
        "webxrv2",
        `[webxr] msdf atlas \`${fontId}\` loaded ${flippedImage.width}x${flippedImage.height}`,
      );
      return texture;
    } catch (error) {
      this.uiMsdfAtlasLoadFailed.add(fontId);
      LogChannel.log(
        "webxrv2",
        `[webxr] msdf atlas \`${fontId}\` load failed: ${String(error)}`,
      );
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
    LogChannel.log(
      "webxrv2",
      `[webxr] raylib scene dispose: geometries=${this.geometries.size}`,
    );
    for (const geometry of this.geometries.values()) {
      this.unloadNativeMesh(geometry);
    }
    this.geometries.clear();
    this.geometryRevisions.clear();
    this.materials.clear();
    this.materialRevisions.clear();
    LogChannel.log(
      "webxrv2",
      `[webxr] raylib scene dispose: textMeshes=${this.uiTextMeshes.size}`,
    );
    for (const entry of this.uiTextMeshes.values()) {
      this.unloadNativeMesh(entry.mesh);
    }
    this.uiTextMeshes.clear();
    LogChannel.log(
      "webxrv2",
      "[webxr] raylib scene dispose: UI textures and meshes",
    );
    for (const texture of this.uiTextures.values()) {
      raylib.H.UnloadTexture(texture);
    }
    this.uiTextures.clear();
    this.uiTextureSizes.clear();
    if (this.uiMsdfAtlases.size > 0) {
      for (const texture of this.uiMsdfAtlases.values()) {
        raylib.H.UnloadTexture(texture);
      }
      this.uiMsdfAtlases.clear();
      this.uiMsdfAtlasSizes.clear();
      this.lastBatchedTextAtlasId = 0;
    }
    this.unloadNativeMesh(this.uiPanelMesh);
    for (const entry of this.uiTextBatchMeshes.values()) {
      this.unloadNativeMesh(entry.mesh);
    }
    this.uiTextBatchMeshes.clear();
    if (this.uiPanelBatchMesh !== null) {
      this.unloadNativeMesh(this.uiPanelBatchMesh);
      this.uiPanelBatchMesh = null;
    }
    if (this.uiPanelDataTexture !== null) {
      raylib.H.UnloadTexture(this.uiPanelDataTexture);
      this.uiPanelDataTexture = null;
    }
    this.uiPanelDataBytes = null;
    LogChannel.log("webxrv2", "[webxr] raylib scene dispose: shaders");
    raylib.H.UnloadShader(this.uiTextShader.shader);
    raylib.H.UnloadShader(this.uiTextBatchShader.shader);
    raylib.H.UnloadShader(this.uiPanelShader.shader);
    raylib.H.UnloadShader(this.uiPanelBatchShader.shader);
    raylib.H.UnloadShader(this.lightingShader.shader);
    LogChannel.log("webxrv2", "[webxr] raylib scene dispose: complete");
  }

  private syncAssets(
    extraction: ExtractionResult,
    debugContext?: string,
  ): void {
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
    const projectionMatrix = (matrices?.projectionMatrix ??
      frame.camera.projectionMatrix) as Float32Array;
    this.sortMatrix.fromArray(viewMatrix as unknown as number[]);
    const scratch = this.transparentInstanceScratch;
    scratch.length = 0;
    for (let i = 0; i < frame.instances.length; i++) {
      const inst = frame.instances[i]!;
      if (
        this.materials.get(inst.materialId)?.transparent === true &&
        !inst.hudOverUi
      ) {
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
      this.matrixForDraw(
        (matrices?.projectionMatrix ??
          frame.camera.projectionMatrix) as ArrayLike<number>,
      ),
    );
    raylib.H.rlSetMatrixModelview(
      this.matrixForDraw(viewMatrix),
    );
    const tPrep1 = performance.now();

    for (const instance of frame.instances) {
      const nativeMesh = this.geometries.get(instance.geometryId);
      const nativeMaterial = this.materials.get(instance.materialId);
      if (
        !nativeMesh || !nativeMaterial || nativeMaterial.transparent ||
        instance.hudOverUi
      ) {
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
    this.drawHudOverUiInstances(frame);
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
      const orderDifference = compareUiOrderInfo(
        left.orderInfo,
        right.orderInfo,
      );
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

    // Group by uikit root and draw the roots back to front.
    //
    // The UI pass runs with the depth test off, so layering is draw order alone.
    // uikit's ordering is only meaningful *within* a root: every panel reports
    // order info 0/0/0/0 and `instanceIndex` is merely the slot uikit allocated,
    // so two roots at different depths — a keyboard and the wrist overlay —
    // interleave arbitrarily and the further one can paint over the nearer.
    // Sorting roots by view depth restores the one guarantee that matters
    // between them, while uikit's order still decides everything inside one.
    const rootOrder = new Map<number, { depth: number; count: number }>();
    for (const panel of panels) {
      const entry = rootOrder.get(panel.rootIndex) ?? { depth: 0, count: 0 };
      entry.depth += this.getWorldMatrixViewDepth(panel.worldMatrix);
      entry.count += 1;
      rootOrder.set(panel.rootIndex, entry);
    }
    for (const text of texts) {
      // A root may legitimately have text and no panels.
      if (rootOrder.has(text.rootIndex)) continue;
      rootOrder.set(text.rootIndex, {
        depth: this.getWorldMatrixViewDepth(text.worldMatrix),
        count: 1,
      });
    }
    // Mean depth of a root's panels: they are near-coplanar in practice, so this
    // is stable, and it avoids one stray element deciding a whole root's layer.
    const rootIndicesByDepth = [...rootOrder.entries()]
      .sort((left, right) =>
        (right[1].depth / Math.max(right[1].count, 1)) -
        (left[1].depth / Math.max(left[1].count, 1))
      )
      .map(([rootIndex]) => rootIndex);

    const panelsByRoot = new Map<number, typeof panels>();
    for (const panel of panels) {
      const group = panelsByRoot.get(panel.rootIndex) ?? [];
      group.push(panel);
      panelsByRoot.set(panel.rootIndex, group);
    }
    const textsByRoot = new Map<number, typeof texts>();
    for (const text of texts) {
      const group = textsByRoot.get(text.rootIndex) ?? [];
      group.push(text);
      textsByRoot.set(text.rootIndex, group);
    }
    const imagesByRoot = new Map<number, WebXRRaythreeUiSnapshot["images"]>();
    for (const image of ui.images ?? []) {
      const group = imagesByRoot.get(image.rootIndex) ?? [];
      group.push(image);
      imagesByRoot.set(image.rootIndex, group);
    }
    const t1 = performance.now();

    if (
      WEBXR_RAYTHREE_UI_PANEL_FORCE_UNBATCHED &&
      !this.loggedUiPanelForceUnbatchedOnce
    ) {
      this.loggedUiPanelForceUnbatchedOnce = true;
      LogChannel.log(
        "webxrv2",
        "[webxr] UI panels: force-unbatched (per-panel drawUiPanel); batch path skipped. " +
          "Remove --webxr-raythree-ui-panel-force-unbatched=1 to re-test batching.",
      );
    }

    // Each root is drawn complete — panels, its images, then its text — before
    // the next one starts. Drawing all panels then all text globally would let a
    // far root's labels land on a near root's panels.
    let panelDrawn = 0;
    let textDrawn = 0;
    let panelsMs = 0;
    let textMs = 0;
    for (const rootIndex of rootIndicesByDepth) {
      const rootPanels = panelsByRoot.get(rootIndex) ?? [];
      const rootImages = imagesByRoot.get(rootIndex) ?? [];
      const rootTexts = textsByRoot.get(rootIndex) ?? [];

      const panelsStart = performance.now();
      if (rootImages.length > 0) {
        // Placing an image in the draw order by sort key does not work: uikit
        // gives every panel the same order info and layers them by
        // `instanceIndex`, while `Content` — which an image rides on — reports a
        // higher elementType and would sort above every panel. There is no key
        // meaning "just behind this tile's contents".
        //
        // What *is* known is geometric: an image fills one panel's rectangle. So
        // match each image to that panel and draw it immediately afterwards. The
        // tile's background paints first, the image covers it, and the tile's
        // children draw on top — exactly what a fill should do.
        // Keep batching on either side of an image. The previous implementation
        // disabled batching for the whole root as soon as it contained one
        // image, turning a wallpaper into dozens of native draw calls per eye.
        // A batch boundary immediately after the matching panel preserves the
        // exact same ordering while retaining almost all of the batching win.
        const pendingImages = rootImages.map((item) => ({ item, placed: false }));
        let runStart = 0;
        for (let panelIndex = 0; panelIndex < rootPanels.length; panelIndex++) {
          const panel = rootPanels[panelIndex]!;
          const matchingImages = [] as typeof pendingImages;
          for (const pending of pendingImages) {
            if (pending.placed || !panelMatchesImage(panel, pending.item)) {
              continue;
            }
            pending.placed = true;
            matchingImages.push(pending);
          }
          if (matchingImages.length === 0) {
            continue;
          }
          panelDrawn += this.drawUiPanelRun(
            rootPanels.slice(runStart, panelIndex + 1),
            this.uiMvpPV,
          );
          runStart = panelIndex + 1;
          for (const pending of matchingImages) {
            this.drawUiImage(pending.item, this.uiMvpPV);
          }
        }
        panelDrawn += this.drawUiPanelRun(rootPanels.slice(runStart), this.uiMvpPV);
        // An image matching no panel still draws, on top, rather than vanishing
        // silently — a visible wrong result beats an invisible one.
        for (const pending of pendingImages) {
          if (!pending.placed) {
            this.drawUiImage(pending.item, this.uiMvpPV);
          }
        }
      } else {
        panelDrawn += this.drawUiPanelRun(rootPanels, this.uiMvpPV);
      }
      panelsMs += performance.now() - panelsStart;

      const textStart = performance.now();
      // One batch per font within the root: a batch binds a single atlas, so
      // runs from different fonts cannot share one. Grouping keeps batching in
      // play once icons are on screen.
      const textsByFont = new Map<string, typeof rootTexts>();
      for (const text of rootTexts) {
        const fontId = text.font ?? DEFAULT_MSDF_FONT;
        const group = textsByFont.get(fontId) ?? [];
        group.push(text);
        textsByFont.set(fontId, group);
      }
      for (const [fontId, group] of textsByFont) {
        const textBatched = this.tryDrawUiTextBatched(group, this.uiMvpPV, fontId);
        if (textBatched === null) {
          for (const text of group) {
            if (this.drawUiText(text, this.uiMvpPV)) {
              textDrawn++;
            }
          }
        } else {
          textDrawn += textBatched;
        }
      }
      textMs += performance.now() - textStart;
    }

    const t3 = performance.now();

    if (ui.texts.length > 0 && !this.loggedTextCounts.has(ui.texts.length)) {
      this.loggedTextCounts.add(ui.texts.length);
      debugLog(`ui text snapshot count=${ui.texts.length} renderer=billboard`);
    }

    return {
      sortPrepMs: t1 - t0,
      panelsMs,
      textMs,
      panelCount: ui.panels.length,
      textCount: ui.texts.length,
      panelDrawn,
      textDrawn,
    };
  }

  /** Draw a contiguous panel-order run as one batch, with a safe per-panel fallback. */
  private drawUiPanelRun(
    panels: WebXRRaythreeUiSnapshot["panels"],
    projView: THREE.Matrix4,
  ): number {
    if (panels.length === 0) {
      return 0;
    }
    const batched = WEBXR_RAYTHREE_UI_PANEL_FORCE_UNBATCHED
      ? null
      : this.tryDrawUiPanelsBatched(panels, projView);
    if (batched !== null) {
      return batched;
    }
    let drawn = 0;
    for (const panel of panels) {
      if (this.drawUiPanel(panel, projView)) {
        drawn++;
      }
    }
    return drawn;
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
      (brdA <= 1e-4 ||
        (borderTop <= 0 && borderRight <= 0 && borderBottom <= 0 &&
          borderLeft <= 0))
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
    // Shader uniforms persist between draws, so an ordinary panel has to clear
    // the flag or it would inherit the previous image's texture as its fill.
    setShaderFloat(this.uiPanelShader.shader, this.uiPanelShader.hasTextureLoc, 0);
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

  /**
   * Draw one image as a rounded panel fill.
   *
   * Deliberately shares `uiPanelShader` with panels rather than having its own:
   * the corner SDF, border blend and clip are then literally the same code, so
   * an image's corner cannot diverge from a panel's as either evolves.
   *
   * @returns `true` if a quad was submitted.
   */
  private drawUiImage(
    image: WebXRRaythreeUiSnapshot["images"][number],
    projView: THREE.Matrix4,
  ): boolean {
    const opacity = image.opacity ?? 1;
    if (opacity <= 0) {
      return false;
    }
    const texture = this.ensureUiTexture(image.texture);
    if (texture === null) {
      return false;
    }
    const size = this.uiTextureSizes.get(image.texture) ?? [1, 1];

    const albedoMap = readMaterialMap(
      this.uiMaterialBytes,
      raylibBindings.MaterialMapIndex.MATERIAL_MAP_ALBEDO,
    );
    writeMaterialMap(
      this.uiMaterialBytes,
      raylibBindings.MaterialMapIndex.MATERIAL_MAP_ALBEDO,
      { ...albedoMap, texture, color: raylib.WHITE },
    );

    const radius = image.borderRadius ?? [0, 0, 0, 0];
    setShaderVec4(this.uiPanelShader.shader, this.uiPanelShader.backgroundColorLoc, [
      1,
      1,
      1,
      opacity,
    ]);
    setShaderVec4(this.uiPanelShader.shader, this.uiPanelShader.borderColorLoc, [0, 0, 0, 0]);
    setShaderVec4(this.uiPanelShader.shader, this.uiPanelShader.borderSizeLoc, [0, 0, 0, 0]);
    setShaderVec4(this.uiPanelShader.shader, this.uiPanelShader.borderRadiusLoc, [
      radius[0] / image.height,
      radius[1] / image.height,
      radius[2] / image.height,
      radius[3] / image.height,
    ]);
    setShaderVec2(
      this.uiPanelShader.shader,
      this.uiPanelShader.dimensionsLoc,
      image.width,
      image.height,
    );
    setShaderFloat(this.uiPanelShader.shader, this.uiPanelShader.hasTextureLoc, 1);
    setShaderVec4(
      this.uiPanelShader.shader,
      this.uiPanelShader.uvTransformLoc,
      computeCoverUv(
        size[0],
        size[1],
        image.width,
        image.height,
        image.fit ?? "cover",
        image.focus ?? [0.5, 0.5],
      ),
    );

    setShaderFloat(this.uiPanelShader.shader, this.uiPanelShader.depthOffsetLoc, 0);

    // `Content` has already scaled the unit quad onto the laid-out box, so the
    // world matrix is used as-is; applying width/height again would square it.
    const world = image.worldMatrix;

    if (this.uiPanelShader.worldLoc >= 0) {
      raylib.H.SetShaderValueMatrix(
        this.uiPanelShader.shader,
        this.uiPanelShader.worldLoc,
        this.matrixForDraw(world),
      );
    }
    if (this.uiPanelShader.clippingLoc >= 0) {
      // Images are not scroll-clipped yet, so use planes that never cut. The
      // uniform persists between draws, so leaving it unset would inherit the
      // previous panel's clip rect and silently erase the image.
      raylib.H.SetShaderValueMatrix(
        this.uiPanelShader.shader,
        this.uiPanelShader.clippingLoc,
        this.matrixForDraw(UI_IMAGE_NO_CLIP),
      );
    }
    this.setUiShaderMvp(
      this.uiPanelShader.shader,
      this.uiPanelShader.mvpLoc,
      projView,
      world,
    );
    this.drawUiQuad(world);
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
    const fontId = text.font ?? DEFAULT_MSDF_FONT;
    const atlas = this.ensureMsdfAtlas(fontId);
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

    const atlasSize = this.uiMsdfAtlasSizes.get(fontId) ?? [0, 0];

    // Same working-space -> sRGB conversion as `toShaderColor`; text color comes
    // from the same uikit/THREE.Color origin as panel color.
    setShaderVec4(this.uiTextShader.shader, this.uiTextShader.tintLoc, [
      linearToSrgbChannel(text.color[0]),
      linearToSrgbChannel(text.color[1]),
      linearToSrgbChannel(text.color[2]),
      text.color[3],
    ]);
    setShaderFloat(
      this.uiTextShader.shader,
      this.uiTextShader.pxRangeLoc,
      MSDF_PX_RANGE,
    );
    setShaderVec2(
      this.uiTextShader.shader,
      this.uiTextShader.atlasSizeLoc,
      atlasSize[0],
      atlasSize[1],
    );

    this.setUiShaderMvp(
      this.uiTextShader.shader,
      this.uiTextShader.mvpLoc,
      projView,
      text.worldMatrix,
    );
    raylib.H.DrawMesh(
      mesh.mesh,
      this.uiTextMaterial,
      this.matrixForDraw(text.worldMatrix),
    );
    return true;
  }

  private getUiTextMesh(
    text: WebXRRaythreeUiSnapshot["texts"][number],
  ): NativeMesh | null {
    const geometry = text.geometry;
    if (geometry === undefined) return null;
    const key = createUiTextGeometryKey(text.text, geometry);
    maybeValidateMsdfGeometry(
      text.text,
      geometry,
      this.loggedTextGeometryValidation,
    );
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
    const restoreColorMask = !material.colorWrite;
    if (restoreDepthTest) {
      setUiDepthTestEnabled(false);
    }
    if (restoreDepthMask) {
      setUiDepthMaskEnabled(false);
    }
    if (restoreColorMask) {
      setUiColorMaskEnabled(false);
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
        if (
          material.transparent &&
          material.blendMode !== raylibBindings.BlendMode.BLEND_ALPHA
        ) {
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
        if (
          material.transparent &&
          material.blendMode !== raylibBindings.BlendMode.BLEND_ALPHA
        ) {
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

      if (
        material.transparent &&
        material.blendMode !== raylibBindings.BlendMode.BLEND_ALPHA
      ) {
        raylib.H.EndBlendMode();
        raylib.H.BeginBlendMode(material.blendMode);
      }
      raylib.H.DrawMesh(
        nativeMesh.mesh,
        material.material,
        this.matrixForDraw(worldMatrix),
      );
      if (
        material.transparent &&
        material.blendMode !== raylibBindings.BlendMode.BLEND_ALPHA
      ) {
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
      if (restoreColorMask) {
        setUiColorMaskEnabled(true);
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
        this.drawNativeMesh(
          nativeMesh,
          nativeMaterial,
          this.instanceMatrix.elements,
        );
      }
      return;
    }

    this.drawNativeMesh(nativeMesh, nativeMaterial, instance.worldMatrix);
  }

  /**
   * World meshes marked `userData.raythreeHudOverUi` (e.g. controller aim beam) draw
   * after the uikit pass so they are not covered by panel/text quads in the Raylib path.
   */
  private drawHudOverUiInstances(frame: RenderFrame): void {
    const opaque: Array<RenderInstance | InstancedRenderInstance> = [];
    const transparent: Array<RenderInstance | InstancedRenderInstance> = [];
    for (const instance of frame.instances) {
      if (!instance.hudOverUi) {
        continue;
      }
      const m = this.materials.get(instance.materialId);
      if (m == null) {
        continue;
      }
      (m.transparent ? transparent : opaque).push(instance);
    }
    if (opaque.length === 0 && transparent.length === 0) {
      return;
    }
    transparent.sort((a, b) => this.getInstanceViewDepth(b) - this.getInstanceViewDepth(a));
    setUiDepthMaskEnabled(false);
    setUiDepthTestEnabled(true);
    setUiBackfaceCullingEnabled(false);
    try {
      for (const list of [opaque, transparent]) {
        for (const instance of list) {
          const nativeMesh = this.geometries.get(instance.geometryId);
          const nativeMaterial = this.materials.get(instance.materialId);
          if (nativeMesh == null || nativeMaterial == null) {
            continue;
          }
          this.drawInstance(nativeMesh, nativeMaterial, instance);
        }
      }
    } finally {
      setUiBackfaceCullingEnabled(true);
      setUiDepthMaskEnabled(true);
    }
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
    const vCount = 6 * drawn.length;
    this.ensureUiPanelBatchPool(vCount);
    const pos = this.uiPanelBatchPoolPos;
    const nrm = this.uiPanelBatchPoolN;
    const uv = this.uiPanelBatchPoolUv;
    const col = this.uiPanelBatchPoolC;
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
    this.uiPanelBatchMesh = this.updateOrCreateDynamicMesh(
      this.uiPanelBatchMesh,
      vCount,
      pos,
      uv,
      nrm,
      col,
    );
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
    if (
      WEBXR_RAYTHREE_UI_PANEL_BATCH_DEBUG && !this.loggedUiPanelBatchDebugOnce
    ) {
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

  private ensureUiPanelBatchPool(vertexCount: number): void {
    if (this.uiPanelBatchPoolPos.length >= vertexCount * 3) {
      return;
    }
    const cap = Math.max(Math.ceil(vertexCount * 1.2), 1024);
    this.uiPanelBatchPoolPos = new Float32Array(cap * 3);
    this.uiPanelBatchPoolN = new Float32Array(cap * 3);
    this.uiPanelBatchPoolUv = new Float32Array(cap * 2);
    this.uiPanelBatchPoolC = new Uint8Array(cap * 4);
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
    fontId: string = DEFAULT_MSDF_FONT,
  ): number | null {
    const atlas = this.ensureMsdfAtlas(fontId);
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
    let totalV = 0;
    let drawnCount = 0;
    for (const t of texts) {
      if (t.text.length === 0 || t.color[3] <= 0 || t.geometry == null) {
        continue;
      }
      const g = this.getBatchedUiTextGeometry(t);
      if (g == null) {
        continue;
      }
      totalV += g.vertexCount;
      drawnCount++;
    }
    if (drawnCount === 0) {
      return 0;
    }
    if (totalV > 500000) {
      return null;
    }
    const batchKey = `${texts[0]?.rootIndex ?? -1}:${fontId}`;
    const cached = this.uiTextBatchMeshes.get(batchKey);
    const sameSnapshot = cached !== undefined &&
      cached.mesh.vertexCount === totalV &&
      cached.texts.length === texts.length &&
      texts.every((text, index) => cached.texts[index] === text);
    if (cached !== undefined && sameSnapshot) {
      if (this.uiTextBatchShader.mvpLoc >= 0) {
        raylib.H.SetShaderValueMatrix(
          this.uiTextBatchShader.shader,
          this.uiTextBatchShader.mvpLoc,
          this.matrixForDraw(projView.elements as unknown as number[]),
        );
      }
      raylib.H.DrawMesh(
        cached.mesh.mesh,
        this.uiTextBatchMaterial,
        this.matrixForDraw(this.identityMatrix16),
      );
      return drawnCount;
    }
    this.ensureTextBatchPool(totalV);
    let wx = 0;
    for (const t of texts) {
      if (t.text.length === 0 || t.color[3] <= 0 || t.geometry == null) {
        continue;
      }
      const g = this.getBatchedUiTextGeometry(t);
      if (g == null) {
        continue;
      }
      this.uiMvpW.fromArray(t.worldMatrix as unknown as number[]);
      for (let i = 0; i < g.vertexCount; i++) {
        this.clipV4.set(
          g.positions3D[i * 3]!,
          g.positions3D[i * 3 + 1]!,
          g.positions3D[i * 3 + 2]!,
          1,
        );
        this.clipV4.applyMatrix4(this.uiMvpW);
        const o3 = wx * 3;
        this.textBatchPoolPos[o3] = this.clipV4.x;
        this.textBatchPoolPos[o3 + 1] = this.clipV4.y;
        this.textBatchPoolPos[o3 + 2] = this.clipV4.z;
        this.textBatchPoolN[o3] = 0;
        this.textBatchPoolN[o3 + 1] = 0;
        this.textBatchPoolN[o3 + 2] = 0;
        const o2 = wx * 2;
        this.textBatchPoolUv[o2] = g.uvs[i * 2]!;
        this.textBatchPoolUv[o2 + 1] = g.uvs[i * 2 + 1]!;
        const o4 = wx * 4;
        this.textBatchPoolC[o4] = Math.round(t.color[0] * 255);
        this.textBatchPoolC[o4 + 1] = Math.round(t.color[1] * 255);
        this.textBatchPoolC[o4 + 2] = Math.round(t.color[2] * 255);
        this.textBatchPoolC[o4 + 3] = Math.round(t.color[3] * 255);
        wx++;
      }
    }
    const mesh = this.updateOrCreateDynamicMesh(
      cached?.mesh ?? null,
      totalV,
      this.textBatchPoolPos,
      this.textBatchPoolUv,
      this.textBatchPoolN,
      this.textBatchPoolC,
    );
    this.uiTextBatchMeshes.set(batchKey, { mesh, texts });
    if (this.uiTextBatchShader.mvpLoc >= 0) {
      raylib.H.SetShaderValueMatrix(
        this.uiTextBatchShader.shader,
        this.uiTextBatchShader.mvpLoc,
        this.matrixForDraw(projView.elements as unknown as number[]),
      );
    }
    raylib.H.DrawMesh(
      mesh.mesh,
      this.uiTextBatchMaterial,
      this.matrixForDraw(this.identityMatrix16),
    );
    return drawnCount;
  }

  private getBatchedUiTextGeometry(
    text: WebXRRaythreeUiSnapshot["texts"][number],
  ): MsdfCpuGeometry | null {
    const source = text.geometry;
    if (source == null) {
      return null;
    }
    const cached = this.uiTextCpuGeometries.get(source);
    if (cached?.version === source.version) {
      return cached.geometry;
    }
    let geometry = buildMsdfGeometryCpu(
      source.positions,
      source.uvs,
      source.indices,
      text.text,
    );
    if (geometry == null) {
      return null;
    }
    if (!geometry.expanded) {
      const expanded = expandIndexedMsdfTriangles(
        geometry.positions3D,
        geometry.uvs,
        geometry.indices!,
      );
      geometry = {
        ...geometry,
        ...expanded,
        expanded: true,
        indices: null,
        triangleCount: expanded.vertexCount / 3,
      };
    }
    this.uiTextCpuGeometries.set(source, {
      geometry,
      version: source.version,
    });
    return geometry;
  }

  private updateOrCreateDynamicMesh(
    existing: DynamicNativeMesh | null,
    vertexCount: number,
    positions: Float32Array,
    uvs: Float32Array,
    normals: Float32Array,
    colors: Uint8Array,
  ): DynamicNativeMesh {
    if (existing !== null && existing.vertexCount === vertexCount) {
      raylib.H.UpdateMeshBuffer(
        existing.mesh,
        0,
        bufferPointer(positions.subarray(0, vertexCount * 3)),
        vertexCount * 3 * Float32Array.BYTES_PER_ELEMENT,
        0,
      );
      raylib.H.UpdateMeshBuffer(
        existing.mesh,
        1,
        bufferPointer(uvs.subarray(0, vertexCount * 2)),
        vertexCount * 2 * Float32Array.BYTES_PER_ELEMENT,
        0,
      );
      raylib.H.UpdateMeshBuffer(
        existing.mesh,
        2,
        bufferPointer(normals.subarray(0, vertexCount * 3)),
        vertexCount * 3 * Float32Array.BYTES_PER_ELEMENT,
        0,
      );
      raylib.H.UpdateMeshBuffer(
        existing.mesh,
        3,
        bufferPointer(colors.subarray(0, vertexCount * 4)),
        vertexCount * 4 * Uint8Array.BYTES_PER_ELEMENT,
        0,
      );
      return existing;
    }

    if (existing !== null) {
      this.unloadNativeMesh(existing);
    }
    const meshHandle = raylibBindings.Mesh.createPointer({
      vertexCount,
      triangleCount: vertexCount / 3,
      vertices: pointerAddress(positions.subarray(0, vertexCount * 3)),
      texcoords: pointerAddress(uvs.subarray(0, vertexCount * 2)),
      texcoords2: ZERO_POINTER,
      normals: pointerAddress(normals.subarray(0, vertexCount * 3)),
      tangents: ZERO_POINTER,
      colors: pointerAddress(colors.subarray(0, vertexCount * 4)),
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
    return { mesh: sanitized, vertexCount };
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
    colorWrite: asset.state.colorWrite !== false,
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
    hasTextureLoc: raylib.H.GetShaderLocation(shader, "uHasTexture"),
    uvTransformLoc: raylib.H.GetShaderLocation(shader, "uUvTransform"),
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
  return {
    shader,
    mvpLoc: raylib.H.GetShaderLocation(shader, "mvp"),
  };
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
      point === undefined && light.type === "point" &&
      light.position !== undefined
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

/**
 * uikit colors originate as `THREE.Color`, so they arrive in Three's **working**
 * space (linear-sRGB while `ColorManagement` is enabled) rather than as the
 * authored sRGB value. Writing them straight to the framebuffer renders every
 * surface far too dark and shifts saturated hues — `#ffc300` reaches the screen
 * as `#ff8b00`.
 *
 * raythree converts on the way out of extraction so its IR is sRGB-encoded
 * (see `MaterialAsset.baseColor`); the uikit snapshot bypasses raythree, so it
 * has to be converted here to keep the two paths on the same contract. Every
 * shader then just writes the color it is handed.
 *
 * No-op when `ColorManagement` is disabled, since the value is already sRGB.
 */
function linearToSrgbChannel(value: number): number {
  if (!THREE.ColorManagement.enabled) return value;
  return value <= 0.0031308 ? value * 12.92 : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
}

function toShaderColor(
  color: [number, number, number, number],
): [number, number, number, number] {
  return [
    linearToSrgbChannel(color[0] / 255),
    linearToSrgbChannel(color[1] / 255),
    linearToSrgbChannel(color[2] / 255),
    // Alpha is a coverage weight, not light: it must not be transfer-encoded.
    color[3] / 255,
  ];
}

/**
 * Does this panel occupy the same rectangle as this image?
 *
 * Used to place an image directly after the panel it fills in the draw order.
 * Both are compared in world space: the image's `Content` box is laid out to the
 * same rect as the panel, so their translations coincide and their extents match
 * once the panel's px size is scaled by the shared px-to-world factor.
 */
function panelMatchesImage(
  panel: WebXRRaythreeUiSnapshot["panels"][number],
  image: WebXRRaythreeUiSnapshot["images"][number],
): boolean {
  const panelWidth = Number(panel.data[14] ?? 0);
  const panelHeight = Number(panel.data[15] ?? 0);
  if (panelWidth <= 0 || panelHeight <= 0) {
    return false;
  }
  // Same box in px, within a pixel of rounding.
  if (
    Math.abs(panelWidth - image.width) > 1 ||
    Math.abs(panelHeight - image.height) > 1
  ) {
    return false;
  }
  // ...and in the same place. The tolerance is a fraction of the panel's own
  // world size, so it scales with the UI rather than assuming a unit system.
  const scale = Math.hypot(
    image.worldMatrix[0] ?? 0,
    image.worldMatrix[1] ?? 0,
    image.worldMatrix[2] ?? 0,
  );
  const tolerance = Math.max(scale * 0.05, 1e-4);
  return Math.abs((panel.worldMatrix[12] ?? 0) - (image.worldMatrix[12] ?? 0)) < tolerance &&
    Math.abs((panel.worldMatrix[13] ?? 0) - (image.worldMatrix[13] ?? 0)) < tolerance &&
    Math.abs((panel.worldMatrix[14] ?? 0) - (image.worldMatrix[14] ?? 0)) < tolerance;
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
  if (Array.isArray(value)) {
    return Float32Array.from(value as ArrayLike<number>);
  }
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
  const useExpandedTriangles = WEBXR_RAYTHREE_TEXT_FORCE_NON_INDEXED ||
    topology.maxIndex > 65535;
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
    assertMsdfConversionInvariants(
      positions2D,
      positions3D,
      uvs,
      indices,
      label ?? "<text>",
    );
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
    const max = value.reduce(
      (acc, entry) => Math.max(acc, Number(entry) || 0),
      0,
    );
    return max > 65535
      ? Uint32Array.from(value as ArrayLike<number>)
      : Uint16Array.from(value as ArrayLike<number>);
  }
  if (value != null && typeof value === "object") {
    const maybeLength = (value as { length?: number }).length;
    if (typeof maybeLength === "number") {
      const materialized = Array.from(value as ArrayLike<number>);
      const max = materialized.reduce(
        (acc, entry) => Math.max(acc, Number(entry) || 0),
        0,
      );
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
): {
  maxIndex: number;
  minIndex: number;
  indexCount: number;
  vertexCount: number;
} {
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
  topology: {
    maxIndex: number;
    minIndex: number;
    indexCount: number;
    vertexCount: number;
  },
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
      throw new Error(
        `[msdf-assert] ${label}: uv out of range at i=${i / 2} uv=(${u},${v})`,
      );
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
    if (
      Math.abs(px - rx) > 1e-6 || Math.abs(py - ry) > 1e-6 ||
      Math.abs(rz) > 1e-6
    ) {
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
    const raw = new Deno.UnsafePointerView(vboPointer).getArrayBuffer(
      RL_MESH_VBO_COUNT * 4,
    );
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

function prepareGeometryBuffers(
  asset: GeometryAsset,
): PreparedGeometryBuffers | null {
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
    throw new Error(
      `Geometry ${asset.id} requested indexed expansion without an index buffer.`,
    );
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

function readTuple(
  array: ArrayLike<number>,
  index: number,
  itemSize: number,
): number[] {
  const start = index * itemSize;
  return Array.from(
    { length: itemSize },
    (_, offset) => Number(array[start + offset] ?? 0),
  );
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

function toColorTuple(
  array: ArrayLike<number>,
  index: number,
): [number, number, number, number] {
  const offset = index * 4;
  const rgba = [
    array[offset],
    array[offset + 1],
    array[offset + 2],
    array[offset + 3],
  ];
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

function bufferPointer(value: unknown): raylibBindings.VoidPointer {
  return (Deno.UnsafePointer.of(value as BufferSource) ??
    ZERO_POINTER) as unknown as raylibBindings.VoidPointer;
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
  rlColorMask: {
    parameters: ["bool", "bool", "bool", "bool"];
    result: "void";
  };
};

function getUiRlglSymbols(): Deno.DynamicLibrary<UiRlglSymbols>["symbols"] {
  return raylibBindings.getRaylibSymbols() as unknown as Deno.DynamicLibrary<
    UiRlglSymbols
  >["symbols"];
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

function setUiColorMaskEnabled(enabled: boolean): void {
  getUiRlglSymbols().rlColorMask(enabled, enabled, enabled, enabled);
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
// Optional image fill. With uHasTexture at 0 this shader behaves exactly as it
// did before, so panels and images share one rounded-rect/border/clip path and
// an image's corners cannot drift from a panel's.
uniform sampler2D texture0;
uniform float uHasTexture;
// xy = uv scale, zw = uv offset. Computed CPU-side so the image can cover its
// panel -- keeping its aspect ratio -- instead of stretching to fit.
uniform vec4 uUvTransform;

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
  if (uHasTexture > 0.5) {
    // uvFlipped exists for the SDF's coordinate convention; sampling wants the
    // raw uv, since raylib uploads PNG rows top-down. Using the flipped one
    // mirrors the image vertically. (No backticks in here: this whole shader is
    // a JS template literal and one would terminate it.)
    mainColor = texture(texture0, fragUv * uUvTransform.xy + uUvTransform.zw).rgb;
  }
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
uniform mat4 mvp;
void main() {
  fragUv = vertexTexCoord;
  gl_Position = mvp * vec4(vertexPosition, 1.0);
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
