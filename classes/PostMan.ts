import { Signal } from "../actorsystem/utils.ts";
import {
  GenericActorFunctions,
  tsfile,
  GenericMessage,
  BaseState,
  Message,
  MessageAddressReal,
  notAddressArray,
  Payload,
  PayloadHandler,
  System,
  ToAddress,
  Topic
} from "../actorsystem/types.ts";
import { ActorWorker } from "../actorsystem/ActorWorker.ts";
import { wait } from "../actorsystem/utils.ts";
import { HyperswarmInterface } from "./hyperswarmInterface.ts";
import { getAvailablePort } from "jsr:@std/net";
import * as JSON from "../classes/JSON.ts";
import { CustomLogger } from "../classes/customlogger.ts";
import { State } from "../OpenVR_TS_Bindings_Deno/openvr_bindings.ts";

export const OnMessage = (handler: (message: Message) => void) => {
  const worker = self as unknown as ActorWorker;
  worker.onmessage = (event: MessageEvent) => {
    //console.log("huh", event.data)
    const message = event.data as Message;
    handler(message);
  };
};

export const functions = {
  //initialize actor
  INIT: (payload: string | null) => {
    Postman.state.id = `${Postman.state.name}@${crypto.randomUUID()}`;
    Postman.PostMessage({
      address: { fm: Postman.state.id, to: System },
      type: "LOADED",
      payload: Postman.state.id as ToAddress,
    });
    // @ts-ignore: get custominit from importer
    Postman.functions.CUSTOMINIT?.(null, Postman.state.id);
    CustomLogger.log("class", `initied ${Postman.state.id} actor with args:`, payload);
  },
  CB: (payload: unknown) => {
    //console.log("CB", payload)
    if (!Postman.customCB) {
      console.log("CB", payload)
      console.log(Postman.state.id)
      throw new Error("UNEXPECTED CALLBACK");
    }
    Postman.customCB.trigger(payload);
  },
  //register self to system
  REGISTER: (payload: ToAddress) => {
    CustomLogger.log("postman", "received the created actor in", Postman.state.id, "received", payload)
    if (!Postman.creationSignal) throw new Error("UNEXPECTED REGISTER MESSAGE")
    Postman.creationSignal.trigger(payload as ToAddress);
  },
  //terminate
  SHUT: (_payload: null) => {
    CustomLogger.log("class", "Shutting down...");
    Postman.worker.terminate();
  },
  OPENPORTAL: async (payload: Topic) => {
    // get portal from system
    const portal = await Postman.PostMessage({
      address: { fm: Postman.state.id, to: System },
      type: "GETPORTAL",
      payload: null,
    }, true);
    Postman.portal = portal as ToAddress


    Postman.PostMessage({
      address: { fm: Postman.state.id, to: Postman.portal },
      type: "ADDCONTACT",
      payload: Postman.state.id as ToAddress
    })
    Postman.PostMessage({
      address: { fm: Postman.state.id, to: Postman.portal },
      type: "SET_TOPIC",
      payload: payload
    })


  },
  ADDCONTACT: (payload: ToAddress) => {
    Postman.state.addressBook.add(payload)
    console.log("book", Postman.state.addressBook)
  },
};

export class Postman {
  static worker: ActorWorker = self as unknown as ActorWorker;
  static state: BaseState;
  static creationSignal: Signal<ToAddress>;
  static portalCheckSignal: Signal<boolean>;
  static customCB: Signal<unknown>;
  static portal: ToAddress | null = null;
  private static topic: string | null = null;
  static addressBook: Set<string>;
  static hmm: any;

  private static pendingTopicSet: string | null = null;

  public static functions = functions

  constructor(
    _worker: ActorWorker,
    functions: GenericActorFunctions,
    state: BaseState,
  ) {
    Postman.state = state;
    Postman.addressBook = Postman.state.addressBook;
    Postman.functions = { ...Postman.functions, ...functions };
  }

  //#region TOPIC
  /* private static attemptSetTopic(topicId: string | null) {
    if (Postman.hyperswarmInterface.isSocketOpen()) {
      Postman.setTopicImmediate(topicId);
    } else {
      CustomLogger.log("class", "WebSocket not open. Scheduling topic set attempt.");
      Postman.pendingTopicSet = topicId;
      Postman.scheduleSetTopicAttempt();
    }
  }

  private static scheduleSetTopicAttempt() {
    setTimeout(() => {
      if (Postman.pendingTopicSet !== null) {
        if (Postman.hyperswarmInterface.isSocketOpen()) {
          Postman.setTopicImmediate(Postman.pendingTopicSet);
        } else {
          CustomLogger.log("class", "WebSocket still not open. Rescheduling topic set attempt.");
          Postman.scheduleSetTopicAttempt();
        }
      }
    }, 1000); // Check every second
  }

  private static setTopicImmediate(topicId: string | null) {
    Postman.topic = topicId;
    Postman.hyperswarmInterface.setTopic(topicId);
    Postman.pendingTopicSet = null;
    CustomLogger.log("class", `Topic set to: ${Postman.topic}`);
  } */

  //#endregion

  //#region peers

  //#endregion

