import {
    Message,
    MessageAddressReal,
    System,
    ToAddress,
} from "./types.ts";
import { PostalService } from "./PostalService.ts";
import { Signal } from "./utils.ts";
import { CustomLogger } from "../classes/customlogger.ts";

export class ActorWorker extends Worker {
    static signal: Signal<ToAddress>;
    constructor(scriptURL: string | URL, options?: WorkerOptions) {
        super(scriptURL, options);
        CustomLogger.log("actorsys", "ActorWorker constructor called");
    }

    override postMessage(message: Message, transfer: Transferable[]): void;
    override postMessage(message: Message, options?: StructuredSerializeOptions): void;
    override postMessage(
        message: Message,
        transferOrOptions?: Transferable[] | StructuredSerializeOptions,
    ): void {

        const address = message.address as MessageAddressReal;
        //console.log("wa", message)
        if (PostalService.actors.has(address.to) || address.to == System) {
            CustomLogger.log("actorsys",
                `sending from actor ${address.fm} to actor ${address.to}`,
            );

            if (Array.isArray(transferOrOptions)) {
                super.postMessage(message, transferOrOptions);
            } else {
                super.postMessage(message, transferOrOptions);
            }
        } else if (address.fm == System && address.to == null) {
            CustomLogger.log("actorsys", "sending from system to actor");
            if (Array.isArray(transferOrOptions)) {
                super.postMessage(message, transferOrOptions);
            } else {
                super.postMessage(message, transferOrOptions);
            }
        } else {
            CustomLogger.log("actorsys", address.to);
            throw new Error("No route found");
        }
    }
}
