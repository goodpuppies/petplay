// Pure Zig Windows D3D11 + DXGI + WGL_NV_DX_interop2 shared bank pool and GL sync fences.
// Dynamically loads d3d11.dll, dxgi.dll, opengl32.dll, and WGL_NV_DX_interop2 entry points at
// runtime: zero C++ runtime, zero Windows SDK link dependencies, cross-compiles cleanly from Linux.
const std = @import("std");
const builtin = @import("builtin");
const presenter = @import("presenter.zig");
const c = presenter.c;

const is_windows = builtin.os.tag == .windows;

// ---- Win32 / WGL / OpenGL minimal externs (only referenced on Windows) ----

const HMODULE = ?*anyopaque;
const HANDLE = ?*anyopaque;
const HRESULT = i32;
const BOOL = i32;

const GUID = extern struct {
    Data1: u32,
    Data2: u16,
    Data3: u16,
    Data4: [8]u8,
};

const IID_IDXGIFactory1 = GUID{
    .Data1 = 0x770aae78,
    .Data2 = 0xf26f,
    .Data3 = 0x4dba,
    .Data4 = .{ 0xa8, 0x29, 0x25, 0x3c, 0x83, 0xd1, 0xb3, 0x87 },
};

const IID_IDXGIResource = GUID{
    .Data1 = 0x035f3ab4,
    .Data2 = 0x482e,
    .Data3 = 0x4e50,
    .Data4 = .{ 0xb4, 0x1f, 0x8a, 0x7f, 0x8b, 0xd8, 0x96, 0x0b },
};

const DXGI_FORMAT_R8G8B8A8_UNORM: u32 = 28;
const D3D11_USAGE_DEFAULT: u32 = 0;
const D3D11_BIND_SHADER_RESOURCE: u32 = 0x8;
const D3D11_BIND_RENDER_TARGET: u32 = 0x20;
const D3D11_RESOURCE_MISC_SHARED: u32 = 0x2;
const D3D_DRIVER_TYPE_UNKNOWN: u32 = 0;
const D3D_DRIVER_TYPE_HARDWARE: u32 = 1;
const D3D_FEATURE_LEVEL_11_0: u32 = 0xb000;
const D3D11_SDK_VERSION: u32 = 7;

const DXGI_SAMPLE_DESC = extern struct {
    Count: u32,
    Quality: u32,
};

const D3D11_TEXTURE2D_DESC = extern struct {
    Width: u32,
    Height: u32,
    MipLevels: u32,
    ArraySize: u32,
    Format: u32,
    SampleDesc: DXGI_SAMPLE_DESC,
    Usage: u32,
    BindFlags: u32,
    CPUAccessFlags: u32,
    MiscFlags: u32,
};

comptime {
    if (@sizeOf(D3D11_TEXTURE2D_DESC) != 44) {
        @compileError("D3D11_TEXTURE2D_DESC ABI mismatch");
    }
}

// COM vtables (exact Windows x86_64 slot indices).
const IUnknownVtable = extern struct {
    QueryInterface: *const fn (*anyopaque, *const GUID, *?*anyopaque) callconv(.winapi) HRESULT,
    AddRef: *const fn (*anyopaque) callconv(.winapi) u32,
    Release: *const fn (*anyopaque) callconv(.winapi) u32,
};

const IDXGIFactory1Vtable = extern struct {
    // IUnknown (0..2)
    QueryInterface: *const fn (*anyopaque, *const GUID, *?*anyopaque) callconv(.winapi) HRESULT,
    AddRef: *const fn (*anyopaque) callconv(.winapi) u32,
    Release: *const fn (*anyopaque) callconv(.winapi) u32,
    // IDXGIObject (3..6)
    SetPrivateData: *const anyopaque,
    SetPrivateDataInterface: *const anyopaque,
    GetPrivateData: *const anyopaque,
    GetParent: *const anyopaque,
    // IDXGIFactory (7..11)
    EnumAdapters: *const anyopaque,
    MakeWindowAssociation: *const anyopaque,
    GetWindowAssociation: *const anyopaque,
    CreateSwapChain: *const anyopaque,
    CreateSoftwareAdapter: *const anyopaque,
    // IDXGIFactory1 (12..13)
    EnumAdapters1: *const fn (*anyopaque, u32, *?*anyopaque) callconv(.winapi) HRESULT,
    IsCurrent: *const anyopaque,
};

