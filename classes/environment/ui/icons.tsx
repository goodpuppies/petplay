/**
 * Overlay icons.
 *
 * Icons are drawn as **text**, from a Material Icons MSDF atlas, rather than as
 * meshes or images. XSOverlay does the same thing for the same reason: an icon
 * font is a font, so a glyph takes the existing MSDF pipeline — measurement,
 * batching, tinting, clipping — and needs no image support anywhere in the
 * renderer. The only thing that had to become plural was the atlas.
 *
 * **Addressed by codepoint, not by ligature.** Material Icons resolves
 * `music_note` to a glyph through a ligature table, which is a text-shaping
 * feature; an MSDF atlas is keyed by codepoint and does no shaping. The mapping
 * below was extracted from the TTF itself (resolve the ligature, then find the
 * codepoint that reaches the same glyph id) rather than transcribed, so it is
 * accurate for this exact font file.
 *
 * Adding an icon means regenerating the atlas — it holds only the subset listed
 * here, not all 1507 glyphs. See `resources/fonts/material-icons/`.
 */
import React from "react";
import { Text } from "../../../submodules/threewebxrwebgpudeno/webgpu-uikit.tsx";

/** Icon name -> codepoint, for every glyph baked into the atlas. */
export const ICON_CODEPOINTS = {
  layers: 0xe53b,
  music_note: 0xe405,
  notifications: 0xe7f4,
  mic: 0xe029,
  mic_off: 0xe02b,
  desktop_windows: 0xe30c,
  settings: 0xe8b8,
  power_settings_new: 0xe8ac,
  skip_previous: 0xe045,
  skip_next: 0xe044,
  pause: 0xe034,
  play_arrow: 0xe037,
  shuffle: 0xe043,
  headset: 0xe310,
  videogame_asset: 0xe338,
  tune: 0xe429,
  battery_full: 0xe1a4,
  volume_up: 0xe050,
  close: 0xe5cd,
  arrow_back: 0xe5c4,
  check: 0xe5ca,
  wifi: 0xe63e,
  bluetooth: 0xe1a7,
  grid_view: 0xe9b0,
  visibility: 0xe8f4,
  visibility_off: 0xe8f5,

  // Actions for the contextual toolbar.
  add: 0xe145,
  delete: 0xe872,
  link_off: 0xe16f,
  link: 0xe157,
  refresh: 0xe5d5,
  open_with: 0xe89f,
  push_pin: 0xf10d,
  lock: 0xe897,
  lock_open: 0xe898,
  content_copy: 0xe14d,
  fullscreen: 0xe5d0,
  more_horiz: 0xe5d3,
  save: 0xe161,
  drag_indicator: 0xe945,
  keyboard: 0xe312,
  monitor: 0xef5b,
} as const;

export type IconName = keyof typeof ICON_CODEPOINTS;

/**
 * The atlas was generated at `size 80` with `lineHeight 80`, so a glyph fills
 * its em box. `Text` scales by `fontSize / lineHeight`, which means a requested
 * size comes out as the glyph's full height — no correction factor needed, in
 * contrast to Roboto where `lineHeight 84` exceeds the cap height.
 */
export function Icon(
  { name, size = 20, color = "#ffffff" }: {
    name: IconName;
    size?: number;
    color?: string;
  },
) {
  return (
    <Text font="material-icons" fontSize={size} color={color}>
      {String.fromCodePoint(ICON_CODEPOINTS[name])}
    </Text>
  );
}
