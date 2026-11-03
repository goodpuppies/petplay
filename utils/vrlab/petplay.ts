/** The running PetPlay server's agent REPL (`/message`, `/eval`). */
import { getAgentReplPort } from "../../classes/utils.ts";

const base = () => `http://127.0.0.1:${getAgentReplPort()}`;

export async function message<T = any>(
  target: string,
  type: string,
  payload: unknown = null,
): Promise<T> {
  const response = await fetch(`${base()}/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ target, type, payload, reply: true }),
  });
  const body = await response.json();
  if (!response.ok || body.ok === false) {
    throw new Error(`${target} ${type}: ${JSON.stringify(body.error ?? body)}`);
  }
  return body.result as T;
}

/** Runs `code` inside an actor's worker (`state`, `host`, `THREE`, `PostMan`, `moduleUrl` in scope). */
export async function evalIn(target: string, code: string, timeoutMs = 5000): Promise<string> {
  const response = await fetch(`${base()}/eval`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ target, code, timeoutMs }),
  });
  const body = await response.json();
  if (!body.ok || body.result?.ok === false) {
    throw new Error(`eval in ${target}: ${JSON.stringify(body.error ?? body.result)}`);
  }
  return body.result?.inspected ?? "";
}

export async function health(): Promise<{ actors?: Record<string, string> } | null> {
  try {
    const response = await fetch(`${base()}/health`, { signal: AbortSignal.timeout(1_000) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

export async function supervisorPhase(): Promise<string | null> {
  try {
    const status = await message<{ details?: { phase?: string } }>("main", "HEALTH");
    return status?.details?.phase ?? null;
  } catch {
    return null;
  }
}

/** An attached OpenVR supervisor can coexist with a failed scene/input startup. */
export async function sceneReady(): Promise<boolean> {
  try {
    return await evalIn(
      "webxr",
      "Boolean(host?.running && host?.rootStore?.getState()?.scene && host?.getStatus().frameCount > 0 && host?.directOpenVrInputSource?.inputReady)",
    ) === "true";
  } catch {
    return false;
  }
}

/** Shows PetPlay's window layer (displays, keyboard); hidden by default at boot. */
export function showWindowLayer(): Promise<string> {
  return evalIn(
    "webxr",
    `import(new URL("../classes/environment/windowLayerMode.ts", moduleUrl).href).then((m) => { m.setWindowLayerVisible(true); return true; })`,
  );
}

/**
 * A small coloured sphere that follows PetPlay's own pose for one controller: ground truth for
 * where PetPlay draws that hand, to compare against the avatar's hand in another app's view.
 */
export function showHandMarker(
  hand: "left" | "right",
  color = 0xff00ff,
  radius = 0.03,
): Promise<string> {
  return evalIn(
    "webxr",
    `(() => { const scene = host.getRaythreeSceneContext().scene; const name = "vrlab-marker-${hand}";
      scene.getObjectByName(name)?.removeFromParent(); clearInterval(globalThis.__vrlabMarker_${hand});
      const m = new THREE.Mesh(new THREE.SphereGeometry(${radius}, 16, 12), new THREE.MeshBasicMaterial({ color: ${color} }));
      m.name = name; scene.add(m);
      globalThis.__vrlabMarker_${hand} = setInterval(() => { const c = host.getDirectOpenVrInputs().controllers.${hand};
        if (c) m.position.set(c.position[0], c.position[1], c.position[2]); }, 10);
      return "ok"; })()`,
  );
}

export function hideHandMarker(hand: "left" | "right"): Promise<string> {
  return evalIn(
    "webxr",
    `(() => { clearInterval(globalThis.__vrlabMarker_${hand}); host.getRaythreeSceneContext().scene.getObjectByName("vrlab-marker-${hand}")?.removeFromParent(); return "ok"; })()`,
  );
}

/** PetPlay's view of one controller: position as the scene uses it (after the app's pose binding). */
export async function controllerPosition(
  hand: "left" | "right",
): Promise<[number, number, number] | null> {
  const inspected = await evalIn(
    "webxr",
    `(() => { const c = host.getDirectOpenVrInputs().controllers.${hand}; return c ? JSON.stringify([...c.position]) : "null"; })()`,
  );
  return JSON.parse(JSON.parse(inspected));
}