const ID3D11DeviceVtable = extern struct {
    // IUnknown (0..2)
    QueryInterface: *const fn (*anyopaque, *const GUID, *?*anyopaque) callconv(.winapi) HRESULT,
    AddRef: *const fn (*anyopaque) callconv(.winapi) u32,
    Release: *const fn (*anyopaque) callconv(.winapi) u32,
    // ID3D11Device (3..5)
    CreateBuffer: *const anyopaque,
    CreateTexture1D: *const anyopaque,
    CreateTexture2D: *const fn (
        *anyopaque,
        *const D3D11_TEXTURE2D_DESC,
        ?*const anyopaque,
        *?*anyopaque,
    ) callconv(.winapi) HRESULT,
};

const IDXGIResourceVtable = extern struct {
    // IUnknown (0..2)
    QueryInterface: *const fn (*anyopaque, *const GUID, *?*anyopaque) callconv(.winapi) HRESULT,
    AddRef: *const fn (*anyopaque) callconv(.winapi) u32,
    Release: *const fn (*anyopaque) callconv(.winapi) u32,
    // IDXGIObject (3..6)
    SetPrivateData: *const anyopaque,
    SetPrivateDataInterface: *const anyopaque,
    GetPrivateData: *const anyopaque,
    GetParent: *const anyopaque,
    // IDXGIDeviceSubObject (7)
    GetDevice: *const anyopaque,
    // IDXGIResource (8)
    GetSharedHandle: *const fn (*anyopaque, *HANDLE) callconv(.winapi) HRESULT,
};

fn comRelease(obj: ?*anyopaque) void {
    const p = obj orelse return;
    const vtbl: *const *const IUnknownVtable = @ptrCast(@alignCast(p));
    _ = vtbl.*.Release(p);
}

const Win32 = if (is_windows) struct {
    extern "kernel32" fn LoadLibraryA(lpLibFileName: [*:0]const u8) callconv(.winapi) HMODULE;
    extern "kernel32" fn GetModuleHandleA(lpModuleName: ?[*:0]const u8) callconv(.winapi) HMODULE;
    extern "kernel32" fn GetProcAddress(hModule: HMODULE, lpProcName: [*:0]const u8) callconv(.winapi) ?*const anyopaque;
    extern "kernel32" fn FreeLibrary(hLibModule: HMODULE) callconv(.winapi) BOOL;
    extern "opengl32" fn wglGetProcAddress(lpszProc: [*:0]const u8) callconv(.winapi) ?*const anyopaque;
    extern "opengl32" fn glGetString(name: u32) callconv(.winapi) ?[*:0]const u8;
    extern "opengl32" fn glFinish() callconv(.winapi) void;
    extern "opengl32" fn glFlush() callconv(.winapi) void;
    extern "opengl32" fn glGenTextures(n: i32, textures: [*]u32) callconv(.winapi) void;
    extern "opengl32" fn glDeleteTextures(n: i32, textures: [*]const u32) callconv(.winapi) void;
    extern "opengl32" fn glBindTexture(target: u32, texture: u32) callconv(.winapi) void;
    extern "opengl32" fn glTexParameteri(target: u32, pname: u32, param: i32) callconv(.winapi) void;
    extern "opengl32" fn glGetError() callconv(.winapi) u32;
} else struct {};

