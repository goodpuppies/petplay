import { assert, type MappedTextureReadback, TextureReadbackRing } from "./webgpu.ts";

type StereoProcessorOptions = {
  outputWidth?: number;
  outputHeight?: number;
  halfFovRadians?: number;
  flipY?: boolean;
  swapEyes?: boolean;
};

type ProcessorUniforms = {
  lookRotation?: Float32Array;
  halfFovRadians: number;
  flipY?: boolean;
  swapEyes?: boolean;
};

const DEFAULT_HALF_FOV_RADIANS = (112 / 2) * (Math.PI / 180);
const UNIFORM_FLOAT_COUNT = 20;
const UNIFORM_BUFFER_SIZE = UNIFORM_FLOAT_COUNT * Float32Array.BYTES_PER_ELEMENT;

const SHADER_SOURCE = `
struct Uniforms {
  lookRotation : mat4x4<f32>,
  params : vec4<f32>,
};

@group(0) @binding(0) var inputTexture : texture_2d<f32>;
@group(0) @binding(1) var inputSampler : sampler;
@group(0) @binding(2) var<uniform> uniforms : Uniforms;

struct VertexOutput {
  @builtin(position) position : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

@vertex
fn vsMain(@builtin(vertex_index) vertexIndex : u32) -> VertexOutput {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -3.0),
    vec2<f32>(-1.0, 1.0),
    vec2<f32>(3.0, 1.0),
  );
  var output : VertexOutput;
  let position = positions[vertexIndex];
  output.position = vec4<f32>(position, 0.0, 1.0);
  output.uv = position * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5, 0.5);
  return output;
}

@fragment
fn fsMain(input : VertexOutput) -> @location(0) vec4<f32> {
  let PI = 3.141592653589793;
  let HALF_PI = 0.5 * PI;
  let QUARTER_PI = 0.25 * PI;

  var xy = vec2<f32>(input.uv.x, 1.0 - input.uv.y);
  xy = 2.0 * xy - vec2<f32>(1.0, 1.0);
  xy = xy * vec2<f32>(PI, HALF_PI);
  xy.y = xy.y * 2.0;

  let isTop = xy.y >= 0.0;
  if (isTop) {
    xy.y = xy.y - HALF_PI;
  } else {
    xy.y = xy.y + HALF_PI;
  }

  let fovScalar = tan(uniforms.params.z) / tan(QUARTER_PI);
  var lookupDirection = vec3<f32>(sin(xy.x), 1.0, cos(xy.x)) *
    vec3<f32>(cos(xy.y), sin(xy.y), cos(xy.y));
  lookupDirection = (uniforms.lookRotation * vec4<f32>(lookupDirection, 0.0)).xyz;

  var eyeUv = vec2<f32>(
    (((lookupDirection.x / max(abs(lookupDirection.z), 0.0001)) / fovScalar) + 1.0) * 0.5,
    1.0 - ((((lookupDirection.y / max(abs(lookupDirection.z), 0.0001)) / fovScalar) + 1.0) * 0.5),
  );
  eyeUv = clamp(eyeUv, vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 1.0));
  if (uniforms.params.x > 0.5) {
    eyeUv.y = 1.0 - eyeUv.y;
  }

  let useLeftHalf = select(isTop, !isTop, uniforms.params.y > 0.5);
  let sampleUv = vec2<f32>(
    eyeUv.x * 0.5 + select(0.5, 0.0, useLeftHalf),
    eyeUv.y,
  );
  return textureSample(inputTexture, inputSampler, sampleUv);
}
`;

export class WebXRStereoProcessor {
  private sourceTexture: GPUTexture | null = null;
  private outputTexture: GPUTexture | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private sourceWidth = 0;
  private sourceHeight = 0;
  private outputWidth = 0;
  private outputHeight = 0;
  private readonly sampler: GPUSampler;
  private readonly uniformBuffer: GPUBuffer;
  private readonly pipeline: GPURenderPipeline;
  private readonly uniformData = new Float32Array(UNIFORM_FLOAT_COUNT);
  private readonly outputReadbackRing: TextureReadbackRing;

