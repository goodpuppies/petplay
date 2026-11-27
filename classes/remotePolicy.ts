/**
 * Remote message policy for PetPlay's Stageforge hub (`PostalService.setRemotePolicy`).
 *
 * Separates untrusted `"discovery"` connections (relay-only, before the user clicks Trust) from
 * upgraded `"direct"` P2P connections (established only after mutual Trust):
 *
 * - On `"discovery"` connections:
 *   Only discovery/auth messages are accepted (`CHALLENGE`, `SHAREOFFER`, `DIRECTOFFER` on
 *   `vrcPeers`; `GUARDED` on `displayShare` / `desktopSource` / `desktopInput` / `householdDesktops`).
 *   `EVALJS`, `HOTPATCH`, `SHUTDOWN*`, `HEALTH`, and all local control methods are rejected.
 * - On `"direct"` connections (trusted P2P peers):
 *   Shared P2P compute (`EVALJS`, actor messages, `GUARDED`, etc.) is allowed, while local-only
 *   trust/sharing admin methods on `vrcPeers` and `displayShare` remain local-only so a trusted
 *   peer cannot silently trust third parties or force-share unshared monitors.
 */
import type { RemoteMessagePolicy } from "../submodules/stageforge/mod.ts";

const DISCOVERY_ALLOWED_BY_ACTOR: Record<string, ReadonlySet<string>> = {
  vrcPeers: new Set(["CHALLENGE", "SHAREOFFER", "DIRECTOFFER"]),
  displayShare: new Set(["GUARDED"]),
  desktopSource: new Set(["GUARDED"]),
  desktopInput: new Set(["GUARDED"]),
  // Receives `GUARDED:<cb>` replies for its own outgoing guarded RPCs.
  householdDesktops: new Set(["GUARDED"]),
};

/** Local-only admin methods that must never be invoked over any remote connection. */
const LOCAL_ONLY_BY_ACTOR: Record<string, ReadonlySet<string>> = {
  vrcPeers: new Set([
    "TRUST",
    "UNTRUST",
    "CONFIGURE",
    "SIMULATEPEER",
    "CLEARSIMULATED",
    "ASSIGNSHARING",
    "ASSIGNWEBXR",
  ]),
  displayShare: new Set([
    "SETUP",
    "GRANTPEER",
    "REVOKEPEER",
    "SETINSTANCETOPIC",
    "SETSHARED",
    "SHAREALL",
  ]),
};

function actorNameOf(actorId: string): string {
  const at = actorId.indexOf("@");
  return at >= 0 ? actorId.slice(0, at) : actorId;
}

function baseTypeOf(type: string): string {
  const colon = type.indexOf(":");
  return colon >= 0 ? type.slice(0, colon) : type;
}

export function petplayRemotePolicy(): RemoteMessagePolicy {
  return (message, connection) => {
    const to = typeof message.address?.to === "string" ? message.address.to : "";
    const actorName = actorNameOf(to);
    const baseType = baseTypeOf(message.type);

    if (LOCAL_ONLY_BY_ACTOR[actorName]?.has(baseType)) {
      return false;
    }

    if (connection.tier === "discovery") {
      return DISCOVERY_ALLOWED_BY_ACTOR[actorName]?.has(baseType) === true;
    }

    // Trusted `"direct"` P2P connection: allow shared compute (`EVALJS`, actor RPCs, etc.).
    return true;
  };
}