// GL constants
const GL_VERSION: u32 = 0x1F02;
const GL_TEXTURE_2D: u32 = 0x0DE1;
const GL_TEXTURE_MAG_FILTER: u32 = 0x2800;
const GL_TEXTURE_MIN_FILTER: u32 = 0x2801;
const GL_TEXTURE_WRAP_S: u32 = 0x2802;
const GL_TEXTURE_WRAP_T: u32 = 0x2803;
const GL_LINEAR: i32 = 0x2601;
const GL_CLAMP_TO_EDGE: i32 = 0x812F;
const GL_FRAMEBUFFER: u32 = 0x8D40;
const GL_RENDERBUFFER: u32 = 0x8D41;
const GL_COLOR_ATTACHMENT0: u32 = 0x8CE0;
const GL_DEPTH_ATTACHMENT: u32 = 0x8D00;
const GL_DEPTH_COMPONENT24: u32 = 0x81A6;
const GL_FRAMEBUFFER_COMPLETE: u32 = 0x8CD5;
const GL_SYNC_GPU_COMMANDS_COMPLETE: u32 = 0x9117;
const GL_ALREADY_SIGNALED: u32 = 0x911A;
const GL_CONDITION_SATISFIED: u32 = 0x911C;
const GL_TIMEOUT_IGNORED: u64 = 0xFFFFFFFFFFFFFFFF;
const WGL_ACCESS_READ_WRITE_NV: u32 = 0x0001;

// Function pointer types
const PFN_CreateDXGIFactory1 = *const fn (*const GUID, *?*anyopaque) callconv(.winapi) HRESULT;
const PFN_D3D11CreateDevice = *const fn (
    ?*anyopaque,
    u32,
    HMODULE,
    u32,
    ?[*]const u32,
    u32,
    u32,
    *?*anyopaque,
    ?*u32,
    *?*anyopaque,
) callconv(.winapi) HRESULT;

const PFN_wglDXOpenDeviceNV = *const fn (*anyopaque) callconv(.winapi) HANDLE;
const PFN_wglDXCloseDeviceNV = *const fn (HANDLE) callconv(.winapi) BOOL;
const PFN_wglDXRegisterObjectNV = *const fn (HANDLE, *anyopaque, u32, u32, u32) callconv(.winapi) HANDLE;
const PFN_wglDXUnregisterObjectNV = *const fn (HANDLE, HANDLE) callconv(.winapi) BOOL;
const PFN_wglDXLockObjectsNV = *const fn (HANDLE, i32, [*]HANDLE) callconv(.winapi) BOOL;
const PFN_wglDXUnlockObjectsNV = *const fn (HANDLE, i32, [*]HANDLE) callconv(.winapi) BOOL;

const PFN_glGenFramebuffers = *const fn (i32, [*]u32) callconv(.winapi) void;
const PFN_glDeleteFramebuffers = *const fn (i32, [*]const u32) callconv(.winapi) void;
const PFN_glBindFramebuffer = *const fn (u32, u32) callconv(.winapi) void;
const PFN_glFramebufferTexture2D = *const fn (u32, u32, u32, u32, i32) callconv(.winapi) void;
const PFN_glCheckFramebufferStatus = *const fn (u32) callconv(.winapi) u32;
const PFN_glGenRenderbuffers = *const fn (i32, [*]u32) callconv(.winapi) void;
const PFN_glDeleteRenderbuffers = *const fn (i32, [*]const u32) callconv(.winapi) void;
const PFN_glBindRenderbuffer = *const fn (u32, u32) callconv(.winapi) void;
const PFN_glRenderbufferStorage = *const fn (u32, u32, i32, i32) callconv(.winapi) void;
const PFN_glFramebufferRenderbuffer = *const fn (u32, u32, u32, u32) callconv(.winapi) void;
const PFN_glFenceSync = *const fn (u32, u32) callconv(.winapi) ?*anyopaque;
const PFN_glClientWaitSync = *const fn (*anyopaque, u32, u64) callconv(.winapi) u32;
const PFN_glDeleteSync = *const fn (*anyopaque) callconv(.winapi) void;

pub fn loadWglProc(comptime T: type, comptime name: [:0]const u8) ?T {
    if (!is_windows) return null;
    if (Win32.wglGetProcAddress(name)) |p| {
        const addr = @intFromPtr(p);
        // WGL drivers return 0, 1, 2, 3, or -1 for unsupported procs.
        if (addr > 3 and addr != std.math.maxInt(usize)) {
            return @ptrCast(@alignCast(p));
        }
    }
    const gl_mod = Win32.GetModuleHandleA("opengl32.dll") orelse Win32.LoadLibraryA("opengl32.dll");
    if (gl_mod != null) {
        if (Win32.GetProcAddress(gl_mod, name)) |p| {
            return @ptrCast(@alignCast(p));
        }
    }
    return null;
}

