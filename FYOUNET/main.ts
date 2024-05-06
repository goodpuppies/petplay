import { Address } from "./actorsystem/types.ts";
import { actorManager } from "./actorsystem/actorManager.ts";
import { getIP } from "https://deno.land/x/get_ip@v2.0.0/mod.ts";
import * as mod from "jsr:@mys1024/worker-fn@2";
import { ChatApp } from "./actors/ChatApp.ts";


export type ReceivePayload = {
  addr: Address<ChatApp>,
  name: string,
} & ({ msg: string } | { event: "JOIN" | "LEAVE" })

const stream = Deno.stdin.readable.values()

async function asyncPrompt(): Promise<string> {
  const next = await stream.next()
  if ('done' in next && next.done) {
    return ""
  } else {
    return new TextDecoder().decode(next.value).slice(0, -1)
  }
}

if (import.meta.main) {
  //username and ip
  const name = Deno.args[0] ?? "anonymous"
  const ip = Deno.args[1] ?? `${await getIP()}:53706`
  console.log(`Your IP is ${ip}`)

  //create actorManager
  const actors = new actorManager()

  //add chatapp to our actors, defined to extend ActorP2P so its a networked actor
  const aChatApp : Address<ChatApp> = actors.add(new ChatApp(ip, name))

  while (true) {
    const msg = await asyncPrompt() ?? ""

    if (msg.startsWith("/")) {
      const cmd = msg.substring(1).split(" ");
      switch (cmd[0]) {
        case "c":
        case "conn":
        case "connect": {
          //initial connection

          if (!cmd[1]) {
            console.log(`Use: '/${cmd} <ip:port>'`)
            continue;
          }
          console.log(`Connecting to ${cmd[1]}...`)

          //tell chat app actor to connect to ip
          actors.command(aChatApp, "h_connect", cmd[1])
          break;
        }
        default: {
          console.log(`Unknown command '/${cmd}'.`)
          break;
        }
      }
    } else {
      // clear line
      await Deno.stdout.write(new TextEncoder().encode("\x1b[1A\r\x1b[K"))
      
      //tell chat app to broadcast message
      actors.command(aChatApp, "h_broadcast", msg)
    }
  }
}