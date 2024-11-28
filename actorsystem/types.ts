
import { ActorWorker } from "./ActorWorker.ts";
import { functions as MAINEAF } from "../actors/mainE.ts";
import { functions as IROHAF } from "../actors/IrohActor.ts";
import { functions as POSTAF } from "../classes/PostMan.ts";
import { functions as SERVICEAF } from "./PostalService.ts";


export const worker = self as unknown as ActorWorker;


export type ToAddress = string & { readonly _: unique symbol };

export interface PeerInfo {
  actorId: string;
  hyperswarmId: string;
}

export type BaseState = {
  name: string;
  id: string | ToAddress;
  addressBook: Set<string>;
  [key: string]: unknown;
};

export const System = "SYSTEM" as const;

export type SystemType = typeof System;

// Message Address Interfaces


export interface SystemCommand {
  fm: typeof System;
  to: null;
}

export interface WorkerToSystem {
  fm: string;
  to: typeof System;
}

// Union of single address types
export type MessageAddressSingle = PairAddress | SystemCommand | WorkerToSystem;

// Address with array of strings or single string
export interface MessageAddressArray {
  fm: string;
  to: string | string[];
}

// Real message address with ToAddress
export interface MessageAddressReal {
  fm: string;
  to: ToAddress;
}

// Union of all possible message addresses
export type MessageAddress = MessageAddressSingle | MessageAddressArray;



type AllActorFunctions = typeof MAINEAF & typeof IROHAF & typeof POSTAF & typeof SERVICEAF;


export type TypedActorFunctions = {
  [K in keyof AllActorFunctions]: (
    payload: Parameters<AllActorFunctions[K]>[0],
    address: string,
  ) => ReturnType<AllActorFunctions[K]>;
};

export type MessageType = keyof TypedActorFunctions;

export type ValidateMessageType<T extends string> = T extends MessageType
  ? T
  : T extends string
  ? never
  : `Invalid message type. Valid types are: ${MessageType extends string ? MessageType : never}`;

export type hFunction = (_payload: Payload[MessageType]) => void;

type CBType = `CB:${MessageType}`;

// Then extend Payload to include both regular and callback types
export type Payload = {
  [K in MessageType | CBType]: K extends `CB:${infer T}`
  ? T extends MessageType
  ? Parameters<TypedActorFunctions[T]>[0]
  : never
  : Parameters<TypedActorFunctions[K & MessageType]>[0];
};

export type PayloadHandler<T extends MessageType> = (
  payload: Payload[T],
  address: MessageAddressReal | ToAddress,
) => hFunction | void | Promise<void>;

export type tsfile = string

type CallbackType<T extends string> = `CB:${T}`;



export type Message = {
  [K in MessageType]: {
    address: {
      fm: string;
      to: string | ToAddress | null;
    };
    type: ValidateMessageType<K> | CallbackType<ValidateMessageType<K>>;
    payload: Parameters<TypedActorFunctions[K]>[0];
  };
}[MessageType];

export type GenericMessage = {
  address: {
    fm: string;
    to: string;
  };
  type: string;
  payload: unknown;
};


export type GenericActorFunctions = {
  readonly [key: string]: (payload: any, address: MessageAddressReal) => void | Promise<void>;
};

export type Topic = string


export interface PairAddress {
  fm: string;
  to: string | null;
}
export type NonArrayAddress = PairAddress | SystemCommand | WorkerToSystem;

// Type Guard to check if address is not an array
export function notAddressArray(
  address: Message["address"]
): address is NonArrayAddress {
  return !Array.isArray(address);
}
