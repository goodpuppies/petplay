import { assertEquals } from "jsr:@std/assert";
import { Signal } from "npm:@preact/signals-core@^1.12.1";
import { PropertiesImplementation } from "../submodules/threewebxrwebgpudeno/submodules/uikit/packages/pub-sub/src/index.ts";

type Values = { color: string | undefined; size: number | undefined };
type Inputs = { [K in keyof Values]?: Values[K] | Signal<Values[K]> | "initial" };
function properties() {
  const p = new PropertiesImplementation<Inputs, Values>(
    (key, value, set) => set(key, value as never),
    {
      color: "default",
      size: 1,
    },
  );
  p.setEnabled(true);
  return p;
}

Deno.test("UIKit precedence follows inserted, replaced and removed layers for reads and peeks", () => {
  const p = properties();
  p.setLayer(20, { color: "low", size: 2 });
  assertEquals(p.value.color, "low");
  assertEquals(p.peek().size, 2);
  p.set(3, "color", "high");
  assertEquals(p.value.color, "high");
  p.setLayer(3, { size: 9 });
  assertEquals(p.value.color, "low");
  assertEquals(p.peek().size, 9);
  p.setLayer(3, undefined);
  assertEquals(p.value.size, 2);
  p.setLayer(0, { color: "initial" });
  assertEquals(p.value.color, "default");
  p.setLayer(0, undefined);
  p.setLayer(20, undefined);
  assertEquals(p.value.color, "default");
  assertEquals(p.value.size, 1);
  p.destroy();
});

Deno.test("UIKit reactive fallback follows new precedence and enable transitions", () => {
  const p = properties();
  const top = new Signal<string | undefined>(undefined);
  p.setLayer(30, { color: "low" });
  p.setLayer(10, { color: top });
  assertEquals(p.value.color, "low");
  top.value = "live";
  assertEquals(p.value.color, "live");
  p.setLayer(0, { color: "override" });
  assertEquals(p.value.color, "override");
  p.setLayer(0, undefined);
  assertEquals(p.value.color, "live");
  top.value = undefined;
  assertEquals(p.value.color, "low");
  p.setEnabled(false);
  assertEquals(p.value.color, "default");
  top.value = "while disabled";
  p.set(5, "size", 7);
  p.setEnabled(true);
  assertEquals(p.value.color, "while disabled");
  assertEquals(p.value.size, 7);
  p.destroy();
});
