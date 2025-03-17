import { PostMan } from "../stageforge/mod.ts";
import { wait } from "../stageforge/src/lib/utils.ts";

const state = {
  name: "sub",
};

new PostMan(state.name, {
  CUSTOMINIT: (payload: string) => {
    main()
  },
  HELLO: (_payload: null) => {
    return "hi"
  },
  LOG: (_payload: null) => {
    console.log("hello from", PostMan.state.id);
  },
  GETSTRING: (_payload: null) => {
    return "Hello from sub actor!";
  }
} as const);

async function main() {
  while (true) {
    await wait(5000)
    console.log("sub", PostMan.state.addressBook)
    PostMan.state.addressBook.forEach((element) => {
      PostMan.PostMessage({
        target: element,
        type: "LOG",
        payload: null,
      })
    })
  }
}