/** Diagnostic left-eye view from the synthetic driver's presented VRChat layer. */
import raylib from "../../submodules/raylib_ts_bindings_deno/raylib_bindings.ts";
import type {
  Shader,
  Texture2D,
} from "../../submodules/raylib_ts_bindings_deno/raylib_bindings.ts";
import { SyntheticDriver } from "../../utils/vrlab/driver.ts";
type Eye = { file: string; width: number; height: number; format: number; bounds: number[] };
export class DriverEyeView {
  private texture: Texture2D | null = null;
  private shader: Shader | null = null;
  private format = -1;
  private pending: { eye: Eye; pixels: Uint8Array; capturedAt: number } | null = null;
  private bounds = [0, 0, 1, 1];
  private busy = false;
  private stopped = false;
  private nextAt = 0;
  private frameAt = 0;
  private captureMs = 0;
  private completed = 0;
  private eyeHz = 0;
  private lastCaptureAt = 0;
  private directory = "";
  private fast: boolean | null = null;
  error: string | null = null;
  status() {
    return {
      captureMs: this.captureMs,
      frames: this.completed,
      busy: this.busy,
      error: this.error,
      fast: this.fast,
      eyeHz: this.eyeHz,
    };
  }
  poll() {
    if (this.stopped || this.busy || Date.now() < this.nextAt) return;
    this.busy = true;
    void this.capture().catch((e) => {
      this.error = String(e);
    }).finally(() => {
      this.busy = false;
      this.nextAt = Date.now() + (this.fast ? 0 : 50);
    });
  }
  private async capture() {
    const started = performance.now();
    if (!this.directory) this.directory = await Deno.makeTempDir({ prefix: "petplay-driver-eye-" });
    const driver = await SyntheticDriver.attach();
    let capture: { layers?: [Eye, Eye][]; eye?: Eye } | null = null;
    try {
      if (this.fast !== false) {
        try {
          capture = await driver.send("CAPTUREDIRECTEYE", {
            directory: this.directory,
            layer: 0,
            eye: 0,
            maxEdge: 1024,
          });
          this.fast = true;
        } catch (e) {
          if (!String(e).includes("Unsupported native actor message")) throw e;
          this.fast = false;
        }
      }
      if (!capture) {
        capture = await driver.send("CAPTUREDIRECTFRAME", { directory: this.directory });
      }
      const eye = capture!.eye ?? capture!.layers?.[0]?.[0];
      if (!eye) throw Error("No presented VRChat layer");
      const pixels = await Deno.readFile(`${this.directory}/${eye.file}`);
      if (pixels.length !== eye.width * eye.height * 4) throw Error("Short driver image");
      if (![37, 43, 44, 50].includes(eye.format)) {
        throw Error(`Unsupported eye format ${eye.format}`);
      }
      if (!this.stopped) {
        this.pending = { eye, pixels, capturedAt: Date.now() - (performance.now() - started) };
        this.error = null;
        this.captureMs = performance.now() - started;
        this.completed++;
        const at = performance.now();
        if (this.lastCaptureAt) {
          const hz = 1000 / (at - this.lastCaptureAt);
          this.eyeHz = this.eyeHz ? this.eyeHz * .8 + hz * .2 : hz;
        }
        this.lastCaptureAt = at;
      }
    } finally {
      driver.close();
      for (const eye of capture?.eye ? [capture.eye] : capture?.layers?.flat() ?? []) {
        await Deno.remove(`${this.directory}/${eye.file}`).catch(() => {});
      }
      if (this.stopped && this.directory) await Deno.remove(this.directory).catch(() => {});
    }
  }
  draw() {
    if (this.pending) {
      const { eye, pixels, capturedAt } = this.pending;
      this.pending = null;
      if (!this.shader || this.format !== eye.format) {
        if (this.shader) raylib.H.UnloadShader(this.shader);
        // The first presented layer is opaque even if the app submits alpha zero.
        this.shader = raylib.H.LoadShaderFromMemory(
          null,
          `#version 330
in vec2 fragTexCoord;uniform sampler2D texture0;out vec4 finalColor;
void main(){vec4 c=texture(texture0,fragTexCoord);finalColor=vec4(c.${
            [44, 50].includes(eye.format) ? "bgr" : "rgb"
          },1.0);}`,
        );
        this.format = eye.format;
      }
      if (!this.texture || this.texture.width !== eye.width || this.texture.height !== eye.height) {
        if (this.texture) raylib.H.UnloadTexture(this.texture);
        this.texture = raylib.H.LoadTextureFromImage(
          {
            data: Deno.UnsafePointer.value(Deno.UnsafePointer.of(pixels)!),
            width: eye.width,
            height: eye.height,
            mipmaps: 1,
            format: raylib.PixelFormat.PIXELFORMAT_UNCOMPRESSED_R8G8B8A8,
          } as never,
        );
        raylib.H.SetTextureFilter(this.texture, raylib.TextureFilter.TEXTURE_FILTER_BILINEAR);
      } else raylib.H.UpdateTexture(this.texture, Deno.UnsafePointer.of(pixels));
      this.bounds = eye.bounds;
      this.frameAt = capturedAt;
    }
    raylib.H.ClearBackground({ r: 8, g: 8, b: 10, a: 255 });
    if (this.texture) {
      if (this.shader) raylib.H.BeginShaderMode(this.shader);
      const [u0, v0, u1, v1] = this.bounds,
        sw = (u1 - u0) * this.texture.width,
        sh = (v1 - v0) * this.texture.height;
      const scale = Math.min(raylib.GetScreenWidth() / sw, (raylib.GetScreenHeight() - 62) / sh);
      raylib.H.DrawTexturePro(
        this.texture,
        { x: u0 * this.texture.width, y: v0 * this.texture.height, width: sw, height: sh },
        {
          x: (raylib.GetScreenWidth() - sw * scale) / 2,
          y: 62,
          width: sw * scale,
          height: sh * scale,
        },
        { x: 0, y: 0 },
        0,
        { r: 255, g: 255, b: 255, a: 255 },
      );
      if (this.shader) raylib.EndShaderMode();
    }
    raylib.H.DrawText(
      this.error ??
        `DRIVER LEFT EYE | I: Stream camera | ${
          this.fast ? "single-eye GPU resize" : "legacy readback"
        } | age ${this.frameAt ? Math.round(Date.now() - this.frameAt) : "waiting"} ms`,
      16,
      38,
      18,
      { r: 255, g: 210, b: 120, a: 255 },
    );
  }
  dispose() {
    this.stopped = true;
    this.pending = null;
    if (this.texture) raylib.H.UnloadTexture(this.texture);
    if (this.shader) raylib.H.UnloadShader(this.shader);
    this.shader = null;
    this.texture = null;
    if (!this.busy && this.directory) void Deno.remove(this.directory).catch(() => {});
  }
}
