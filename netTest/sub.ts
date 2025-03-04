import { PostMan } from "../stageforge/mod.ts";

const state = {
  name: "sub",
};

new PostMan(state.name, {
  CUSTOMINIT: (payload: string) => {
    PostMan.setTopic("muffin")
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