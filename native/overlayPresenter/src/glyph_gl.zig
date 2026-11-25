// Single-FFI-call OpenGL batch submitter for Glyph (Slug) text rendering on Linux.
// Eliminates ~20-30 per-root Deno UnsafeFnPointer FFI crossings per eye.
const std = @import("std");
const builtin = @import("builtin");

const GL_TRIANGLES: u32 = 0x0004;
const GL_DEPTH_TEST: u32 = 0x0B71;
const GL_TEXTURE_2D: u32 = 0x0DE1;
const GL_TEXTURE0: u32 = 0x84C0;
const GL_ARRAY_BUFFER: u32 = 0x8892;
const GL_STREAM_DRAW: u32 = 0x88E0;

const GlProcs = struct {
    glUseProgram: *const fn (u32) callconv(.c) void,
    glUniform1f: *const fn (i32, f32) callconv(.c) void,
    glUniform2f: *const fn (i32, f32, f32) callconv(.c) void,
    glBindVertexArray: *const fn (u32) callconv(.c) void,
    glDisable: *const fn (u32) callconv(.c) void,
    glEnable: *const fn (u32) callconv(.c) void,
    glDepthMask: *const fn (u8) callconv(.c) void,
    glBindBuffer: *const fn (u32, u32) callconv(.c) void,
    glBufferData: *const fn (u32, isize, ?*const anyopaque, u32) callconv(.c) void,
    glActiveTexture: *const fn (u32) callconv(.c) void,
    glBindTexture: *const fn (u32, u32) callconv(.c) void,
    glDrawArraysInstancedBaseInstance: *const fn (u32, i32, i32, i32, u32) callconv(.c) void,
};

extern fn glXGetProcAddressARB(procName: [*:0]const u8) ?*const anyopaque;

var cached_procs: ?GlProcs = null;
var tried_load: bool = false;

fn getProc(comptime T: type, name: [*:0]const u8) ?T {
    const p = glXGetProcAddressARB(name) orelse return null;
    return @ptrCast(@alignCast(p));
}

fn ensureProcs() ?*const GlProcs {
    if (builtin.os.tag != .linux) return null;
    if (cached_procs != null) return &cached_procs.?;
    if (tried_load) return null;
    tried_load = true;
    cached_procs = .{
        .glUseProgram = getProc(*const fn (u32) callconv(.c) void, "glUseProgram") orelse return null,
        .glUniform1f = getProc(*const fn (i32, f32) callconv(.c) void, "glUniform1f") orelse return null,
        .glUniform2f = getProc(*const fn (i32, f32, f32) callconv(.c) void, "glUniform2f") orelse return null,
        .glBindVertexArray = getProc(*const fn (u32) callconv(.c) void, "glBindVertexArray") orelse return null,
        .glDisable = getProc(*const fn (u32) callconv(.c) void, "glDisable") orelse return null,
        .glEnable = getProc(*const fn (u32) callconv(.c) void, "glEnable") orelse return null,
        .glDepthMask = getProc(*const fn (u8) callconv(.c) void, "glDepthMask") orelse return null,
        .glBindBuffer = getProc(*const fn (u32, u32) callconv(.c) void, "glBindBuffer") orelse return null,
        .glBufferData = getProc(*const fn (u32, isize, ?*const anyopaque, u32) callconv(.c) void, "glBufferData") orelse return null,
        .glActiveTexture = getProc(*const fn (u32) callconv(.c) void, "glActiveTexture") orelse return null,
        .glBindTexture = getProc(*const fn (u32, u32) callconv(.c) void, "glBindTexture") orelse return null,
        .glDrawArraysInstancedBaseInstance = getProc(*const fn (u32, i32, i32, i32, u32) callconv(.c) void, "glDrawArraysInstancedBaseInstance") orelse return null,
    };
    return &cached_procs.?;
}

// header[10]:
//   [0] program
//   [1] vao
//   [2] instance_buffer
//   [3] run_count
//   [4] restore_depth_test (0 or 1)
//   [5] uniform_flags (bit0=exp, bit1=weight, bit2=aa, bit3=viewport)
//   [6] u_exponent_loc (bitcast i32)
//   [7] u_weight_loc   (bitcast i32)
//   [8] u_aa_loc       (bitcast i32)
//   [9] u_viewport_loc (bitcast i32)
// uniforms[5]: [exponent, weight, aa_width, vp_w, vp_h]
// runs[run_count * 5]: [tex0, tex1, tex2, first, count]
pub export fn pp_glyph_draw_fast(
    header_ptr: ?[*]const u32,
    uniforms_ptr: ?[*]const f32,
    runs_ptr: ?[*]const u32,
    instance_data: ?*const anyopaque,
    instance_bytes: usize,
) i32 {
    const gl = ensureProcs() orelse return -1;
    const h = header_ptr orelse return -2;
    const u = uniforms_ptr orelse return -2;
    const runs = runs_ptr orelse return -2;

    const program = h[0];
    const vao = h[1];
    const instance_buffer = h[2];
    const run_count = h[3];
    const restore_depth_test = h[4];
    const flags = h[5];

    gl.glUseProgram(program);
    if ((flags & 1) != 0) gl.glUniform1f(@bitCast(h[6]), u[0]);
    if ((flags & 2) != 0) gl.glUniform1f(@bitCast(h[7]), u[1]);
    if ((flags & 4) != 0) gl.glUniform1f(@bitCast(h[8]), u[2]);
    if ((flags & 8) != 0) gl.glUniform2f(@bitCast(h[9]), u[3], u[4]);

    gl.glBindVertexArray(vao);
    gl.glDisable(GL_DEPTH_TEST);
    gl.glDepthMask(0);
    gl.glBindBuffer(GL_ARRAY_BUFFER, instance_buffer);
    gl.glBufferData(GL_ARRAY_BUFFER, @intCast(instance_bytes), instance_data, GL_STREAM_DRAW);

    var r: u32 = 0;
    while (r < run_count) : (r += 1) {
        const base = @as(usize, r) * 5;
        gl.glActiveTexture(GL_TEXTURE0);
        gl.glBindTexture(GL_TEXTURE_2D, runs[base]);
        gl.glActiveTexture(GL_TEXTURE0 + 1);
        gl.glBindTexture(GL_TEXTURE_2D, runs[base + 1]);
        gl.glActiveTexture(GL_TEXTURE0 + 2);
        gl.glBindTexture(GL_TEXTURE_2D, runs[base + 2]);
        gl.glDrawArraysInstancedBaseInstance(
            GL_TRIANGLES,
            0,
            6,
            @bitCast(runs[base + 4]),
            runs[base + 3],
        );
    }

    gl.glActiveTexture(GL_TEXTURE0);
    gl.glBindTexture(GL_TEXTURE_2D, 0);
    gl.glUseProgram(0);
    gl.glBindVertexArray(0);
    gl.glBindBuffer(GL_ARRAY_BUFFER, 0);
    if (restore_depth_test != 0) gl.glEnable(GL_DEPTH_TEST);
    return 0;
}
