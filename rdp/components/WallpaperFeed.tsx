/**
 * WallpaperFeed: full-bleed background video surface (e.g. VRChat via `vrchatSource` or a
 * desktop feed) sitting at `z = 0` behind all floating windows and the taskbar.
 */
import React, { useEffect, useMemo } from "react";
import * as THREE from "three";
import { Container, Text } from "../../submodules/threewebxrwebgpudeno/webgpu-uikit.tsx";
import type { VideoSurfaceMarker } from "../../classes/sceneStoreWriter.ts";
import { useTabSize } from "../classes/browserTab.ts";
import type { FeedCrop } from "../classes/tabProtocol.ts";

export type WallpaperFeedProps = {
  /** Feed name in `ToTab.media.feeds`, or null when no wallpaper is active. */
  feedId: string | null;
  /** Intrinsic size of the feed once decoded (used for cover aspect fit). */
  feedSize?: { width: number; height: number } | null;
  /** Optional crop rect (e.g. left eye of side-by-side stereo). */
  crop?: FeedCrop;
  /** Label shown when no wallpaper stream is active. */
  label?: string;
  /** Called when the user clicks the empty wallpaper (e.g. unfocus active window). */
  onBackgroundClick?: () => void;
};

const FULL_CROP: FeedCrop = { x: 0, y: 0, width: 1, height: 1 };

export function WallpaperFeed(
  { feedId, feedSize, crop = FULL_CROP, label, onBackgroundClick }: WallpaperFeedProps,
) {
  const tab = useTabSize();
  const geometry = useMemo(() => new THREE.PlaneGeometry(1, 1), []);
  useEffect(() => () => geometry.dispose(), [geometry]);

  const marker = useMemo<VideoSurfaceMarker | null>(() => {
    if (!feedId) return null;
    return { feed: feedId, geometry, crop, opacity: 1 };
  }, [feedId, geometry, crop.x, crop.y, crop.width, crop.height]);

  // Cover-fit the wallpaper to the viewport while preserving aspect ratio.
  const size = useMemo(() => {
    if (!feedSize || feedSize.width <= 0 || feedSize.height <= 0) {
      return { width: tab.width, height: tab.height };
    }
    const feedAspect = (feedSize.width * crop.width) / (feedSize.height * crop.height);
    const tabAspect = tab.width / Math.max(1, tab.height);
    if (tabAspect > feedAspect) {
      return { width: tab.width, height: tab.width / feedAspect };
    }
    return { width: tab.height * feedAspect, height: tab.height };
  }, [tab.width, tab.height, feedSize?.width, feedSize?.height, crop.width, crop.height]);

  if (!marker) {
    return (
      <group position={[0, 0, 0]}>
        <Container
          sizeX={tab.width}
          sizeY={tab.height}
          pixelSize={1}
          width={tab.width}
          height={tab.height}
          backgroundColor="#10131a"
          alignItems="center"
          justifyContent="center"
          onClick={() => onBackgroundClick?.()}
        >
          <Text fontSize={14} color="#4e586b">
            {label ?? "PetPlay Compositor — open Apps in the taskbar below"}
          </Text>
        </Container>
      </group>
    );
  }

  return (
    <>
      <group
        position={[0, 0, 0]}
        scale={[size.width, size.height, 1]}
        userData={{ videoSurface: marker }}
      />
      <mesh
        position={[0, 0, 0.5]}
        scale={[tab.width, tab.height, 1]}
        userData={{ bridge: { kind: "skip" } }}
        onPointerDown={() => onBackgroundClick?.()}
      >
        <primitive object={geometry} attach="geometry" />
        <meshBasicMaterial visible={false} />
      </mesh>
    </>
  );
}
