import { PostalService } from "../actorsystem/PostalService.ts";
import type { Message } from "../stageforge/src/lib/types.ts";
import { wait } from "../actorsystem/utils.ts";




const postalservice = new PostalService();

const mainAddress = await postalservice.add("test/main.ts");
//const portal = await postalservice.add("IrohActor.ts")

//postalservice.portal = portal

console.log("mainAddress", mainAddress);

/* postalservice.Post({
  address: { fm: "system", to: portal },
  type: "INITNETWORK",
  payload: null,
}); */

await wait(1000)

postalservice.Post({
  address: { fm: "system", to: mainAddress },
  type: "MAIN",
  payload: null,
} satisfies Message);




