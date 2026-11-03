/** Native OpenVR interaction rig. Scene queries observe targets; actions go through the driver. */
import * as THREE from "three";
import { type Hand, type HandPose, type Quat, SyntheticDriver, type Vec3 } from "./driver.ts";
import { evalIn } from "./petplay.ts";
import { sleep, waitFor } from "./util.ts";

/** Base64 avoids treating Deno.inspect's JS representation as executable/JSON source. */
export async function queryScene<T>(body: string): Promise<T> {
  const inspected = await evalIn(
    "webxr",
    `btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(await (async()=>{${body}})()))))`,
  );
  const encoded = inspected.slice(1, -1);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error("Unexpected scene query encoding");
  return JSON.parse(
    new TextDecoder().decode(Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))),
  ) as T;
}

// Hidden wrist pages stay built under a hidden Activity, so text lookups take shown text only.
const menuLookup =
  `const scene=host.rootStore.getState().scene;scene.updateMatrixWorld(true);let menu=null;scene.traverse(n=>{if(!menu&&n.userData?.wristMenuActor!==undefined)menu=n.parent;});if(!menu)throw Error('No wrist menu');const shown=n=>{for(;n;n=n.parent)if(!n.visible)return false;return true};`;
export type MenuSnapshot = { position: Vec3; rotation: Quat; texts: string[] };
export function wristSnapshot(): Promise<MenuSnapshot> {
  return queryScene(
    `${menuLookup}const p=new THREE.Vector3(),q=new THREE.Quaternion();menu.matrixWorld.decompose(p,q,new THREE.Vector3());const texts=[];menu.traverse(n=>{if(n.userData?.raythreeUiText?.text&&shown(n))texts.push(n.userData.raythreeUiText.text)});return {position:p.toArray(),rotation:q.toArray(),texts};`,
  );
}

function matrix(pose: HandPose): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3().fromArray(pose.position),
    new THREE.Quaternion().fromArray(pose.rotation),
    new THREE.Vector3(1, 1, 1),
  );
}
function pose(matrix: THREE.Matrix4): HandPose {
  const p = new THREE.Vector3(), q = new THREE.Quaternion();
  matrix.decompose(p, q, new THREE.Vector3());
  return { position: p.toArray() as Vec3, rotation: q.toArray() as Quat };
}

export class NativeInteractionRig {
  private rayToRaw = new Map<Hand, THREE.Matrix4>();
  private constructor(
    readonly driver: SyntheticDriver,
    private initial: Awaited<ReturnType<SyntheticDriver["state"]>>,
  ) {}
  static async attach() {
    const driver = await SyntheticDriver.attach();
    try {
      return new NativeInteractionRig(driver, await driver.state());
    } catch (error) {
      driver.close();
      throw error;
    }
  }
  /** Calibrate the installed binding's raw-device-to-application-ray offset, with no app mutation. */
  async calibrateRay(hand: Hand) {
    const raw: HandPose = { position: [0, 1.2, -.3], rotation: [0, 0, 0, 1] };
    await this.driver.setPose(hand, raw);
    await sleep(250);
    const actual = await queryScene<HandPose>(
      `const c=host.getDirectOpenVrInputs().controllers.${hand};if(!c)throw Error('Controller not tracked');return {position:[...c.position],rotation:[...c.quaternion]};`,
    );
    this.rayToRaw.set(hand, matrix(raw).invert().multiply(matrix(actual)).invert());
  }
  async setRay(hand: Hand, target: HandPose) {
    const offset = this.rayToRaw.get(hand);
    if (!offset) throw new Error(`Calibrate ${hand} ray before use`);
    await this.driver.setPose(hand, pose(matrix(target).multiply(offset)));
  }
  async aim(hand: Hand, target: Vec3, origin: Vec3 = [-.1, 1.5, .1]) {
    const q = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().lookAt(
        new THREE.Vector3().fromArray(origin),
        new THREE.Vector3().fromArray(target),
        new THREE.Vector3(0, 1, 0),
      ),
    );
    await this.setRay(hand, { position: origin, rotation: q.toArray() as Quat });
    await sleep(150);
  }
  async click(target: Vec3, hand: Hand = "left") {
    await this.aim(hand, target);
    await this.driver.press(hand, { trigger: 1 }, 150);
    await sleep(150);
  }
  async faceWrist() {
    for (let pass = 0; pass < 2; pass++) {
      const base = new THREE.Vector3(0, 1.2, -.3);
      await this.driver.setPose("right", {
        position: base.toArray() as Vec3,
        rotation: [0, 0, 0, 1],
      });
      await sleep(250);
      const observed = await wristSnapshot();
      const rotation = new THREE.Quaternion().fromArray(observed.rotation).invert();
      const offset = new THREE.Vector3().fromArray(observed.position).sub(base).applyQuaternion(
        rotation,
      );
      await this.driver.setPose("right", {
        position: new THREE.Vector3(0, 1.6, -.2).sub(offset).toArray() as Vec3,
        rotation: rotation.toArray() as Quat,
      });
      await sleep(200);
    }
  }
  async clickWristPoint(point: readonly [number, number]) {
    const target = await queryScene<Vec3>(
      `${menuLookup}return menu.localToWorld(new THREE.Vector3(${point[0]}*.001,${
        point[1]
      }*.001,.02)).toArray();`,
    );
    await this.click(target);
  }
  async clickWristText(text: string) {
    const target = await queryScene<Vec3>(
      `${menuLookup}let found=null;menu.traverse(n=>{if(!found&&n.userData?.raythreeUiText?.text===${
        JSON.stringify(text)
      }&&shown(n))found=n;});if(!found)throw Error('Text target not found');return found.getWorldPosition(new THREE.Vector3()).toArray();`,
    );
    await this.click(target);
  }
  async expectText(text: string) {
    return await waitFor(
      `wrist text ${text}`,
      async () => (await wristSnapshot()).texts.includes(text),
      3000,
      100,
    );
  }
  async restore() {
    const errors: unknown[] = [];
    try {
      for (const hand of this.initial.hands) {
        try {
          await this.driver.setInput(hand.role, hand.inputs);
          if (hand.held) {
            const q = hand.pose.qRotation;
            await this.driver.setPose(hand.role, {
              position: hand.pose.vecPosition,
              rotation: [q.x, q.y, q.z, q.w],
            });
          } else await this.driver.release(hand.role);
        } catch (error) {
          errors.push(error);
        }
      }
    } finally {
      this.driver.close();
    }
    if (errors.length) throw new AggregateError(errors, "Could not restore all synthetic hands");
  }
}
