/** Test actor: opens an `rdp.input` transport to desktopInput and sends what it is told. */
import {
  actorState,
  messages,
  PostMan,
  Transport,
  type TransportMessages,
} from "../../submodules/stageforge/mod.ts";

const state = actorState({ name: "rdp-input-client" });
let transport: TransportMessages | null = null;

new PostMan(state, {
  OPEN: async (input: string) => {
    const opened = await Transport.open(input, { purpose: "rdp.input" });
    transport = messages(opened);
    return opened.kind;
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
