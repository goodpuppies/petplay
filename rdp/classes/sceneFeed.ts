/**
 * One tab's scene feed: extracts a three.js scene into a raythree scene store and hands out the
 * deltas the tab lacks, the way the scene stream does (`classes/sceneStreamServer.ts`):
 *
 * - "latest since ack": at most one delta in flight; the next one covers everything since the
 *   tab's last ack, however many frames that was;
 * - a snapshot to start, after `resync`, or when an ack is overdue;
 * - the journal is truncated to the ack, since there is one consumer.
 */
import * as THREE from "three";
import { RaythreeExtractor } from "../../submodules/raythree/src/lib.ts";
import { encodeDelta, SceneStore } from "../../submodules/raythree/src/store/mod.ts";
import { anchoredLowerers } from "../../classes/overlayRenderTracking.ts";
import { extractWebXRRaythreeUi } from "../../classes/webxrRaythreeUi.ts";
import { PetplaySceneStoreWriter } from "../../classes/sceneStoreWriter.ts";

const ACK_TIMEOUT_MS = 5000;

export class SceneFeed {
  readonly store = new SceneStore();
  private readonly writer = new PetplaySceneStoreWriter(this.store);
  private readonly extractor = new RaythreeExtractor({ lowerers: anchoredLowerers() });
  private ack: number | null = null;
  private inFlightSince: number | null = null;
  deltasSent = 0;
  bytesSent = 0;

  /** Extract `scene` as seen by `camera` into the store. */
  write(scene: THREE.Scene, camera: THREE.Camera): void {
    scene.updateMatrixWorld(true);
    const extraction = this.extractor.extract(scene, camera, {
      skipSceneMatrixWorldUpdate: true,
    });
    this.writer.write(extraction, extractWebXRRaythreeUi(scene), scene);
  }

  /** The bytes to send now, or null if the tab is current or a delta is still in flight. */
  next(now = performance.now()): Uint8Array | null {
    if (this.inFlightSince !== null) {
      if (now - this.inFlightSince < ACK_TIMEOUT_MS) return null;
      this.ack = null; // lost or stuck: start over from a snapshot
    }
    if (this.ack === this.store.tick) return null;
    const delta = (this.ack === null ? null : this.store.changesSince(this.ack)) ??
      this.store.snapshot();
    const bytes = encodeDelta(delta);
    this.inFlightSince = now;
    this.deltasSent++;
    this.bytesSent += bytes.byteLength;
    return bytes;
  }

  acked(tick: number): void {
    if (!Number.isInteger(tick) || tick < 0 || tick > this.store.tick) return;
    this.ack = tick;
    this.inFlightSince = null;
    this.store.truncateJournal(tick);
  }

  /** The tab's replica diverged or is new: the next delta is a snapshot. */
  resync(): void {
    this.ack = null;
    this.inFlightSince = null;
  }
}