const WglGlProcs = struct {
    dxOpenDevice: PFN_wglDXOpenDeviceNV,
    dxCloseDevice: PFN_wglDXCloseDeviceNV,
    dxRegisterObject: PFN_wglDXRegisterObjectNV,
    dxUnregisterObject: PFN_wglDXUnregisterObjectNV,
    dxLockObjects: PFN_wglDXLockObjectsNV,
    dxUnlockObjects: PFN_wglDXUnlockObjectsNV,
    genFramebuffers: PFN_glGenFramebuffers,
    deleteFramebuffers: PFN_glDeleteFramebuffers,
    bindFramebuffer: PFN_glBindFramebuffer,
    framebufferTexture2D: PFN_glFramebufferTexture2D,
    checkFramebufferStatus: PFN_glCheckFramebufferStatus,
    genRenderbuffers: PFN_glGenRenderbuffers,
    deleteRenderbuffers: PFN_glDeleteRenderbuffers,
    bindRenderbuffer: PFN_glBindRenderbuffer,
    renderbufferStorage: PFN_glRenderbufferStorage,
    framebufferRenderbuffer: PFN_glFramebufferRenderbuffer,

    fn load() ?WglGlProcs {
        return .{
            .dxOpenDevice = loadWglProc(PFN_wglDXOpenDeviceNV, "wglDXOpenDeviceNV") orelse return null,
            .dxCloseDevice = loadWglProc(PFN_wglDXCloseDeviceNV, "wglDXCloseDeviceNV") orelse return null,
            .dxRegisterObject = loadWglProc(PFN_wglDXRegisterObjectNV, "wglDXRegisterObjectNV") orelse return null,
            .dxUnregisterObject = loadWglProc(PFN_wglDXUnregisterObjectNV, "wglDXUnregisterObjectNV") orelse return null,
            .dxLockObjects = loadWglProc(PFN_wglDXLockObjectsNV, "wglDXLockObjectsNV") orelse return null,
            .dxUnlockObjects = loadWglProc(PFN_wglDXUnlockObjectsNV, "wglDXUnlockObjectsNV") orelse return null,
            .genFramebuffers = loadWglProc(PFN_glGenFramebuffers, "glGenFramebuffers") orelse return null,
            .deleteFramebuffers = loadWglProc(PFN_glDeleteFramebuffers, "glDeleteFramebuffers") orelse return null,
            .bindFramebuffer = loadWglProc(PFN_glBindFramebuffer, "glBindFramebuffer") orelse return null,
            .framebufferTexture2D = loadWglProc(PFN_glFramebufferTexture2D, "glFramebufferTexture2D") orelse return null,
            .checkFramebufferStatus = loadWglProc(PFN_glCheckFramebufferStatus, "glCheckFramebufferStatus") orelse return null,
            .genRenderbuffers = loadWglProc(PFN_glGenRenderbuffers, "glGenRenderbuffers") orelse return null,
            .deleteRenderbuffers = loadWglProc(PFN_glDeleteRenderbuffers, "glDeleteRenderbuffers") orelse return null,
            .bindRenderbuffer = loadWglProc(PFN_glBindRenderbuffer, "glBindRenderbuffer") orelse return null,
            .renderbufferStorage = loadWglProc(PFN_glRenderbufferStorage, "glRenderbufferStorage") orelse return null,
            .framebufferRenderbuffer = loadWglProc(PFN_glFramebufferRenderbuffer, "glFramebufferRenderbuffer") orelse return null,
        };
    }
};

const BankSlot = struct {
    d3d_tex: ?*anyopaque = null,
    shared_handle: HANDLE = null,
    interop_handle: HANDLE = null,
    gl_tex: u32 = 0,
    gl_fbo: u32 = 0,
    gl_depth_rbo: u32 = 0,
};

