/** Side-menu placement: the swap action exists only when its other edge is free. */
import type { PlaytestStep } from "../../utils/playtest.ts";
import {
  editSpatialGraph,
  getSpatialGraph,
} from "../../classes/environment/workspaceLayoutStore.ts";
import {
  deleteSpatialNode,
  displayToolbarSide,
  spawnHingedDisplay,
} from "../../classes/environment/spatialGraph.ts";
import { ICON_CODEPOINTS } from "../../classes/environment/ui/icons.tsx";
import { display, rootDisplayId, select, showWindows, toolbarButton } from "./lib/steps.ts";

export const steps: PlaytestStep[] = [
  showWindows,
  {
    name: "no-swap-above",
    run: async (ctx) => {
      const bar = await select(ctx, display(ctx));
      if (!ctx.expect(bar, "the menu is visible")) return;
      ctx.expect(
        !ctx.textObject(bar!, String.fromCodePoint(ICON_CODEPOINTS.arrow_forward)),
        "the above-screen menu has no side swap",
      );
    },
  },
  {
    name: "swap-both-ways",
    run: async (ctx) => {
      const id = rootDisplayId()!;
      editSpatialGraph((graph) => {
        // Real hosts may bootstrap several monitors, occupying a side already.
        let next = graph;
        for (const node of Object.values(graph.nodes)) {
          if (node.kind === "display" && node.id !== id) next = deleteSpatialNode(next, node.id);
        }
        return spawnHingedDisplay(next, id, "top");
      });
      await ctx.settle();
      await ctx.waitFor(
        () => ctx.textObject(display(ctx), String.fromCodePoint(ICON_CODEPOINTS.arrow_forward)),
        "the free opposite edge gets a swap button",
      );
      if (!await toolbarButton(ctx, "arrow_forward")) return;
      await ctx.waitFor(
        () => displayToolbarSide(getSpatialGraph()!, id) === "right",
        "the right arrow moves the menu right",
      );
      await ctx.waitFor(
        () => ctx.textObject(display(ctx), String.fromCodePoint(ICON_CODEPOINTS.arrow_back)),
        "the moved menu offers the return arrow",
      );
      if (!await toolbarButton(ctx, "arrow_back")) return;
      await ctx.waitFor(
        () => displayToolbarSide(getSpatialGraph()!, id) === "left",
        "the left arrow moves it back",
      );
    },
  },
  {
    name: "no-swap-into-occupied-side",
    run: async (ctx) => {
      editSpatialGraph((graph) => spawnHingedDisplay(graph, rootDisplayId()!, "right"));
      await ctx.settle();
      const bar = await select(ctx, display(ctx));
      if (!ctx.expect(bar, "the menu remains visible")) return;
      ctx.expect(
        !ctx.textObject(bar!, String.fromCodePoint(ICON_CODEPOINTS.arrow_forward)),
        "the right arrow disappears while that edge is occupied",
      );
    },
  },
];
