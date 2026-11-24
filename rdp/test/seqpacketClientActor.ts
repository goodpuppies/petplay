import {
  type ActorId,
  actorState,
  PostMan,
  registerTransportKind,
  Transport,
  type TransportParams,
} from "../../submodules/stageforge/mod.ts";
import {
  DMABUF_SEQPACKET_KIND,
  dmabufSeqpacketClientTransport,
  type DmabufSeqpacketEndpoint,
  MEDIA_FRAMES_PURPOSE,
} from "../classes/dmabufSeqpacketTransport.ts";

const state = actorState({ name: "seqpacketClient" });
registerTransportKind(dmabufSeqpacketClientTransport());

new PostMan(state, {
  __INIT__: () => {},
  OPEN: async (payload: { target: ActorId; params: TransportParams }) => {
    const transport = await Transport.open(payload.target, {
      purpose: MEDIA_FRAMES_PURPOSE,
      kinds: [DMABUF_SEQPACKET_KIND],
      params: payload.params,
    });
    const { socketPath } = transport.connection as DmabufSeqpacketEndpoint;
    transport.close("done");
    return { socketPath };
  },
} as const);