const DxgiBankPool = struct {
    d3d11_dll: HMODULE = null,
    dxgi_dll: HMODULE = null,
    d3d_device: ?*anyopaque = null,
    d3d_context: ?*anyopaque = null,
    dx_interop_device: HANDLE = null,
    gl: WglGlProcs,
    bank_count: u32 = 0,
    eye_count: u32 = 0,
    slot_count: usize = 0,
    slots: [6]BankSlot = [_]BankSlot{.{}} ** 6,
    bank_locked: [3]bool = .{ false, false, false },
};

// ---- Windows GL sync fences ----

pub fn fenceCreate() ?*anyopaque {
    if (!is_windows) return null;
    if (Win32.glGetString(GL_VERSION) == null) return null;
    if (loadWglProc(PFN_glFenceSync, "glFenceSync")) |f| {
        const sync = f(GL_SYNC_GPU_COMMANDS_COMPLETE, 0);
        Win32.glFlush();
        return sync;
    }
    Win32.glFlush();
    return null;
}

pub fn fenceWait(sync_ptr: ?*anyopaque, stats: [*]f64) i32 {
    @memset(stats[0..6], 0.0);
    if (!is_windows) return 0;
    if (Win32.glGetString(GL_VERSION) == null) {
        stats[4] = -2.0;
        return -2;
    }
    const t = presenter.nowMs();
    const pWait = loadWglProc(PFN_glClientWaitSync, "glClientWaitSync");
    const pDel = loadWglProc(PFN_glDeleteSync, "glDeleteSync");
    if (sync_ptr != null and pWait != null and pDel != null) {
        const res = pWait.?(sync_ptr.?, 0, GL_TIMEOUT_IGNORED);
        pDel.?(sync_ptr.?);
        if (res != GL_ALREADY_SIGNALED and res != GL_CONDITION_SATISFIED) {
            Win32.glFinish();
        }
    } else {
        Win32.glFinish();
    }
    stats[0] = presenter.nowMs() - t;
    return 0;
}

pub fn fenceDelete(sync_ptr: ?*anyopaque) void {
    if (!is_windows or sync_ptr == null) return;
    if (Win32.glGetString(GL_VERSION) == null) return;
    if (loadWglProc(PFN_glDeleteSync, "glDeleteSync")) |d| {
        d(sync_ptr.?);
    }
}

pub fn fenceFinish(stats: [*]f64) i32 {
    @memset(stats[0..6], 0.0);
    if (!is_windows) return 0;
    if (Win32.glGetString(GL_VERSION) == null) {
        stats[4] = -2.0;
        return -2;
    }
    const t = presenter.nowMs();
    const pFence = loadWglProc(PFN_glFenceSync, "glFenceSync");
    const pWait = loadWglProc(PFN_glClientWaitSync, "glClientWaitSync");
    const pDel = loadWglProc(PFN_glDeleteSync, "glDeleteSync");
    if (pFence != null and pWait != null and pDel != null) {
        if (pFence.?(GL_SYNC_GPU_COMMANDS_COMPLETE, 0)) |sync| {
            Win32.glFlush();
            const res = pWait.?(sync, 0, GL_TIMEOUT_IGNORED);
            pDel.?(sync);
            if (res != GL_ALREADY_SIGNALED and res != GL_CONDITION_SATISFIED) {
                Win32.glFinish();
            }
        } else {
            Win32.glFinish();
        }
    } else {
        Win32.glFinish();
    }
    stats[0] = presenter.nowMs() - t;
    return 0;
}

// ---- Windows DXGI + WGL_NV_DX_interop2 bank pool ----

