/**
 * Taskbar: docked bottom bar (`z = 400`) with a multi-machine window launcher popup,
 * wallpaper source selector (VRChat / desktop / none), and open-window pills.
 */
import React, { useState } from "react";
import { Container, Text } from "../../submodules/threewebxrwebgpudeno/webgpu-uikit.tsx";
import { useTabSize } from "../classes/browserTab.ts";
import type { WindowInfo } from "../classes/windowCapture.ts";
import type { SourceSummary } from "../mediaMux.ts";
import type { FloatingWindowData } from "./FloatingWindow.tsx";

export const TASKBAR_HEIGHT = 46;
export const TASKBAR_Z = 400;

export type TaskbarProps = {
  sources: SourceSummary[];
  windowsBySource: Record<string, WindowInfo[]>;
  openWindows: FloatingWindowData[];
  focusedWindowId: string | null;
  wallpaperLabel: string | null;
  wallpaperWindowId: string | null;
  vrBackgroundActive: boolean;
  viewerCount: number;
  onRefreshLauncher: () => void;
  onToggleVrBackground: () => void;
  onOpenWindow: (source: SourceSummary, window: WindowInfo) => void;
  onOpenDesktop: (source: SourceSummary) => void;
  onSelectWallpaper: (source: SourceSummary | null) => void;
  onSelectWindowWallpaper: (source: SourceSummary, window: WindowInfo) => void;
  onWindowPillClick: (id: string) => void;
};

