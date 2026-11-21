/**
 * Floating VRChat TOFU trust prompt: spawns right in front of the user's head when an untrusted
 * (or key-mismatched) PetPlay peer appears in the same VRChat instance.
 *
 * Unlike `ToastOverlay`, this card is interactive (Trust / Ignore buttons), so it anchors in world
 * space in front of the user when it first appears — staying rock-steady while you aim a laser at
 * it — and smoothly re-centers only if you turn far away (>55°) or walk >1.2 m away.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three/webgpu";
import { useFrame, useThree } from "@react-three/fiber/webgpu";
import { Container } from "../../submodules/threewebxrwebgpudeno/webgpu-uikit.tsx";
import { Text } from "./ui/text.tsx";
import { measureMsdfText } from "../../submodules/threewebxrwebgpudeno/msdf-text.tsx";
import { Pill } from "./ui/primitives.tsx";
import { COLOR, OUTLINE_WIDTH } from "./ui/tokens.ts";
import { wrapText } from "./ui/wrapText.ts";
import { PostMan } from "../../submodules/stageforge/mod.ts";
import { pushToast } from "./toastStore.ts";
import {
  type VrcTofuPromptItem,
  useVrcTofuPrompts,
  vrcTofuStore,
} from "./vrcTofuStore.ts";

const PROMPT_DISTANCE_M = 0.68;
const PROMPT_VERTICAL_OFFSET_M = -0.04;
const RECENTER_ANGLE_RAD = (55 * Math.PI) / 180;
const RECENTER_DISTANCE_M = 1.2;
const CARD_WIDTH = 460;
const CARD_PADDING_X = 22;
const TEXT_WIDTH = CARD_WIDTH - 2 * CARD_PADDING_X;

function useWrapped(text: string, fontSize: number): string {
  const [wrapped, setWrapped] = useState(text);
  useEffect(() => {
    let cancelled = false;
    wrapText(text, TEXT_WIDTH, async (line) => (await measureMsdfText(line, fontSize)).width)
      .then((next) => {
        if (!cancelled) setWrapped(next);
      });
    return () => {
      cancelled = true;
    };
  }, [text, fontSize]);
  return wrapped;
}

const FORWARD = new THREE.Vector3(0, 0, -1);
const UP = new THREE.Vector3(0, 1, 0);

function placeInFrontOfHead(
  headPos: THREE.Vector3,
  headQuat: THREE.Quaternion,
  outPos: THREE.Vector3,
  outQuat: THREE.Quaternion,
): void {
  // Flatten forward onto horizontal plane so the card sits upright and easy to read.
  const flatForward = FORWARD.clone().applyQuaternion(headQuat);
  flatForward.y = 0;
  if (flatForward.lengthSq() < 1e-4) {
    flatForward.set(0, 0, -1);
  } else {
    flatForward.normalize();
  }
  outPos.copy(headPos).addScaledVector(flatForward, PROMPT_DISTANCE_M);
  outPos.y += PROMPT_VERTICAL_OFFSET_M;

  // Face the user cleanly upright: in Three.js `lookAt(eye, target)` points -Z toward target,
  // so passing (headPos, outPos) points +Z (the front face of uikit) directly at the user.
  const lookMat = new THREE.Matrix4().lookAt(headPos, outPos, UP);
  outQuat.setFromRotationMatrix(lookMat);
}

export function VrcTofuPromptOverlay(
  {
    vrcPeersActor = null,
    onTrust,
    onIgnore,
  }: {
    vrcPeersActor?: string | null;
    onTrust?: (item: VrcTofuPromptItem) => void | Promise<void>;
    onIgnore?: (item: VrcTofuPromptItem) => void;
  },
) {
  const prompts = useVrcTofuPrompts();
  const active = prompts[0] ?? null;
  const [busy, setBusy] = useState(false);

  const group = useRef<THREE.Group>(null);
  const camera = useThree((state) => state.camera);
  const renderer = useThree((state) => state.gl);
  const scratch = useRef({
    headPos: new THREE.Vector3(),
    headQuat: new THREE.Quaternion(),
    headFwd: new THREE.Vector3(),
    toCard: new THREE.Vector3(),
    targetPos: new THREE.Vector3(),
    targetQuat: new THREE.Quaternion(),
    placedKey: null as string | null,
  });

  useFrame(() => {
    const s = scratch.current;
    const node = group.current;
    if (node == null || active == null) {
      s.placedKey = null;
      return;
    }

    const xr = (renderer as unknown as {
      xr?: { getCamera?: (camera: THREE.Camera) => THREE.Camera };
    }).xr;
    const head = Deno.args.includes("--desktop")
      ? camera
      : xr?.getCamera?.(camera as unknown as THREE.Camera) ?? camera;
    head.updateWorldMatrix(true, false);
    head.getWorldPosition(s.headPos);
    head.getWorldQuaternion(s.headQuat);

    const activeKey = `${active.vrcUserId}:${active.fingerprint}`;
    let shouldPlace = s.placedKey !== activeKey;
    if (!shouldPlace) {
      s.toCard.copy(node.position).sub(s.headPos);
      const dist = s.toCard.length();
      if (dist > RECENTER_DISTANCE_M || dist < 0.25) {
        shouldPlace = true;
      } else {
        s.headFwd.copy(FORWARD).applyQuaternion(s.headQuat).normalize();
        s.toCard.divideScalar(dist);
        const angle = Math.acos(Math.max(-1, Math.min(1, s.headFwd.dot(s.toCard))));
        if (angle > RECENTER_ANGLE_RAD) {
          shouldPlace = true;
        }
      }
    }

    if (shouldPlace) {
      placeInFrontOfHead(s.headPos, s.headQuat, s.targetPos, s.targetQuat);
      node.position.copy(s.targetPos);
      node.quaternion.copy(s.targetQuat);
      s.placedKey = activeKey;
    }
  });

  const handleTrust = useCallback(async () => {
    if (!active || busy) return;
    setBusy(true);
    try {
      if (onTrust) {
        await onTrust(active);
      } else if (vrcPeersActor) {
        await PostMan.PostMessage({
          target: vrcPeersActor,
          type: "TRUST",
          payload: {
            userId: active.vrcUserId,
            force: active.trust === "key_mismatch",
          },
        }, true);
      }
      vrcTofuStore.remove(active.vrcUserId);
      pushToast({
        source: "VRChat",
        title: `Trusted ${active.displayName}`,
        content: `Pinned key ${active.fingerprint}`,
        tone: "info",
      });
    } catch (error) {
      pushToast({
        source: "VRChat",
        title: `Could not trust ${active.displayName}`,
        content: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    } finally {
      setBusy(false);
    }
  }, [active, busy, onTrust, vrcPeersActor]);

  const handleIgnore = useCallback(() => {
    if (!active || busy) return;
    onIgnore?.(active);
    vrcTofuStore.dismiss(active.vrcUserId, active.fingerprint);
  }, [active, busy, onIgnore]);

  const isMismatch = active?.trust === "key_mismatch";
  const bodyText = useWrapped(
    isMismatch
      ? "Their PetPlay key does not match the one you pinned. Only accept if they reinstalled."
      : "Trust this person's PetPlay key to connect automatically in future sessions?",
    14,
  );
  const titleText = useWrapped(active?.displayName ?? "", 26);

  if (!active) return null;

  const borderColor = isMismatch ? COLOR.danger : COLOR.accent;
  const moreCount = prompts.length - 1;

  return (
    <group
      ref={group}
      name="vrc-tofu-prompt"
      userData={{
        vrcTofuPrompt: true,
        vrcUserId: active.vrcUserId,
        trust: active.trust,
      }}
    >
      <Container
        pixelSize={0.001}
        width={CARD_WIDTH}
        flexDirection="column"
        gap={12}
        paddingX={CARD_PADDING_X}
        paddingY={18}
        borderRadius={24}
        backgroundColor={COLOR.ground}
        backgroundOpacity={0.95}
        borderWidth={OUTLINE_WIDTH}
        borderColor={borderColor}
      >
        <Container flexDirection="row" justifyContent="space-between" alignItems="center">
          <Text color={isMismatch ? COLOR.danger : COLOR.accent} fontSize={14}>
            {isMismatch ? "VRChat Peer — Key Changed!" : "VRChat Peer in Instance"}
          </Text>
          {moreCount > 0 && (
            <Text color={COLOR.inkDim} fontSize={13}>{`+${moreCount} more`}</Text>
          )}
        </Container>

        <Container flexDirection="column" gap={4}>
          <Text color={COLOR.ink} fontSize={26}>{titleText}</Text>
          <Text color={COLOR.inkDim} fontSize={15}>{`Key: ${active.fingerprint}`}</Text>
          {isMismatch && active.pinnedFingerprint && (
            <Text color={COLOR.danger} fontSize={14}>
              {`Previously pinned: ${active.pinnedFingerprint}`}
            </Text>
          )}
          <Text color={COLOR.inkDim} fontSize={14}>{bodyText}</Text>
        </Container>

        <Container flexDirection="row" gap={12} justifyContent="flex-end" marginTop={4}>
          <Pill slots={3} tone="outline" fontSize={16} onClick={handleIgnore} disabled={busy}>
            Ignore
          </Pill>
          <Pill
            slots={4}
            tone={isMismatch ? "danger" : "accent"}
            fontSize={16}
            onClick={() => void handleTrust()}
            disabled={busy}
          >
            {isMismatch ? "Replace Key" : "Trust"}
          </Pill>
        </Container>
      </Container>
    </group>
  );
}