pub fn createPool(
    vr_system_ptr: ?*anyopaque,
    width: u32,
    height: u32,
    bank_count: u32,
    eye_count: u32,
    out_fbos: [*]u32,
    out_color_textures: [*]u32,
    out_depth_rbos: [*]u32,
    out_shared_handles: [*]u64,
    setError: *const fn ([]const u8) void,
) ?*anyopaque {
    if (!is_windows) {
        setError("DXGI bank pool is Windows-only");
        return null;
    }
    if (Win32.glGetString(GL_VERSION) == null) {
        setError("No current OpenGL/WGL context");
        return null;
    }
    const gl = WglGlProcs.load() orelse {
        setError("WGL_NV_DX_interop2 or GL FBO entry points unavailable");
        return null;
    };

    const d3d11_dll = Win32.LoadLibraryA("d3d11.dll") orelse {
        setError("LoadLibraryA(d3d11.dll) failed");
        return null;
    };
    const dxgi_dll = Win32.LoadLibraryA("dxgi.dll") orelse {
        _ = Win32.FreeLibrary(d3d11_dll);
        setError("LoadLibraryA(dxgi.dll) failed");
        return null;
    };

    const pCreateDevice: PFN_D3D11CreateDevice = @ptrCast(@alignCast(
        Win32.GetProcAddress(d3d11_dll, "D3D11CreateDevice") orelse {
            _ = Win32.FreeLibrary(dxgi_dll);
            _ = Win32.FreeLibrary(d3d11_dll);
            setError("D3D11CreateDevice symbol missing");
            return null;
        },
    ));
    const pCreateFactory1: PFN_CreateDXGIFactory1 = @ptrCast(@alignCast(
        Win32.GetProcAddress(dxgi_dll, "CreateDXGIFactory1") orelse {
            _ = Win32.FreeLibrary(dxgi_dll);
            _ = Win32.FreeLibrary(d3d11_dll);
            setError("CreateDXGIFactory1 symbol missing");
            return null;
        },
    ));

    // Match SteamVR's exact DXGI adapter (important on hybrid NVIDIA+AMD laptops).
    var adapter: ?*anyopaque = null;
    var adapter_index: i32 = -1;
    if (vr_system_ptr) |sys_raw| {
        const sys: *c.VR_IVRSystem_FnTable = @ptrCast(@alignCast(sys_raw));
        if (sys.GetDXGIOutputInfo) |get_info| {
            get_info(&adapter_index);
        }
    }
    if (adapter_index >= 0) {
        var factory: ?*anyopaque = null;
        if (pCreateFactory1(&IID_IDXGIFactory1, &factory) >= 0 and factory != null) {
            const fvtbl: *const *const IDXGIFactory1Vtable = @ptrCast(@alignCast(factory.?));
            _ = fvtbl.*.EnumAdapters1(factory.?, @intCast(adapter_index), &adapter);
            comRelease(factory);
        }
    }

    var d3d_device: ?*anyopaque = null;
    var d3d_context: ?*anyopaque = null;
    const want_levels = [_]u32{D3D_FEATURE_LEVEL_11_0};
    const driver_type: u32 = if (adapter != null) D3D_DRIVER_TYPE_UNKNOWN else D3D_DRIVER_TYPE_HARDWARE;
    const hr_dev = pCreateDevice(
        adapter,
        driver_type,
        null,
        0,
        &want_levels,
        1,
        D3D11_SDK_VERSION,
        &d3d_device,
        null,
        &d3d_context,
    );
    comRelease(adapter);
    if (hr_dev < 0 or d3d_device == null or d3d_context == null) {
        comRelease(d3d_context);
        comRelease(d3d_device);
        _ = Win32.FreeLibrary(dxgi_dll);
        _ = Win32.FreeLibrary(d3d11_dll);
        setError("D3D11CreateDevice failed");
        return null;
    }

    const dx_interop_device = gl.dxOpenDevice(d3d_device.?) orelse {
        comRelease(d3d_context);
        comRelease(d3d_device);
        _ = Win32.FreeLibrary(dxgi_dll);
        _ = Win32.FreeLibrary(d3d11_dll);
        setError("wglDXOpenDeviceNV failed (adapter mismatch or unsupported WGL interop)");
        return null;
    };

    const pool = std.heap.c_allocator.create(DxgiBankPool) catch {
        _ = gl.dxCloseDevice(dx_interop_device);
        comRelease(d3d_context);
        comRelease(d3d_device);
        _ = Win32.FreeLibrary(dxgi_dll);
        _ = Win32.FreeLibrary(d3d11_dll);
        setError("Out of memory allocating DxgiBankPool");
        return null;
    };
    pool.* = .{
        .d3d11_dll = d3d11_dll,
        .dxgi_dll = dxgi_dll,
        .d3d_device = d3d_device,
        .d3d_context = d3d_context,
        .dx_interop_device = dx_interop_device,
        .gl = gl,
        .bank_count = bank_count,
        .eye_count = eye_count,
        .slot_count = @as(usize, bank_count) * @as(usize, eye_count),
    };

    const dev_vtbl: *const *const ID3D11DeviceVtable = @ptrCast(@alignCast(d3d_device.?));
    const tex_desc = D3D11_TEXTURE2D_DESC{
        .Width = width,
        .Height = height,
        .MipLevels = 1,
        .ArraySize = 1,
        .Format = DXGI_FORMAT_R8G8B8A8_UNORM,
        .SampleDesc = .{ .Count = 1, .Quality = 0 },
        .Usage = D3D11_USAGE_DEFAULT,
        .BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE,
        .CPUAccessFlags = 0,
        .MiscFlags = D3D11_RESOURCE_MISC_SHARED,
    };

    for (0..pool.slot_count) |i| {
        var slot = &pool.slots[i];

        var d3d_tex: ?*anyopaque = null;
        if (dev_vtbl.*.CreateTexture2D(d3d_device.?, &tex_desc, null, &d3d_tex) < 0 or d3d_tex == null) {
            destroyPool(pool);
            setError("ID3D11Device::CreateTexture2D(MISC_SHARED) failed");
            return null;
        }
        slot.d3d_tex = d3d_tex;

        var dxgi_res: ?*anyopaque = null;
        const tex_unk: *const *const IUnknownVtable = @ptrCast(@alignCast(d3d_tex.?));
        if (tex_unk.*.QueryInterface(d3d_tex.?, &IID_IDXGIResource, &dxgi_res) < 0 or dxgi_res == null) {
            destroyPool(pool);
            setError("QueryInterface(IDXGIResource) failed");
            return null;
        }
        var shared_handle: HANDLE = null;
        const res_vtbl: *const *const IDXGIResourceVtable = @ptrCast(@alignCast(dxgi_res.?));
        const hr_sh = res_vtbl.*.GetSharedHandle(dxgi_res.?, &shared_handle);
        comRelease(dxgi_res);
        if (hr_sh < 0 or shared_handle == null) {
            destroyPool(pool);
            setError("IDXGIResource::GetSharedHandle failed");
            return null;
        }
        slot.shared_handle = shared_handle;

        var gl_tex: u32 = 0;
        Win32.glGenTextures(1, @ptrCast(&gl_tex));
        if (gl_tex == 0) {
            destroyPool(pool);
            setError("glGenTextures failed");
            return null;
        }
        slot.gl_tex = gl_tex;

        const interop_handle = gl.dxRegisterObject(
            dx_interop_device,
            d3d_tex.?,
            gl_tex,
            GL_TEXTURE_2D,
            WGL_ACCESS_READ_WRITE_NV,
        ) orelse {
            destroyPool(pool);
            setError("wglDXRegisterObjectNV failed");
            return null;
        };
        slot.interop_handle = interop_handle;

        // Temporarily lock the interop texture while configuring and validating its FBO.
        var handles = [_]HANDLE{interop_handle};
        if (gl.dxLockObjects(dx_interop_device, 1, &handles) == 0) {
            destroyPool(pool);
            setError("wglDXLockObjectsNV failed during FBO setup");
            return null;
        }

        Win32.glBindTexture(GL_TEXTURE_2D, gl_tex);
        Win32.glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
        Win32.glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
        Win32.glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
        Win32.glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
        Win32.glBindTexture(GL_TEXTURE_2D, 0);

        var rbo: u32 = 0;
        gl.genRenderbuffers(1, @ptrCast(&rbo));
        gl.bindRenderbuffer(GL_RENDERBUFFER, rbo);
        gl.renderbufferStorage(GL_RENDERBUFFER, GL_DEPTH_COMPONENT24, @intCast(width), @intCast(height));
        gl.bindRenderbuffer(GL_RENDERBUFFER, 0);
        slot.gl_depth_rbo = rbo;

        var fbo: u32 = 0;
        gl.genFramebuffers(1, @ptrCast(&fbo));
        gl.bindFramebuffer(GL_FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, gl_tex, 0);
        gl.framebufferRenderbuffer(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, GL_RENDERBUFFER, rbo);
        const status = gl.checkFramebufferStatus(GL_FRAMEBUFFER);
        gl.bindFramebuffer(GL_FRAMEBUFFER, 0);
        slot.gl_fbo = fbo;

        _ = gl.dxUnlockObjects(dx_interop_device, 1, &handles);

        if (status != GL_FRAMEBUFFER_COMPLETE) {
            destroyPool(pool);
            setError("WGL_NV_DX_interop2 FBO incomplete");
            return null;
        }

        out_fbos[i] = fbo;
        out_color_textures[i] = gl_tex;
        out_depth_rbos[i] = rbo;
        out_shared_handles[i] = @intFromPtr(shared_handle.?);
    }

    return pool;
}

