import React, { useMemo, useState } from "react";
import { TextDistanceProbe, type TextProbeDistance } from "./textDistanceProbe.tsx";
import { Button, Container } from "../../../submodules/threewebxrwebgpudeno/webgpu-uikit.tsx";
import { setSetting, useSetting } from "../../settings.ts";
import {
  getTextRenderingSettings,
  glyphTextAvailable,
  pathfinderTextAvailable,
  windfoilTextAvailable,
} from "../../textRenderingSettings.ts";
import { Pill } from "../ui/primitives.tsx";
import { Text } from "../ui/text.tsx";
import { COLOR, INNER_GAP, RADIUS } from "../ui/tokens.ts";

/** Same samples, placement and dimensions while global rendering settings change. */
export function TextComparisonView({ onBack }: { onBack: () => void }) {
  useSetting("textRenderer");
  useSetting("panoramaFilter");
  useSetting("glyphCoverageExponent");
  useSetting("glyphWeightPixels");
  useSetting("glyphAaWidth");
  const selection = getTextRenderingSettings();
  const vectorAvailable = useMemo(pathfinderTextAvailable, []);
  const glyphAvailable = useMemo(glyphTextAvailable, []);
  const windfoilAvailable = useMemo(windfoilTextAvailable, []);
  const analyticActive = selection.renderer === "glyph" || selection.renderer === "windfoil";
  const [probe, setProbe] = useState<TextProbeDistance | null>(null);
  return (
    <>
      {probe && <TextDistanceProbe distance={probe} />}
      <Container flexDirection="column" gap={INNER_GAP} width={448}>
        <Container flexDirection="row" alignItems="center" gap={INNER_GAP}>
          <Button paddingX={0} paddingY={0} backgroundOpacity={0} onClick={onBack}>
            <Pill slots={1} units={2} fontSize={14}>BACK</Pill>
          </Button>
          <Pill slots={3} units={2} tone="accent" fontSize={14}>TEXT COMPARISON</Pill>
        </Container>
        <Container flexDirection="row" alignItems="center" justifyContent="space-between">
          <Text fontSize={14} color={COLOR.ink}>Text</Text>
          <Container flexDirection="row" gap={INNER_GAP}>
            <Pill
              slots={1}
              units={2}
              fontSize={13}
              tone={selection.renderer === "msdf" ? "accent" : "outline"}
              onClick={() => setSetting("textRenderer", "msdf")}
            >
              MSDF
            </Pill>
            <Pill
              slots={1}
              units={2}
              fontSize={13}
              disabled={!vectorAvailable}
              tone={selection.renderer === "pathfinder" ? "accent" : "outline"}
              onClick={() => setSetting("textRenderer", "pathfinder")}
            >
              VECTOR
            </Pill>
            <Pill
              slots={1}
              units={2}
              fontSize={12}
              disabled={!glyphAvailable}
              tone={selection.renderer === "glyph" ? "accent" : "outline"}
              onClick={() => setSetting("textRenderer", "glyph")}
            >
              GLYPH
            </Pill>
            <Pill slots={1} units={2} fontSize={12}
              disabled={!windfoilAvailable}
              tone={selection.renderer === "windfoil" ? "accent" : "outline"}
              onClick={() => setSetting("textRenderer", "windfoil")}>
              WIND
            </Pill>
          </Container>
        </Container>
        <Container flexDirection="row" alignItems="center" justifyContent="space-between">
          <Text fontSize={14} color={COLOR.ink}>Filtering</Text>
          <Container flexDirection="row" gap={INNER_GAP}>
            <Pill
              slots={2}
              units={2}
              fontSize={13}
              tone={selection.panoramaFilter === "linear" ? "accent" : "outline"}
              onClick={() => setSetting("panoramaFilter", "linear")}
            >
              LINEAR
            </Pill>
            <Pill
              slots={2}
              units={2}
              fontSize={13}
              tone={selection.panoramaFilter === "catmull-rom" ? "accent" : "outline"}
              onClick={() => setSetting("panoramaFilter", "catmull-rom")}
            >
              SHARP
            </Pill>
          </Container>
        </Container>
        <Container flexDirection="row" alignItems="center" justifyContent="space-between">
          <Text fontSize={14} color={COLOR.ink}>Coverage</Text>
          <Container flexDirection="row" gap={INNER_GAP}>
            {[1, 0.85, 0.7].map((value) => (
              <Pill key={value} slots={1} units={1} fontSize={12}
                disabled={!analyticActive}
                tone={selection.glyphCoverageExponent === value ? "accent" : "outline"}
                onClick={() => setSetting("glyphCoverageExponent", value)}>
                {value.toFixed(2)}
              </Pill>
            ))}
          </Container>
        </Container>
        <Container flexDirection="row" alignItems="center" justifyContent="space-between">
          <Text fontSize={14} color={COLOR.ink}>Weight (px)</Text>
          <Container flexDirection="row" gap={INNER_GAP}>
            {[0, 0.125, 0.25].map((value) => (
              <Pill key={value} slots={1} units={1} fontSize={12}
                disabled={!analyticActive}
                tone={selection.glyphWeightPixels === value ? "accent" : "outline"}
                onClick={() => setSetting("glyphWeightPixels", value)}>
                {String(value)}
              </Pill>
            ))}
          </Container>
        </Container>
        <Container flexDirection="row" alignItems="center" justifyContent="space-between">
          <Text fontSize={14} color={COLOR.ink}>AA width</Text>
          <Container flexDirection="row" gap={INNER_GAP}>
            {[1, 0.85, 0.7].map((value) => (
              <Pill key={value} slots={1} units={1} fontSize={12}
                disabled={!analyticActive}
                tone={selection.glyphAaWidth === value ? "accent" : "outline"}
                onClick={() => setSetting("glyphAaWidth", value)}>
                {`${Math.round(value * 100)}%`}
              </Pill>
            ))}
          </Container>
        </Container>
        <Container
          flexDirection="column"
          gap={INNER_GAP}
          padding={INNER_GAP}
          borderRadius={RADIUS.tile}
          backgroundColor={COLOR.tile}
          backgroundOpacity={1}
        >
          <Text fontSize={28} color={COLOR.ink}>@@@ @example.fi</Text>
          <Text fontSize={18} color={COLOR.ink}>a@g.fi Il1 O0 agpq</Text>
          <Text fontSize={14} color={COLOR.ink}>@ () [] 0123456789</Text>
        </Container>
        <Container
          padding={INNER_GAP}
          borderRadius={RADIUS.tile}
          backgroundColor={COLOR.ink}
          backgroundOpacity={1}
        >
          <Text fontSize={18} color={COLOR.ground}>@@@ Il1 O0 agpq</Text>
        </Container>
        <Text fontSize={12} color={COLOR.inkDim}>Changes apply immediately to the scene.</Text>
        <Container flexDirection="row" alignItems="center" justifyContent="space-between">
          <Text fontSize={14} color={COLOR.ink}>Depth probe</Text>
          <Container flexDirection="row" gap={INNER_GAP}>
            <Pill
              slots={1}
              units={2}
              fontSize={12}
              tone={probe === null ? "accent" : "outline"}
              onClick={() => setProbe(null)}
            >
              OFF
            </Pill>
            <Pill
              slots={1}
              units={2}
              fontSize={12}
              tone={probe === "near" ? "accent" : "outline"}
              onClick={() => setProbe("near")}
            >
              NEAR
            </Pill>
            <Pill
              slots={1}
              units={2}
              fontSize={12}
              tone={probe === "far" ? "accent" : "outline"}
              onClick={() => setProbe("far")}
            >
              FAR
            </Pill>
          </Container>
        </Container>
        <Text fontSize={12} color={COLOR.inkDim}>0.35 m / 1.40 m - same apparent size.</Text>
      </Container>
    </>
  );
}
