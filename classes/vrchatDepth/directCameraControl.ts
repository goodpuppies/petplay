import type { VrcWorldCameraPose } from "../vrcCameraCalibration.ts";

export type CameraControlEndpoint = { hostname: string; port: number };
function packet(address: string, types: string, payloadBytes = 0) {
  const encoder = new TextEncoder();
  const addressSize = (encoder.encode(address).length + 4) & ~3;
  const typeSize = (types.length + 4) & ~3;
  const bytes = new Uint8Array(addressSize + typeSize + payloadBytes);
  bytes.set(encoder.encode(address));
  bytes.set(encoder.encode(types), addressSize);
  return bytes;
}
const poseTemplate = packet("/usercamera/Pose", ",ffffff", 24);
const releasePacket = packet("/usercamera/Flying", ",F");

/** Persistent local UDP sender; actor keeps discovery/feedback, input avoids its relay. */
export class DirectCameraControl {
  private socket: Deno.DatagramConn;
  private pending: Promise<number> = Promise.resolve(0);
  constructor(private endpoint: CameraControlEndpoint) {
    if (
      endpoint.hostname !== "127.0.0.1" || !Number.isInteger(endpoint.port) || endpoint.port < 1 ||
      endpoint.port > 65535
    ) {
      throw new Error("Expected a local VRChat OSC endpoint");
    }
    this.socket = Deno.listenDatagram({ hostname: "127.0.0.1", port: 0, transport: "udp" });
  }
  sendPose(pose: VrcWorldCameraPose): Promise<number> {
    const bytes = poseTemplate.slice();
    const values = [...pose.position, ...pose.rotationDeg];
    if (!values.every(Number.isFinite)) {
      return Promise.reject(new Error("Camera pose must be finite"));
    }
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < values.length; i++) {
      view.setFloat32(bytes.length - 24 + i * 4, values[i], false);
    }
    return this.pending = this.socket.send(bytes, { ...this.endpoint, transport: "udp" });
  }
  /** `/usercamera/Zoom`: a focal length, mm; VRChat clamps it at about 20 (84.7° vertical). */
  sendZoom(focalMm: number): Promise<number> {
    if (!Number.isFinite(focalMm)) return Promise.reject(new Error("Zoom must be finite"));
    const bytes = packet("/usercamera/Zoom", ",f", 4);
    new DataView(bytes.buffer).setFloat32(bytes.length - 4, focalMm, false);
    return this.pending = this.socket.send(bytes, { ...this.endpoint, transport: "udp" });
  }
  /** `/usercamera/Mode` (2 = Stream). Switches an open camera; it doesn't open a closed one. */
  sendMode(mode: number): Promise<number> {
    if (!Number.isInteger(mode)) return Promise.reject(new Error("Mode must be an integer"));
    const bytes = packet("/usercamera/Mode", ",i", 4);
    new DataView(bytes.buffer).setInt32(bytes.length - 4, mode, false);
    return this.pending = this.socket.send(bytes, { ...this.endpoint, transport: "udp" });
  }
  /** `/usercamera/Flying` false: locomotion back to the player (`/usercamera/Pose` turns it on). */
  release(): Promise<number> {
    return this.pending = this.socket.send(releasePacket, { ...this.endpoint, transport: "udp" });
  }
  sendPlayerInput(name: string, value: number, button = false): Promise<number> {
    if (
      !/^(Vertical|Horizontal|LookHorizontal|Jump|Run|UseRight|GrabRight)$/.test(name) ||
      !Number.isFinite(value) || Math.abs(value) > 1
    ) throw new Error("Invalid player input");
    const bytes = packet(`/input/${name}`, button ? ",i" : ",f", 4);
    const view = new DataView(bytes.buffer);
    if (button) view.setInt32(bytes.length - 4, value ? 1 : 0, false);
    else view.setFloat32(bytes.length - 4, value, false);
    return this.pending = this.socket.send(bytes, { ...this.endpoint, transport: "udp" });
  }
  async close() {
    try {
      await this.pending;
    } finally {
      this.socket.close();
    }
  }
}
