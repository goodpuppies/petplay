// Pure Zig native overlay presenter for PetPlay (FnTable:IVROverlay_027).
// Exports both the legacy GL presenter functions and the Linux DMA-BUF bank-flipping presenter.
const std = @import("std");
const builtin = @import("builtin");

pub const c = @cImport({
    @cInclude("openvr_capi.h");
    if (builtin.os.tag == .linux) {
        @cInclude("GL/gl.h");
    }
});

pub const dmabuf_banks = @import("dmabuf_banks.zig");
pub const glyph_gl = @import("glyph_gl.zig");

comptime {
    // Force export of all DMA-BUF bank and GL batch helper symbols in the shared library.
    _ = dmabuf_banks;
    _ = glyph_gl;
}

pub fn nowMs() f64 {
    var ts: std.c.timespec = undefined;
    _ = std.c.clock_gettime(.MONOTONIC, &ts);
    return @as(f64, @floatFromInt(ts.sec)) * 1000.0 + @as(f64, @floatFromInt(ts.nsec)) / 1_000_000.0;
}

pub export fn pp_overlay_abi() u32 {
    return if (std.mem.eql(u8, std.mem.span(c.IVROverlay_Version), "IVROverlay_027")) 27 else 0;
}

// stats: [0] GPU finish ms, [1] wait ms, [2] publication ms, [3] completed setters,
//        [4] error, [5] wait result.
pub export fn pp_overlay_finish(stats_ptr: ?[*]f64) i32 {
    const stats = stats_ptr orelse return -1;
    @memset(stats[0..6], 0.0);
    if (builtin.os.tag == .linux) {
        if (c.glGetString(c.GL_VERSION) == null) {
            stats[4] = -2.0;
            return -2;
        }
        const t = nowMs();
        c.glFinish();
        stats[0] = nowMs() - t;
        return 0;
    }
    return 0;
}

pub export fn pp_overlay_wait(api_ptr: ?*c.VR_IVROverlay_FnTable, timeout_ms: u32) i32 {
    const api = api_ptr orelse return -1;
    if (timeout_ms == 0) return -1;
    const wait_fn = api.WaitFrameSync orelse return -1;
    return @intCast(wait_fn(timeout_ms));
}

pub export fn pp_overlay_publish(
    api_ptr: ?*c.VR_IVROverlay_FnTable,
    left: u64,
    right: u64,
    lt: u32,
    rt: u32,
    views_ptr: ?[*]const f32,
    frusta_ptr: ?[*]const f32,
    show: u32,
    stats_ptr: ?[*]f64,
) i32 {
    const api = api_ptr orelse return -1;
    const views = views_ptr orelse return -1;
    const frusta = frusta_ptr orelse return -1;
    const stats = stats_ptr orelse return -1;
    if (left == 0 or right == 0 or lt == 0 or rt == 0) return -1;

    const set_tex = api.SetOverlayTexture orelse return -1;
    const set_proj = api.SetOverlayTransformProjection orelse return -1;
    const show_ov = api.ShowOverlay orelse return -1;

    const t = nowMs();
    const handles = [2]u64{ left, right };
    const textures = [2]u32{ lt, rt };
    var err: i32 = 0;

    for (0..2) |i| {
        if (err != 0) break;
        var texture = c.Texture_t{
            .handle = @ptrFromInt(@as(usize, textures[i])),
            .eType = c.ETextureType_TextureType_OpenGL,
            .eColorSpace = c.EColorSpace_ColorSpace_Auto,
        };
        err = @intCast(set_tex(handles[i], &texture));
        if (err == 0) stats[3] += 1.0;
    }

    for (0..2) |i| {
        if (err != 0) break;
        var view: c.HmdMatrix34_t = undefined;
        var projection: c.VROverlayProjection_t = undefined;
        @memcpy(std.mem.asBytes(&view), std.mem.sliceAsBytes(views[i * 12 .. i * 12 + 12]));
        @memcpy(std.mem.asBytes(&projection), std.mem.sliceAsBytes(frusta[i * 4 .. i * 4 + 4]));
        err = @intCast(set_proj(
            handles[i],
            c.ETrackingUniverseOrigin_TrackingUniverseStanding,
            &view,
            &projection,
            @intCast(i),
        ));
        if (err == 0) stats[3] += 1.0;
    }

    if (show != 0 and err == 0) {
        for (0..2) |i| {
            if (err != 0) break;
            err = @intCast(show_ov(handles[i]));
        }
    }

    stats[2] = nowMs() - t;
    stats[4] = @floatFromInt(err);
    return err;
}

pub export fn pp_overlay_publish_texture(
    api_ptr: ?*c.VR_IVROverlay_FnTable,
    handle: u64,
    tex: u32,
    stats_ptr: ?[*]f64,
) i32 {
    const api = api_ptr orelse return -1;
    const stats = stats_ptr orelse return -1;
    if (handle == 0 or tex == 0) return -1;
    const set_tex = api.SetOverlayTexture orelse return -1;

    const t = nowMs();
    var texture = c.Texture_t{
        .handle = @ptrFromInt(@as(usize, tex)),
        .eType = c.ETextureType_TextureType_OpenGL,
        .eColorSpace = c.EColorSpace_ColorSpace_Auto,
    };
    const err: i32 = @intCast(set_tex(handle, &texture));
    if (err == 0) stats[3] += 1.0;
    stats[2] = nowMs() - t;
    stats[4] = @floatFromInt(err);
    return err;
}

