import { dirname, join } from "@std/path";
import {
  normalizeSpatialLayout,
  type SpatialGraph,
  type SpatialTransform,
} from "./spatialGraph.ts";

export const SPATIAL_LAYOUT_VERSION = 1;
export const SPATIAL_LAYOUT_FILENAME = "spatial-layout.json";

type SpatialLayoutEnvelope = {
  version: typeof SPATIAL_LAYOUT_VERSION;
  graph: SpatialGraph;
};

function record(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function finiteTuple(value: unknown, length: number): boolean {
  return Array.isArray(value) && value.length === length &&
    value.every((entry) => typeof entry === "number" && Number.isFinite(entry));
}

function transform(value: unknown): value is SpatialTransform {
  return record(value) && finiteTuple(value.position, 3) && finiteTuple(value.rotation, 3) &&
    finiteTuple(value.scale, 3);
}

function constraint(value: unknown): boolean {
  if (!record(value) || value.kind !== "hinge") return false;
  return typeof value.attachmentSlotId === "string" &&
    (value.axis === "x" || value.axis === "y" || value.axis === "z") &&
    typeof value.angle === "number" && Number.isFinite(value.angle) &&
    finiteTuple(value.limits, 2) && finiteTuple(value.parentPivot, 3) &&
    finiteTuple(value.childPivot, 3);
}

function validGraph(value: unknown): value is SpatialGraph {
  if (
    !record(value) || !record(value.nodes) || !record(value.hitboxes) ||
    !Number.isInteger(value.nextDisplayOrdinal) || !Number.isInteger(value.nextControlOrdinal)
  ) return false;

  const nodeIds = new Set(Object.keys(value.nodes));
  for (const [id, candidate] of Object.entries(value.nodes)) {
    if (
      !record(candidate) || candidate.id !== id ||
      (candidate.kind !== "display" && candidate.kind !== "keyboard" &&
        candidate.kind !== "control") ||
      (candidate.parentId !== null && typeof candidate.parentId !== "string") ||
      typeof candidate.originId !== "string" || !transform(candidate.localTransform) ||
      (candidate.constraint != null && !constraint(candidate.constraint)) ||
      (candidate.onParentDelete !== "preserve" && candidate.onParentDelete !== "cascade")
    ) return false;
    if (
      candidate.kind === "display" && candidate.toolbarSidePreference != null &&
      candidate.toolbarSidePreference !== "left" && candidate.toolbarSidePreference !== "right"
    ) return false;
    if (candidate.parentId != null && !nodeIds.has(candidate.parentId)) return false;
    if (
      candidate.kind === "display" &&
      (!Number.isInteger(candidate.ordinal) || candidate.ordinal as number <= 0)
    ) return false;
    if (
      candidate.kind === "keyboard" &&
      (!record(candidate.snapSource) || candidate.snapSource.shape !== "box" ||
        !finiteTuple(candidate.snapSource.size, 3) ||
        !transform(candidate.snapSource.localTransform))
    ) return false;
    if (
      candidate.kind === "control" &&
      (typeof candidate.targetId !== "string" ||
        (candidate.action !== "spawn-display" && candidate.action !== "release-hinge" &&
          candidate.action !== "detach"))
    ) return false;
  }

  for (const [id, candidate] of Object.entries(value.hitboxes)) {
    if (
      !record(candidate) || candidate.id !== id || typeof candidate.ownerId !== "string" ||
      !nodeIds.has(candidate.ownerId) || candidate.shape !== "box" ||
      !finiteTuple(candidate.size, 3) || !transform(candidate.localTransform) ||
      (candidate.side !== "left" && candidate.side !== "right" && candidate.side !== "top" &&
        candidate.side !== "bottom") ||
      !Array.isArray(candidate.accepts) ||
      !candidate.accepts.every((kind) =>
        kind === "display" || kind === "keyboard" || kind === "control"
      ) || !record(candidate.attachments) ||
      (candidate.disabledKinds !== undefined &&
        (!Array.isArray(candidate.disabledKinds) ||
          !candidate.disabledKinds.every((kind) =>
            kind === "display" || kind === "keyboard" || kind === "control"
          )))
    ) return false;
    for (const [kind, attachment] of Object.entries(candidate.attachments)) {
      if (
        (kind !== "display" && kind !== "keyboard" && kind !== "control") ||
        !record(attachment) || attachment.kind !== "hinge" ||
        (attachment.axis !== "x" && attachment.axis !== "y" && attachment.axis !== "z") ||
        typeof attachment.angle !== "number" || !Number.isFinite(attachment.angle) ||
        !finiteTuple(attachment.limits, 2) || !finiteTuple(attachment.parentPivot, 3)
      ) return false;
    }
  }

  for (const id of nodeIds) {
    const ancestors = new Set<string>([id]);
    let parentId = (value.nodes[id] as Record<string, unknown>).parentId as string | null;
    while (parentId != null) {
      if (ancestors.has(parentId)) return false;
      ancestors.add(parentId);
      parentId = (value.nodes[parentId] as Record<string, unknown>).parentId as string | null;
    }
  }

  for (const candidate of Object.values(value.nodes)) {
    if (!record(candidate)) return false;
    if (!record(candidate.constraint)) continue;
    if (!((candidate.constraint.attachmentSlotId as string) in value.hitboxes)) return false;
  }
  return true;
}

export function parseSpatialLayout(text: string): SpatialGraph | null {
  try {
    const envelope: unknown = JSON.parse(text);
    if (
      !record(envelope) || envelope.version !== SPATIAL_LAYOUT_VERSION ||
      !validGraph(envelope.graph)
    ) return null;
    return envelope.graph;
  } catch {
    return null;
  }
}

export function serializeSpatialLayout(graph: SpatialGraph): string {
  const envelope: SpatialLayoutEnvelope = { version: SPATIAL_LAYOUT_VERSION, graph };
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

export function spatialLayoutPersistenceEnabled(args: string[] = Deno.args): boolean {
  return args.includes("--desktop-control-child") || !args.includes("--desktop");
}

export function getSpatialLayoutPath(): string {
  const override = Deno.env.get("PETPLAY_SPATIAL_LAYOUT_PATH");
  if (override) return override;
  const configHome = Deno.env.get("XDG_CONFIG_HOME") ??
    join(Deno.env.get("HOME") ?? Deno.cwd(), ".config");
  return join(configHome, "petplay", SPATIAL_LAYOUT_FILENAME);
}

export function loadSpatialLayoutSync(path = getSpatialLayoutPath()): SpatialGraph | null {
  try {
    const graph = parseSpatialLayout(Deno.readTextFileSync(path));
    return graph == null ? null : normalizeSpatialLayout(graph);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    console.warn(`[spatial-layout] could not load ${path}`, error);
    return null;
  }
}

export function saveSpatialLayoutSync(
  graph: SpatialGraph,
  path = getSpatialLayoutPath(),
): void {
  const temporaryPath = `${path}.${Deno.pid}.tmp`;
  try {
    Deno.mkdirSync(dirname(path), { recursive: true });
    Deno.writeTextFileSync(temporaryPath, serializeSpatialLayout(graph));
    Deno.renameSync(temporaryPath, path);
  } catch (error) {
    try {
      Deno.removeSync(temporaryPath);
    } catch {
      // Nothing temporary was left behind.
    }
    console.warn(`[spatial-layout] could not save ${path}`, error);
  }
}

/** Named layouts are numbered slots, kept beside the live layout in `layouts/`. */
export const LAYOUT_SLOT_COUNT = 3;

export function getLayoutSlotPath(slot: number, livePath = getSpatialLayoutPath()): string {
  if (!Number.isInteger(slot) || slot < 1 || slot > LAYOUT_SLOT_COUNT) {
    throw new Error(`layout slot must be 1..${LAYOUT_SLOT_COUNT}, got ${slot}`);
  }
  return join(dirname(livePath), "layouts", `slot-${slot}.json`);
}

/** What the wrist shows for a saved slot, so slots can be told apart without names. */
export type LayoutSlotSummary = { displays: number; savedAt: number | null };

/** A summary per slot that holds a loadable layout, `null` for the rest; index 0 = slot 1. */
export function listLayoutSlots(livePath = getSpatialLayoutPath()): (LayoutSlotSummary | null)[] {
  return Array.from({ length: LAYOUT_SLOT_COUNT }, (_, index) => {
    const path = getLayoutSlotPath(index + 1, livePath);
    const graph = loadSpatialLayoutSync(path);
    if (graph == null) return null;
    let savedAt: number | null = null;
    try {
      savedAt = Deno.statSync(path).mtime?.getTime() ?? null;
    } catch {
      // Loaded a moment ago; a missing mtime only loses the time from the label.
    }
    const displays = Object.values(graph.nodes).filter((node) => node.kind === "display").length;
    return { displays, savedAt };
  });
}
