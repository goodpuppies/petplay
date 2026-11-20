/** Test actor: opens an `rdp.input` transport to desktopInput and sends what it is told. */
import { actorState, PostMan, Transport } from "../../submodules/stageforge/mod.ts";

const state = actorState({ name: "rdp-input-client" });
let transport: Transport | null = null;

new PostMan(state, {
  OPEN: async (input: string) => {
    transport = await Transport.open(input, { purpose: "rdp.input" });
    return transport.info.kind;
  },
  SEND: (events: unknown[]) => {
    for (const event of events) transport!.send(event);
    return true;
  },
  CLOSE: (reason: string) => {
    transport?.close(reason);
    return true;
  },
} as const);
