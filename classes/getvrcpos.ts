/// <reference lib="deno.unstable" />
import { messageFromBuffer } from "@jwetzell/osc";
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
      const [msg] = messageFromBuffer(buffer);
      if (!msg || !addressSet.has(msg.address)) continue;
      const first = msg.args[0];
      const value = first && !Array.isArray(first) ? first.value : undefined;
      if (typeof value === "number") this.notifySubscribers(msg.address, value);
    }

    conn.close();
  }
}