pub fn lockBank(pool_ptr: ?*anyopaque, bank_index: u32) i32 {
    if (!is_windows) return 0;
    const raw = pool_ptr orelse return -1;
    const pool: *DxgiBankPool = @ptrCast(@alignCast(raw));
    if (bank_index >= pool.bank_count) return -1;
    if (pool.bank_locked[bank_index]) return 0;

    var handles: [2]HANDLE = .{ null, null };
    const base = @as(usize, bank_index) * @as(usize, pool.eye_count);
    for (0..pool.eye_count) |e| {
        handles[e] = pool.slots[base + e].interop_handle;
    }
    const ok = pool.gl.dxLockObjects(
        pool.dx_interop_device,
        @intCast(pool.eye_count),
        &handles,
    );
    if (ok == 0) return -2;
    pool.bank_locked[bank_index] = true;
    return 0;
}

pub fn unlockBank(pool_ptr: ?*anyopaque, bank_index: u32) i32 {
    if (!is_windows) return 0;
    const raw = pool_ptr orelse return -1;
    const pool: *DxgiBankPool = @ptrCast(@alignCast(raw));
    if (bank_index >= pool.bank_count) return -1;
    if (!pool.bank_locked[bank_index]) return 0;

    var handles: [2]HANDLE = .{ null, null };
    const base = @as(usize, bank_index) * @as(usize, pool.eye_count);
    for (0..pool.eye_count) |e| {
        handles[e] = pool.slots[base + e].interop_handle;
    }
    const ok = pool.gl.dxUnlockObjects(
        pool.dx_interop_device,
        @intCast(pool.eye_count),
        &handles,
    );
    pool.bank_locked[bank_index] = false;
    return if (ok == 0) -2 else 0;
}

