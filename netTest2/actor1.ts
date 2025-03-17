import { wait } from "../stageforge/src/lib/utils.ts";
import { PostMan } from "../stageforge/mod.ts";

const state = {
  name: "main",
};

new PostMan(state.name, {
  CUSTOMINIT: (payload: string) => {
    PostMan.setTopic("muffin")
    main(payload);
  },
  HELLO: (_payload: null) => {
    console.log("hi")
  },
  LOG: (_payload: null) => {
    console.log("LOG", "actor1", PostMan.state.id);
  }
} as const);

async function main(_payload: string) {
  const sub = await PostMan.create("./netTest2/sub.ts");
  const sub2 = await PostMan.create("./netTest2/actor2.ts");
  while (true) {
    await wait(5000)
    console.log("main1", PostMan.state.addressBook)
    PostMan.state.addressBook.forEach((element) => {
      PostMan.PostMessage({
        target: element,
        type: "LOG",
        payload: null,
      })
    })
  }
}