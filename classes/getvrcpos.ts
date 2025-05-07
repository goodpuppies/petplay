import { Message } from "https://deno.land/x/osc@v0.1.0/mod.ts";
import { LogChannel } from "@mommysgoodpuppy/logchannel";

type Callback = (address: string, value: number) => void;

export class OscSubscriber {
  private subscribers: Callback[] = [];

  constructor(private addresses: string[]) { }

  public subscribe(callback: Callback) {
    this.subscribers.push(callback);
  }

  private notifySubscribers(address: string, value: number) {
    for (const subscriber of this.subscribers) {
      subscriber(address, value);
    }
  }



  public async listenForOscMessages() {
    LogChannel.log("class", "Listening for OSC messages...");
    const conn = Deno.listenDatagram({ port: 9001, transport: "udp" });
    const addressSet = new Set(this.addresses);


    for await (const [buffer, _addr] of conn) {
      const msg = await Message.fromBuffer(buffer);
      const msgWithAddress = msg as { addr: string; args: number[] };

      if (addressSet.has(msgWithAddress.addr)) {
        const newValue = msgWithAddress.args[0];
        await this.notifySubscribers(msgWithAddress.addr, newValue);
      }
    }

    conn.close();
  }
}
