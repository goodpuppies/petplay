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
    console.log("actor1", PostMan.state.id);
  }
} as const);

async function main(_payload: string) {
  console.log("main1", PostMan.state.id);

  const sub = await PostMan.create("./netTest/sub.ts")
  await PostMan.create("./netTest/actor2.ts")
  console.log("sub", sub)
  const sub2 = await PostMan.create("./netTest/sub.ts")

  console.log("main1", PostMan.state.addressBook)

  /* PostMan.PostMessage({
    target: sub2,
    type: "CHANGENAME",
    payload: "sub2"
  }) */

  PostMan.PostMessage({
    target: [sub, sub2],
    type: "LOG",
    payload: null,
  });
  console.log("test cb impl")
  const string = await PostMan.PostMessage({
    target: sub,
    type: "GETSTRING",
    payload: null,
  }, true);
  console.log(string)
  await wait(10000)
  console.log("main1", PostMan.state.addressBook)
}