  constructor(
    private readonly device: GPUDevice,
    private readonly options: StereoProcessorOptions = {},
  ) {
    this.outputReadbackRing = new TextureReadbackRing(device, 3);
    this.sampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_BUFFER_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const module = device.createShaderModule({ code: SHADER_SOURCE });
    this.pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module,
        entryPoint: "vsMain",
      },
      fragment: {
        module,
        entryPoint: "fsMain",
        targets: [{ format: "rgba8unorm" }],
      },
      primitive: {
        topology: "triangle-list",
      },
    });
  }

  async process(frame: MappedTextureReadback): Promise<MappedTextureReadback | null> {
    this.ensureTextures(frame.width, frame.height);
    this.writeSourceTexture(frame);
    this.render();
    const outputTexture = this.outputTexture;
    assert(outputTexture, "Stereo processor output texture missing");
    const processed = await this.outputReadbackRing.capture(
      outputTexture,
      this.outputWidth,
      this.outputHeight,
      0,
      "rgba",
    );
    return processed;
  }

  cleanup() {
    this.sourceTexture?.destroy();
    this.outputTexture?.destroy();
    this.outputReadbackRing.cleanup();
    this.uniformBuffer.destroy();
    this.sourceTexture = null;
    this.outputTexture = null;
    this.bindGroup = null;
    this.sourceWidth = 0;
    this.sourceHeight = 0;
    this.outputWidth = 0;
    this.outputHeight = 0;
  }

  private ensureTextures(sourceWidth: number, sourceHeight: number) {
    const outputWidth = this.options.outputWidth ?? 4096;
    const outputHeight = this.options.outputHeight ?? 4096;
    const matches = this.sourceTexture &&
      this.outputTexture &&
      this.sourceWidth === sourceWidth &&
      this.sourceHeight === sourceHeight &&
      this.outputWidth === outputWidth &&
      this.outputHeight === outputHeight;
    if (matches) {
      return;
    }

    this.sourceTexture?.destroy();
    this.outputTexture?.destroy();
    this.sourceTexture = this.device.createTexture({
      size: { width: sourceWidth, height: sourceHeight },
      format: "rgba8unorm",
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.outputTexture = this.device.createTexture({
      size: { width: outputWidth, height: outputHeight },
      format: "rgba8unorm",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    this.sourceWidth = sourceWidth;
    this.sourceHeight = sourceHeight;
    this.outputWidth = outputWidth;
    this.outputHeight = outputHeight;
    this.bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.sourceTexture.createView() },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: { buffer: this.uniformBuffer } },
      ],
    });
    this.writeUniforms({
      halfFovRadians: this.options.halfFovRadians ?? DEFAULT_HALF_FOV_RADIANS,
      flipY: this.options.flipY,
      swapEyes: this.options.swapEyes,
    });
  }

  private writeSourceTexture(frame: MappedTextureReadback) {
    this.device.queue.writeTexture(
      { texture: this.requireTexture(this.sourceTexture) },
      new Uint8Array(frame.arrayBuffer),
      {
        offset: 0,
        bytesPerRow: frame.bytesPerRow,
        rowsPerImage: frame.height,
      },
      {
        width: frame.width,
        height: frame.height,
        depthOrArrayLayers: 1,
      },
    );
  }

  setLookRotation(lookRotation: Float32Array | null) {
    this.writeUniforms({
      lookRotation: lookRotation ?? undefined,
      halfFovRadians: this.options.halfFovRadians ?? DEFAULT_HALF_FOV_RADIANS,
      flipY: this.options.flipY,
      swapEyes: this.options.swapEyes,
    });
  }

  private writeUniforms(uniforms: ProcessorUniforms) {
    this.uniformData.fill(0);
    if (uniforms.lookRotation) {
      this.uniformData.set(uniforms.lookRotation, 0);
    } else {
      this.uniformData[0] = 1;
      this.uniformData[5] = 1;
      this.uniformData[10] = 1;
      this.uniformData[15] = 1;
    }
    this.uniformData[18] = uniforms.halfFovRadians;
    this.uniformData[16] = uniforms.flipY ? 1 : 0;
    this.uniformData[17] = uniforms.swapEyes ? 1 : 0;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);
  }

  private render() {
    const outputTexture = this.requireTexture(this.outputTexture);
    const bindGroup = this.bindGroup;
    assert(bindGroup, "Stereo processor bind group missing");
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: outputTexture.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  private requireTexture(texture: GPUTexture | null): GPUTexture {
    assert(texture, "Stereo processor texture missing");
    return texture;
  }
}
