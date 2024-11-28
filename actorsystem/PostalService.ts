import { TypedActorFunctions, MessageAddressReal } from "./types.ts";
import { Signal } from "./utils.ts";
import {
  Message,
  MessageType,
  NonArrayAddress,
  notAddressArray,
  Payload,
  PayloadHandler,
  System,
  ToAddress,
} from "./types.ts";
import { ActorWorker } from "./ActorWorker.ts";
import { CustomLogger } from "../classes/customlogger.ts";
import { PairAddress } from "./types.ts";


export class PostalService {
  public static actors: Map<string, ActorWorker> = new Map();
  public static remoteActors: Array<ToAddress> = [];
  public portal: ToAddress | null = null
  static signal: Signal<ToAddress>;
  private worker: ActorWorker | null = null


  public functions = {
    //create an actor
    CREATE: async (payload: string, address: PairAddress) => {
      const id = await this.add(payload);
      CustomLogger.log("postalservice", "created actor id: ", id, "sending back to creator")
      const message = {
        address: { fm: System, to: address.fm },
        type: "REGISTER",
        payload: id,
      }
      this.Post(message)
    },
    //actor notified us that it had loaded
    LOADED: (payload: ToAddress) => {
      CustomLogger.log("postalservice", "new actor loaded, id: ", payload)
      PostalService.signal.trigger(payload);
    },
    DELETE: (payload: ToAddress) => {
      PostalService.actors.delete(payload);
    },
    //actor murders someone
    MURDER: (payload: ToAddress) => {
      PostalService.murder(payload);
    },
    ADDREMOTE: (payload: ToAddress) => {
      PostalService.remoteActors.push(payload);
    },

    GETPORTAL: (_payload: null, address: PairAddress) => {
      const portal = this.portal
      this.Post({
        address: { fm: System, to: address.fm },
        type: "CB", // calling raw cb here seems pretty bad, need to figure how to fix
        payload: portal
      })
    }
  };



  systemFunctions(Aworker: ActorWorker, message: Message): void {

    this.worker = Aworker;
    if (!this.worker) throw new Error("worker is null")

    const address = message.address as MessageAddressReal;

    //console.log("worker is", this.worker)
    try {
      //@ts-ignore: uhh
      this.functions[message.type]?.(
        message.payload as Payload[typeof message.type],
        address,
      );
    }
    catch (error) {
      CustomLogger.error("actorsyserr", "PostalService systemFunctions error:%.*", error)
    }
  }

  async add(address: string): Promise<ToAddress> {
    PostalService.signal = new Signal<ToAddress>();

    CustomLogger.log("postalservice","creating", address)
    const worker: ActorWorker = new ActorWorker(
      new URL(`../actors/${address}`, import.meta.url).href,
      {
        type: "module",
      },
    );


    //attach message handler
    worker.onmessage = (event: MessageEvent<Message>) => {
      const message: Message = event.data;
      this.handleMessage(worker, message);
    };
    //send init message
    worker.postMessage({
      address: { fm: System, to: null },
      type: "INIT",
      payload: null,
    });

    const id = await PostalService.signal.wait();
    CustomLogger.log("postalservice", "created", id);
    PostalService.actors.set(id, worker);
    return id;
  }

  static murder(address: string) {
    const worker = PostalService.actors.get(address);
    if (worker) {
      worker.terminate();
      PostalService.actors.delete(address);
    }
  }

  //onmessage
  handleMessage = (worker: Worker, message: Message) => {
    const addresses = Array.isArray(message.address.to) ? message.address.to : [message.address.to];

    CustomLogger.error("actorsyserr", "PostalService handleMessage");

    CustomLogger.error("actorsyserr", message);

    addresses.forEach((address) => {
      message.address.to = address;

      // if message type starts with CB
      if (message.type.startsWith("CB")) {
        message.type = "CB";
      }

      CustomLogger.log("postalservice", "postalService handleMessage", message.address, message.type);
      // redirect message
      switch (message.address.to) {
        case null: {
          throw new Error();
        }
        case System: {
          this.systemFunctions(worker, message);
          break;
        }
        default: {
          // message address is to another actor
          if (!PostalService.actors.has(message.address.to)) {
            CustomLogger.error("actorsyserr", "No actor found");
            CustomLogger.log("actorsys", PostalService.actors);
            // using portal instead
          }
          CustomLogger.error("actorsyserr", message.address.to);
          CustomLogger.error("actorsyserr", PostalService.actors);
          const targetWorker = PostalService.actors.get(message.address.to);
          if (!targetWorker) throw new Error(`no target worker found under ${message.address.to}` )
          targetWorker.postMessage(message);
        }
      }
    });
  };


  
  Post<T extends MessageType>(rMessage: Message & { type: T }): void {
    // if address not valid json, stringify it
    if (typeof rMessage.address === "object") {
      rMessage.address = JSON.stringify(
        rMessage.address,
      ) as unknown as MessageAddressReal;
    }

    const address = JSON.parse(rMessage.address as unknown as string);
    /* CustomLogger.log(
      "default",
      `PostalService processing message:\n${rMessage.address}\nmessage type: ${rMessage.type}\npayload: ${rMessage.payload}\n`,
    ); */
    if (!notAddressArray(address)) {
      throw new Error("not address array");
    }

    if (address.to !== null && PostalService.actors.has(address.to)) {
      const worker: ActorWorker = PostalService.actors.get(address.to)!;

      worker.postMessage({
        address: { fm: System, to: address.to },
        type: rMessage.type,
        payload: rMessage.payload,
      } as Message);
    } else {
      CustomLogger.error("actorsyserr", `No worker found for address ${address.to}`);
    }
  }
}
