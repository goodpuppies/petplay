import { PostMan } from "../submodules/stageforge/mod.ts"
import { dirname, join, extname } from "jsr:@std/path";

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(() => resolve(), ms));
}

type ActorAddress = string;

interface ActorNode {
  address: ActorAddress;
  assignMessage?: string; // Message the child should send to parent
  children?: Record<string, ActorNode>;
}

export async function assignActorHierarchy(
  tree: Record<string, ActorNode>,
  parent: ActorAddress | null = null
): Promise<void> {
  for (const node of Object.values(tree)) {
    if (parent && node.assignMessage) {
      await PostMan.PostMessage({
        target: node.address,
        type: node.assignMessage,
        payload: parent,
      });
    }

    if (node.children) {
      await assignActorHierarchy(node.children, node.address);
    }
  }
}

export function tempFile(filename: string, suffix: string, folder: string, base: string): string {
  const basepath = join(base, folder)
  const file = Deno.readFileSync(join(basepath, filename))
  const temppath = Deno.makeTempFileSync({ dir: "./tmp", suffix: suffix })
  Deno.writeFileSync(temppath, file)
  const path = Deno.realPathSync(temppath)
  return path
}

export async function createTemp(base: string) {
  await Deno.mkdir("./tmp", { recursive: true })

  //stupid hack
  const path = join(import.meta.dirname!, "../resources")
  const file = Deno.readFileSync(join(path, "bindings_oculus_touch.json"))
  const tmppath = join("./tmp", "bindings_oculus_touch.json")
  Deno.writeFileSync(tmppath, file)
}

export function destroyTemp() {
  console.log("CLEAN")
  Deno.removeSync("./tmp/", { recursive: true })
}

const stream = Deno.stdin.readable.values();
export async function asyncPrompt(): Promise<string> {
  const next = await stream.next();
  if ("done" in next && next.done) {
    return "";
  } else {
    return new TextDecoder().decode(next.value).slice(0, -1);
  }
}