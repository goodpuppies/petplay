/** Timings from `webxrOverlay` → `webxr` after each `RENDERWEBXRRAYTHREEFRAME`. */
export type RaylibOverlayFrameAckPayload = {
  /** `RENDERWEBXRRAYTHREEFRAME` handler wall time (receive → after `SetOverlayTexture`). */
  handlerMs: number;
  /** `WebXROverlayRaylib.renderRaythreeFrame` (two eyes + varggles combine to output texture). */
  renderMs: number;
  /** Overlay ensure / `setTextureHandle` + `SetOverlayTexture` (not OpenVR tracking). */
  openvrMs: number;
  /** One offscreen eye: `syncAssets` + scene + UI (wall). */
  renderLeftMs: number;
  renderRightMs: number;
  /**
   * Per-eye wall breakdown (sums to `frameMs` when added with `*SyncMs`).
   * Prep = lighting, depth-sort lists, `Clear` / `BeginMode3D` / `rlSetMatrix*`.
   * Opaque = solid instance loop. Xparent = `BeginBlend` + back-to-front transparents.
   * Ui = R3F overlay quads + text. End = `EndBlend` / `EndMode3D`.
   */
  renderLeftSyncMs: number;
  renderLeftPrepMs: number;
  renderLeftOpaqueMs: number;
  renderLeftXparentMs: number;
  renderLeftUiMs: number;
  renderLeftEndMs: number;
  renderRightSyncMs: number;
  renderRightPrepMs: number;
  renderRightOpaqueMs: number;
  renderRightXparentMs: number;
  renderRightUiMs: number;
  renderRightEndMs: number;
  /** Varggles shader: two `DrawTexturePro` into `outputTarget` (wall). */
  renderCombineMs: number;
  /** Sum of `syncAssets` over both eyes (CPU + `UploadMesh` for listed deltas). */
  renderSyncMs: number;
  /** Sum of `renderFrame` over both eyes (scene + UI `DrawMesh`). */
  renderDrawMs: number;
  /**
   * Sum of `extraction.assets.geometries.length` (L+R). If avg ≫ 0 every frame, raythree is re-emitting
   * many geometry entries per frame and the overlay will re-upload (expect high `renderSyncMs`).
   */
  batchGeometries: number;
  /** Sum of `extraction.assets.materials.length` (L+R). */
  batchMaterials: number;
};