export function Taskbar({
  sources,
  windowsBySource,
  openWindows,
  focusedWindowId,
  wallpaperLabel,
  wallpaperWindowId,
  vrBackgroundActive,
  viewerCount,
  onRefreshLauncher,
  onToggleVrBackground,
  onOpenWindow,
  onOpenDesktop,
  onSelectWallpaper,
  onSelectWindowWallpaper,
  onWindowPillClick,
}: TaskbarProps) {
  const tab = useTabSize();
  const [launcherOpen, setLauncherOpen] = useState(false);

  const barCy = -tab.height / 2 + TASKBAR_HEIGHT / 2;
  const popupW = Math.min(540, Math.max(320, tab.width - 32));
  const popupH = Math.min(460, Math.max(220, tab.height - TASKBAR_HEIGHT - 32));
  const popupCx = -tab.width / 2 + popupW / 2 + 12;
  const popupCy = -tab.height / 2 + TASKBAR_HEIGHT + popupH / 2 + 8;

  return (
    <>
      {/* Launcher popup above the taskbar */}
      {launcherOpen
        ? (
          <group position={[popupCx, popupCy, TASKBAR_Z + 10]}>
            <Container
              sizeX={popupW}
              sizeY={popupH}
              pixelSize={1}
              width={popupW}
              height={popupH}
              flexDirection="column"
              padding={12}
              gap={10}
              backgroundColor="#161b24"
              borderWidth={1}
              borderColor="#334155"
              borderRadius={10}
              overflow="scroll"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header */}
              <Container flexDirection="row" alignItems="center" gap={8}>
                <Text fontSize={14} color="#f1f5f9">Machines & Windows</Text>
                <Container flexGrow={1} />
                <Container
                  paddingX={8}
                  paddingY={4}
                  borderRadius={5}
                  backgroundColor="#263042"
                  onClick={() => onRefreshLauncher()}
                >
                  <Text fontSize={12} color="#cbd5e1">Refresh</Text>
                </Container>
                <Container
                  paddingX={8}
                  paddingY={4}
                  borderRadius={5}
                  backgroundColor="#263042"
                  onClick={() => setLauncherOpen(false)}
                >
                  <Text fontSize={12} color="#cbd5e1">Close</Text>
                </Container>
              </Container>

              {/* Wallpaper picker */}
              <Container flexDirection="column" gap={6} paddingBottom={6}>
                <Text fontSize={11} color="#94a3b8">WALLPAPER</Text>
                <Container flexDirection="row" flexWrap="wrap" gap={6}>
                  <Container
                    paddingX={8}
                    paddingY={4}
                    borderRadius={5}
                    backgroundColor={!wallpaperLabel ? "#3b82f6" : "#242c3c"}
                    onClick={() => {
                      onSelectWallpaper(null);
                      setLauncherOpen(false);
                    }}
                  >
                    <Text fontSize={12} color="#f1f5f9">None</Text>
                  </Container>
                  {sources.map((src) => (
                    <Container
                      key={`wp-${src.actor}`}
                      paddingX={8}
                      paddingY={4}
                      borderRadius={5}
                      backgroundColor={wallpaperLabel === src.machine ? "#3b82f6" : "#242c3c"}
                      onClick={() => {
                        onSelectWallpaper(src);
                        setLauncherOpen(false);
                      }}
                    >
                      <Text fontSize={12} color="#f1f5f9">
                        {src.kind === "vrchat" ? `${src.machine} (OVR)` : src.machine}
                      </Text>
                    </Container>
                  ))}
                </Container>
              </Container>

              {/* Per-machine windows */}
              {sources.filter((s) => s.kind === "desktop").map((src) => {
                const wins = windowsBySource[src.actor] ?? [];
                return (
                  <Container key={src.actor} flexDirection="column" gap={5}>
                    <Container flexDirection="row" alignItems="center" gap={8}>
                      <Text fontSize={12} color="#60a5fa">
                        {src.local ? `${src.machine} (local)` : src.machine}
                      </Text>
                      <Container
                        paddingX={7}
                        paddingY={2}
                        borderRadius={4}
                        backgroundColor="#1e293b"
                        onClick={() => {
                          onOpenDesktop(src);
                          setLauncherOpen(false);
                        }}
                      >
                        <Text fontSize={11} color="#cbd5e1">+ Full Desktop</Text>
                      </Container>
                    </Container>
                    {wins.length === 0
                      ? (
                        <Text fontSize={11} color="#64748b">
                          No individual windows listed (click Refresh or open Full Desktop)
                        </Text>
                      )
                      : wins.slice(0, 12).map((w) => {
                        const isBg = wallpaperWindowId === w.id;
                        return (
                          <Container
                            key={`${src.actor}-${w.id}`}
                            flexDirection="row"
                            alignItems="center"
                            gap={6}
                          >
                            <Container
                              flexGrow={1}
                              paddingX={8}
                              paddingY={5}
                              borderRadius={5}
                              backgroundColor="#1f2736"
                              onClick={() => {
                                onOpenWindow(src, w);
                                setLauncherOpen(false);
                              }}
                            >
                              <Text fontSize={12} color="#e2e8f0">
                                {`${w.title.slice(0, 42)}${w.app ? `  [${w.app}]` : ""}`}
                              </Text>
                            </Container>
                            <Container
                              paddingX={7}
                              paddingY={5}
                              borderRadius={5}
                              backgroundColor={isBg ? "#3b82f6" : "#263042"}
                              onClick={() => {
                                if (isBg) onSelectWallpaper(null);
                                else onSelectWindowWallpaper(src, w);
                                setLauncherOpen(false);
                              }}
                            >
                              <Text fontSize={11} color="#f1f5f9">{isBg ? "BG*" : "BG"}</Text>
                            </Container>
                          </Container>
                        );
                      })}
                  </Container>
                );
              })}
            </Container>
          </group>
        )
        : null}

      {/* Docked bottom taskbar */}
      <group position={[0, barCy, TASKBAR_Z]}>
        <Container
          sizeX={tab.width}
          sizeY={TASKBAR_HEIGHT}
          pixelSize={1}
          width={tab.width}
          height={TASKBAR_HEIGHT}
          flexDirection="row"
          alignItems="center"
          paddingX={12}
          gap={8}
          backgroundColor="#141821"
          borderTopWidth={1}
          borderColor="#283142"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Apps button */}
          <Container
            paddingX={12}
            paddingY={6}
            borderRadius={6}
            backgroundColor={launcherOpen ? "#3b82f6" : "#252e3f"}
            onClick={() => {
              if (!launcherOpen) onRefreshLauncher();
              setLauncherOpen((open) => !open);
            }}
          >
            <Text fontSize={13} color="#f8fafc">Apps</Text>
          </Container>

          {/* VRChat / OVR background toggle */}
          <Container
            paddingX={10}
            paddingY={6}
            borderRadius={6}
            backgroundColor={vrBackgroundActive ? "#3b82f6" : "#252e3f"}
            onClick={() => onToggleVrBackground()}
          >
            <Text fontSize={12} color="#f8fafc">
              {vrBackgroundActive ? "VR BG: On" : "VR BG"}
            </Text>
          </Container>

          {/* Open window pills */}
          <Container flexDirection="row" alignItems="center" gap={6} flexGrow={1} overflow="hidden">
            {openWindows.map((win) => {
              const isFocused = win.id === focusedWindowId && !win.minimized;
              return (
                <Container
                  key={win.id}
                  paddingX={10}
                  paddingY={5}
                  borderRadius={6}
                  backgroundColor={isFocused
                    ? "#334155"
                    : win.minimized
                    ? "#1a202c"
                    : "#222938"}
                  borderWidth={isFocused ? 1 : 0}
                  borderColor="#60a5fa"
                  onClick={() => onWindowPillClick(win.id)}
                >
                  <Text fontSize={12} color={win.minimized ? "#64748b" : "#e2e8f0"}>
                    {`${win.machine}: ${win.title.slice(0, 18)}`}
                  </Text>
                </Container>
              );
            })}
          </Container>

          {/* Status */}
          <Text fontSize={11} color="#94a3b8">
            {`${sources.length} src · ${openWindows.length} win${viewerCount > 1 ? ` · ${viewerCount} views` : ""}`}
          </Text>
        </Container>
      </group>
    </>
  );
}
