import { wait } from "../stageforge/src/lib/utils.ts";
import { PostMan } from "../stageforge/mod.ts";

const state = {
  name: "main2",
};

new PostMan(state.name, {
  CUSTOMINIT: (payload: string) => {
    PostMan.setTopic("muffin")
    main(payload);
  },
  HELLO: (_payload: null) => {
    console.log("hi2")
  },
  LOG: (_payload: null) => {
    console.log("actor2", PostMan.state.id);
  }
} as const);

async function main(_payload: string) {
  console.log("main2", PostMan.state.id);
  console.log("main2", PostMan.state.addressBook)
  await wait(20000)
  console.log("main2", PostMan.state.addressBook)

  await wait(12000)

  PostMan.PostMessage({
    target: Array.from(PostMan.state.addressBook),
    type: "LOG",
    payload: null,
  })

}