/**
 * PetPlay's writer into the raythree scene store (markdown/scene-stream).
 *
 * Maps `renderAnchor`s onto tracked nodes, so anchored items are stored relative to the space
 * that carries them and never change while only that space moves. The renderer fills in the
 * tracked nodes' poses at draw time. UI item kinds (panels, texts, images) follow in P3; for now
 * this writes meshes, lights and assets.
 */
import type { ExtractionResult, RenderInstance } from "../submodules/raythree/src/lib.ts";
import {
  ExtractionStoreWriter,
  identityMatrix,
  type ItemPlacement,
  type RowId,
  SceneStore,
  type TrackedPair,
  type TrackedSpace,
  WORLD_NODE,
} from "../submodules/raythree/src/store/mod.ts";
import { type Anchored, followKey, type RenderAnchor, type RenderAnchorSpace } from "./overlayRenderTracking.ts";

/** Fixed node ids for PetPlay's tracked spaces, in every store this writer feeds. */
export const TRACKED_NODES: Readonly<Record<RenderAnchorSpace, RowId>> = {
  head: 1,
  "left-hand": 2,
  "right-hand": 3,
  "left-ray": 4,
  "right-ray": 5,
};

const TRACKED_SPACE: Readonly<Record<RenderAnchorSpace, TrackedSpace>> = {
  head: "viewer",
  "left-hand": "left-grip",
  "right-hand": "right-grip",
  "left-ray": "left-ray",
  "right-ray": "right-ray",
};

/** Two-hand carry frames get node ids from here up. */
const FIRST_PAIR_NODE = 100;

type PetplayInstance = RenderInstance & Anchored & {
  vrcCameraHidden?: boolean;
  passthroughKey?: boolean;
  passthroughCutout?: boolean;
};

export class PetplaySceneStoreWriter {
  private readonly meshes: ExtractionStoreWriter;
  private readonly pairNodes = new Map<string, RowId>();
  private nextPairNode = FIRST_PAIR_NODE;
  private usedPairs = new Set<string>();

  constructor(readonly store: SceneStore = new SceneStore()) {
    this.meshes = new ExtractionStoreWriter(store, {
      place: (instance) => this.place(instance as PetplayInstance),
      extensions: (instance) => extensions(instance as PetplayInstance),
    });
    store.transaction(() => {
      for (const [space, id] of Object.entries(TRACKED_NODES)) {
        store.write("nodes", id, {
          structure: { parent: WORLD_NODE, tracked: TRACKED_SPACE[space as RenderAnchorSpace] },
          transform: identityMatrix(),
        });
      }
    });
  }

  /** Writes one extracted frame (the left eye's: extraction is eye invariant). */
  write(extraction: ExtractionResult): void {
    this.store.transaction(() => {
      this.usedPairs = new Set();
      this.meshes.write(extraction);
      for (const [key, id] of this.pairNodes) {
        if (this.usedPairs.has(key)) continue;
        this.store.remove("nodes", id);
        this.pairNodes.delete(key);
      }
    });
  }

  private place(instance: PetplayInstance): ItemPlacement {
    const anchor = instance.renderAnchor;
    if (!anchor) return { node: WORLD_NODE, matrix: instance.worldMatrix };
    // A one-hand carry is held in the pointer's own pose, which is what its tracked node is.
    const node = anchor.pair ? this.pairNode(anchor) : TRACKED_NODES[anchor.space];
    return { node, matrix: anchor.localMatrix };
  }

  private pairNode(anchor: RenderAnchor): RowId {
    const pair = anchor.pair!;
    const key = followKey(anchor.space, pair);
    this.usedPairs.add(key);
    let id = this.pairNodes.get(key);
    if (id === undefined) {
      id = this.nextPairNode++;
      this.pairNodes.set(key, id);
    }
    const point = (p: ArrayLike<number>) => [p[0]!, p[1]!, p[2]!] as [number, number, number];
    const tracked: TrackedPair = {
      first: TRACKED_SPACE[anchor.space],
      second: TRACKED_SPACE[pair.space],
      points: [point(pair.points[0]), point(pair.points[1])],
    };
    this.store.write("nodes", id, {
      structure: { parent: WORLD_NODE, tracked },
      transform: identityMatrix(),
    });
    return id;
  }
}

function extensions(instance: PetplayInstance): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (instance.vrcCameraHidden) out["petplay.vrcCameraHidden"] = true;
  if (instance.passthroughKey) out["petplay.passthroughKey"] = true;
  if (instance.passthroughCutout) out["petplay.passthroughCutout"] = true;
  return out;
}
