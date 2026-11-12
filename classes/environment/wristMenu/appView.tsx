/**
 * Settings → APP: which PetPlay this is, installing it into SteamVR (and updating or removing that
 * install), and where its logs are.
 *
 * Install and uninstall run this executable again with `--install` / `--uninstall`
 * (classes/install.ts) as a separate process, so the OpenVR registration client never loads into
 * the running PetPlay and a failure there cannot take it down.
 */
import React, { useState } from "react";
import { Button, Container } from "../../../submodules/threewebxrwebgpudeno/webgpu-uikit.tsx";
import { Pill } from "../ui/primitives.tsx";
import { Text } from "../ui/text.tsx";
import { COLOR, INNER_GAP, RADIUS } from "../ui/tokens.ts";
import { describeBuild, getBuildInfo } from "../../buildInfo.ts";
import { type InstallState, installState } from "../../install.ts";
import { logsDir } from "../../appPaths.ts";

type Action = "install" | "uninstall";

/** What the SteamVR row says and offers for an install state. */
export function installSummary(state: InstallState): { status: string; action: Action | null } {
  if (!state.canInstall) {
    return { status: "Source checkout: deno task steamvr:register", action: null };
  }
  if (!state.installed) return { status: "Not installed", action: "install" };
  if (state.runningInstalled || state.upToDate) {
    return { status: "Installed: starts with SteamVR", action: "uninstall" };
  }
  const installed = state.installedBuild?.version ?? "another version";
  return {
    status: `${installed} installed; this is ${state.thisBuild.version}`,
    action: "install",
  };
}

export function AppView({ onBack }: { onBack: () => void }) {
  const [, refresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const state = installState();
  const { status, action } = installSummary(state);
  const run = async (which: Action) => {
    setBusy(true);
    setMessage(null);
    try {
      const output = await new Deno.Command(Deno.execPath(), {
        args: [`--${which}`],
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output();
      const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes).trim();
      const text = output.success ? decode(output.stdout) : decode(output.stderr);
      setMessage(text.split("\n").filter(Boolean).at(-1) ?? (output.success ? "Done." : "Failed."));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
      refresh((n) => n + 1);
    }
  };
  const label = action === "uninstall" ? "UNINSTALL" : state.installed ? "UPDATE" : "INSTALL";
  return (
    <Container flexDirection="column" gap={INNER_GAP} width={448}>
      <Container flexDirection="row" alignItems="center" gap={INNER_GAP}>
        <Button paddingX={0} paddingY={0} backgroundOpacity={0} onClick={onBack}>
          <Pill slots={1} units={2} fontSize={14}>BACK</Pill>
        </Button>
        <Pill slots={3} units={2} tone="accent" fontSize={14}>PETPLAY</Pill>
      </Container>
      <Row label="Version">
        <Text fontSize={13} color={COLOR.ink}>{getBuildInfo().version}</Text>
      </Row>
      <Row label="SteamVR">
        <Pill
          slots={2}
          units={2}
          fontSize={12}
          disabled={busy || action == null}
          tone={action === "install" ? "accent" : "outline"}
          onClick={busy || action == null ? undefined : () => void run(action)}
        >
          {busy ? "WORKING" : label}
        </Pill>
      </Row>
      <Text fontSize={12} color={COLOR.inkDim}>{message ?? status}</Text>
      <Text fontSize={11} color={COLOR.inkDim}>{describeBuild()}</Text>
      <Text fontSize={11} color={COLOR.inkDim}>{`Logs: ${logsDir()}`}</Text>
    </Container>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Container
      flexDirection="row"
      alignItems="center"
      justifyContent="space-between"
      padding={INNER_GAP}
      borderRadius={RADIUS.tile}
      backgroundColor={COLOR.tile}
      backgroundOpacity={1}
    >
      <Text fontSize={14} color={COLOR.ink}>{label}</Text>
      {children}
    </Container>
  );
}
