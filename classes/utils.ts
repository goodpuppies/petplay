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

export function clearTemp() {
  Deno.removeSync("./tmp", { recursive: true });
}