  static runFunctions(message: Message) {
    //console.log("customcb check: ", Postman.customCB)
    if (notAddressArray(message.address)) {
      const address = message.address as MessageAddressReal;
      /* CustomLogger.log(
        "postman",
        `[${address.to}]Actor running function, type: ${message.type}, payload: ${JSON.stringify(message.payload)
        }`,
      ); */

      if (message.type.startsWith("CB:") && !Postman.customCB) {
        throw new Error(`Callback received without a receiver: ${message.type}`);
      }
      //@ts-ignore: uhh
      (this.functions[message.type] as PayloadHandler<typeof message.type>)?.(
        message.payload as Payload[typeof message.type],
        address,
      );
    } else throw new Error("not address array");
  }


  static PostMessage(
    message: Message,
    cb: true
  ): Promise<unknown>;
  static PostMessage(
    message: Message,
    cb?: false
  ): Promise<void>;
  static async PostMessage(
    message: Message,
    cb?: boolean
  ): Promise<unknown | void> {
    if (cb) {
      CustomLogger.log("class", "cb enabled");
      Postman.customCB = new Signal<unknown>();
      Postman.posterr(message);
      const result = await Postman.customCB.wait();
      return result;
    } //use return false if fail to send msg for some reason
    else {
      Postman.posterr(message);
    }
  }

  static async posterr(message: Message) {

    const addresses = (Array.isArray(message.address.to)
      ? message.address.to
      : [message.address.to]
    ).filter((addr): addr is ToAddress => addr !== null);


    const addr = message.address as MessageAddressReal;


    await Promise.all(addresses.map(async (address: ToAddress) => {
      message.address.to = address!;
      //console.log("addressbook of",this.state.name, Postman.addressBook)
      this.worker.postMessage(message);

      /* if (Postman.portal && Postman.addressBook.has(message.address.to)) {
        console.log("Trying portal route for", message.address.to);
        try {
          const sent = await Postman.PostMessage({
            address: { fm: Postman.state.id, to: Postman.portal },
            type: "SEND",
            payload: message as GenericMessage,
          }, true);
          if (!sent) {
            console.log("Portal send failed, falling back to local");
            this.worker.postMessage(message);
          }
        } catch (error) {
          console.log("Portal error, falling back to local");
          this.worker.postMessage(message);
        }
      }




      else {
        //console.log("send", message)
        this.worker.postMessage(message);
      } */

      //#region stuff
      /* else if (Postman.hyperswarmInterface) {
        //check portal
        CustomLogger.log("syncloop", "portal check? ");

        throw new Error("not implemented");

        Postman.portalCheckSignal = new Signal<boolean>();
        CustomLogger.log("class", "trying to query dataPeers")
        CustomLogger.log("class", Postman.state.id)
        CustomLogger.log("class", message.address.to)
        Postman.hyperswarmInterface.sendToNodeProcess({
          type: "query_dataPeers",
          from: Postman.state.id,
          targetPeerId: message.address.to,
        });
        const result: boolean = await Postman.portalCheckSignal.wait();
        if (result) {
          Postman.hyperswarmInterface.sendToNodeProcess({
            type: "send_message",
            targetPeerId: message.address.to,
            payload: message,
          });
        } else {
          CustomLogger.error("classerr", "trough rtc failed, trying locally");
          this.worker.postMessage(message);
        }
      } */
      //#endregion

    }));
  }


  static async create(
    actorname: tsfile,
  ): Promise<ToAddress> {
    CustomLogger.log("postman", "creating actor: " + actorname)

    Postman.creationSignal = new Signal<ToAddress>();

    this.worker.postMessage({
      address: { fm: Postman.state.id, to: System },
      type: "CREATE",
      payload: actorname,
    });
    CustomLogger.log("postman", "waiting actor creation: " + actorname)
    const result = await Postman.creationSignal.wait();
    CustomLogger.log("postman", "actor created!: " + actorname)
    Postman.addressBook.add(result)

    return result;
  }

  static addPeerToAddressBook(peerId: string) {
    if (!Postman.addressBook.has(peerId)) {
      Postman.addressBook.add(peerId);
      CustomLogger.log("class", `New peer available: ${peerId}`);
      CustomLogger.log("class", `Current peers: ${Array.from(Postman.addressBook).join(", ")}`);
    }
  }

  /* static async inithyperswarmInterface() {
    const port = await getAvailablePort();
    if (!port) {
      throw new Error("No port available");
    }
    Postman.hyperswarmInterface = new HyperswarmInterface(Postman.state.id, port);
    //await Postman.hyperswarmInterface.start();

    Postman.hyperswarmInterface.onMessage((data: any) => {

      CustomLogger.log("class", "Received message from Hyperswarm interface:", data);
      if (data.type === "peer_available") {
        console.log("Peer available adding to addressbook:", data.peerId);
        Postman.addPeerToAddressBook(data.peerId);
      } else if (data.type === "petplay_message") {
        const message = JSON.parse(data.payload) as Message;
        if (message.address.to === Postman.state.id) {
          Postman.runFunctions(message);
        } else {
          throw new Error("Message not to self");
        }
      } else if (data.type === "topic_connected") {
        Postman.PostMessage({
          address: { fm: Postman.state.id, to: Postman.hmm },
          type: "CB:SET_TOPIC",
          payload: data.topicId,
        });
      }
    });
  } */
}
