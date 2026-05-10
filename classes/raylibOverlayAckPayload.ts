/** Timings for one Raylib overlay render/present pass. */
export type RaylibOverlayFrameAckPayload = {
  /** Handler wall time from before Raylib render through after `SetOverlayTexture`. */
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
  /** Raylib uikit: `P*V` + sort panel/text lists (CPU before first UI `DrawMesh`). */
  renderLeftUiSortPrepMs: number;
  /** Per-panel shader uniforms + `DrawMesh` for rounded rects. */
  renderLeftUiPanelsMs: number;
  /** Per-text MSDF `DrawMesh`. */
  renderLeftUiTextMs: number;
  renderLeftEndMs: number;
  renderRightSyncMs: number;
  renderRightPrepMs: number;
  renderRightOpaqueMs: number;
  renderRightXparentMs: number;
  renderRightUiMs: number;
  renderRightUiSortPrepMs: number;
  renderRightUiPanelsMs: number;
  renderRightUiTextMs: number;
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
  /** From uikit snapshot (`ui.panels.length`); same value for both eyes. */
  uiPanelCount: number;
  uiTextCount: number;
  /** Panels that passed cull and issued `DrawMesh` (per eye; should match L/R). */
  uiPanelDrawn: number;
  uiTextDrawn: number;
};