pub fn destroyPool(pool_ptr: ?*anyopaque) void {
    if (!is_windows) return;
    const raw = pool_ptr orelse return;
    const pool: *DxgiBankPool = @ptrCast(@alignCast(raw));
    const has_gl = Win32.glGetString(GL_VERSION) != null;

    if (has_gl) {
        for (0..pool.bank_count) |b| {
            if (pool.bank_locked[b]) {
                _ = unlockBank(pool, @intCast(b));
            }
        }
    }

    for (0..pool.slot_count) |i| {
        const slot = &pool.slots[i];
        if (has_gl) {
            if (slot.gl_fbo != 0) pool.gl.deleteFramebuffers(1, @ptrCast(&slot.gl_fbo));
            if (slot.gl_depth_rbo != 0) pool.gl.deleteRenderbuffers(1, @ptrCast(&slot.gl_depth_rbo));
            if (slot.interop_handle != null and pool.dx_interop_device != null) {
                _ = pool.gl.dxUnregisterObject(pool.dx_interop_device, slot.interop_handle);
            }
            if (slot.gl_tex != 0) Win32.glDeleteTextures(1, @ptrCast(&slot.gl_tex));
        }
        comRelease(slot.d3d_tex);
    }

    if (has_gl and pool.dx_interop_device != null) {
        _ = pool.gl.dxCloseDevice(pool.dx_interop_device);
    }
    comRelease(pool.d3d_context);
    comRelease(pool.d3d_device);
    if (pool.dxgi_dll != null) _ = Win32.FreeLibrary(pool.dxgi_dll);
    if (pool.d3d11_dll != null) _ = Win32.FreeLibrary(pool.d3d11_dll);
    std.heap.c_allocator.destroy(pool);
}