fn timedWait(api: *c.VR_IVROverlay_FnTable, timeout_ms: u32, stats: [*]f64) i32 {
    const wait_fn = api.WaitFrameSync orelse return -1;
    const t = nowMs();
    const wait_res: i32 = @intCast(wait_fn(timeout_ms));
    stats[1] = nowMs() - t;
    stats[5] = @floatFromInt(wait_res);
    if (wait_res != c.EVROverlayError_VROverlayError_None) {
        stats[4] = @floatFromInt(wait_res);
    }
    return wait_res;
}

pub export fn pp_overlay_present(
    api_ptr: ?*c.VR_IVROverlay_FnTable,
    left: u64,
    right: u64,
    lt: u32,
    rt: u32,
    views_ptr: ?[*]const f32,
    frusta_ptr: ?[*]const f32,
    timeout_ms: u32,
    show: u32,
    stats_ptr: ?[*]f64,
) i32 {
    const api = api_ptr orelse return -1;
    const stats = stats_ptr orelse return -1;
    if (views_ptr == null or frusta_ptr == null or left == 0 or right == 0 or lt == 0 or rt == 0 or timeout_ms == 0) {
        return -1;
    }
    const fin = pp_overlay_finish(stats);
    if (fin != 0) return fin;
    const w = timedWait(api, timeout_ms, stats);
    if (w != 0) return w;
    return pp_overlay_publish(api, left, right, lt, rt, views_ptr, frusta_ptr, show, stats);
}

pub export fn pp_overlay_present_texture(
    api_ptr: ?*c.VR_IVROverlay_FnTable,
    handle: u64,
    tex: u32,
    timeout_ms: u32,
    stats_ptr: ?[*]f64,
) i32 {
    const api = api_ptr orelse return -1;
    const stats = stats_ptr orelse return -1;
    if (handle == 0 or tex == 0 or timeout_ms == 0) return -1;
    const fin = pp_overlay_finish(stats);
    if (fin != 0) return fin;
    const w = timedWait(api, timeout_ms, stats);
    if (w != 0) return w;
    return pp_overlay_publish_texture(api, handle, tex, stats);
}

// ---- Unit tests (no SteamVR or GL context required) ----

const TestState = struct {
    var calls: [16]i32 = undefined;
    var count: usize = 0;
    var wait_result: c.EVROverlayError = c.EVROverlayError_VROverlayError_None;

    fn push(v: i32) void {
        calls[count] = v;
        count += 1;
    }
    fn reset() void {
        count = 0;
    }
    fn waitFrame(_: u32) callconv(.c) c.EVROverlayError {
        push(0);
        return wait_result;
    }
    fn setTex(h: u64, tex: ?*const c.Texture_t) callconv(.c) c.EVROverlayError {
        if (tex != null and tex.?.eType == 8) push(@as(i32, @intCast(h)) + 100) else push(@intCast(h));
        return c.EVROverlayError_VROverlayError_None;
    }
    fn setProj(h: u64, _: c.ETrackingUniverseOrigin, _: ?*const c.HmdMatrix34_t, _: ?*const c.VROverlayProjection_t, _: c.EVREye) callconv(.c) c.EVROverlayError {
        push(@as(i32, @intCast(h)) + 10);
        return c.EVROverlayError_VROverlayError_None;
    }
    fn showOv(h: u64) callconv(.c) c.EVROverlayError {
        push(@as(i32, @intCast(h)) + 20);
        return c.EVROverlayError_VROverlayError_None;
    }
    fn hideOv(h: u64) callconv(.c) c.EVROverlayError {
        push(@as(i32, @intCast(h)) + 30);
        return c.EVROverlayError_VROverlayError_None;
    }
};

test "ABI version and bank flip / projection ordering" {
    try std.testing.expectEqual(@as(u32, 27), pp_overlay_abi());

    var api: c.VR_IVROverlay_FnTable = std.mem.zeroes(c.VR_IVROverlay_FnTable);
    api.WaitFrameSync = TestState.waitFrame;
    api.SetOverlayTexture = TestState.setTex;
    api.SetOverlayTransformProjection = TestState.setProj;
    api.ShowOverlay = TestState.showOv;
    api.HideOverlay = TestState.hideOv;

    var views = [_]f32{0} ** 24;
    var frusta = [_]f32{0} ** 8;
    var stats = [_]f64{0} ** 6;

    TestState.reset();
    try std.testing.expectEqual(@as(i32, 0), dmabuf_banks.pp_dmabuf_bank_bind_overlay(&api, 1, 999));
    try std.testing.expectEqualSlices(i32, &.{101}, TestState.calls[0..TestState.count]);

    TestState.reset();
    try std.testing.expectEqual(@as(i32, 0), dmabuf_banks.pp_overlay_set_projection(&api, 3, 4, &views, &frusta));
    try std.testing.expectEqualSlices(i32, &.{ 13, 14 }, TestState.calls[0..TestState.count]);

    TestState.reset();
    try std.testing.expectEqual(@as(i32, 0), dmabuf_banks.pp_overlay_flip_banks(&api, 3, 4, 1, 2, &stats));
    try std.testing.expectEqualSlices(i32, &.{ 23, 24, 31, 32 }, TestState.calls[0..TestState.count]);
    try std.testing.expectEqual(@as(f64, 4.0), stats[3]);

    TestState.reset();
    TestState.wait_result = c.EVROverlayError_VROverlayError_TimedOut;
    try std.testing.expectEqual(@as(i32, c.EVROverlayError_VROverlayError_TimedOut), pp_overlay_wait(&api, 100));
    try std.testing.expectEqual(@as(i32, -1), pp_overlay_wait(&api, 0));
}
