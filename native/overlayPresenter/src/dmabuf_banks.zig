// Pure Zig Linux DMA-BUF bank pool + visibility-flip helpers.
// Dynamically loads libvulkan.so.1 and GL_EXT_memory_object_fd entry points at runtime:
// zero C++ runtime, zero libstdc++, zero hard link on libvulkan.so.1.
const std = @import("std");
const builtin = @import("builtin");
const presenter = @import("presenter.zig");
const c = presenter.c;

const vk = if (builtin.os.tag == .linux) @cImport({
    @cInclude("vulkan/vulkan.h");
    @cInclude("GL/gl.h");
    @cInclude("GL/glext.h");
    @cInclude("GL/glx.h");
    @cInclude("dlfcn.h");
    @cInclude("unistd.h");
}) else struct {};

const kDrmFormatAbgr8888: u32 = 0x34324241; // 'AB24' = R8G8B8A8 in memory (GL_RGBA8)
const kTextureTypeSharedTextureHandle: c.ETextureType = 8;

pub const DmabufPlane = extern struct {
    unOffset: u32,
    unStride: u32,
    nFd: i32,
};

pub const DmabufAttributes = extern struct {
    pNext: ?*anyopaque = null,
    unWidth: u32,
    unHeight: u32,
    unDepth: u32,
    unMipLevels: u32,
    unArrayLayers: u32,
    unSampleCount: u32,
    unFormat: u32,
    ulModifier: u64,
    unPlaneCount: u32,
    plane: [4]DmabufPlane,
};

comptime {
    if (@sizeOf(DmabufAttributes) != 104 or @offsetOf(DmabufAttributes, "ulModifier") != 40) {
        @compileError("DmabufAttributes ABI mismatch with openvr.h");
    }
}

// Explicit C++ vtable mirror of IVRIPCResourceManagerClient_003 (slots 0..8).
const IpcResourceManagerVtable = extern struct {
    newSharedVulkanImage: *const anyopaque,
    newSharedVulkanBuffer: *const anyopaque,
    newSharedVulkanSemaphore: *const anyopaque,
    refResource: *const anyopaque,
    unrefResource: *const fn (*anyopaque, u64) callconv(.c) bool,
    getDmabufFormats: *const fn (*anyopaque, *u32, ?[*]u32) callconv(.c) bool,
    getDmabufModifiers: *const fn (*anyopaque, c.EVRApplicationType, u32, *u32, ?[*]u64) callconv(.c) bool,
    importDmabuf: *const fn (*anyopaque, c.EVRApplicationType, *DmabufAttributes, *u64) callconv(.c) bool,
    receiveSharedFd: *const anyopaque,
};

const IpcResourceManagerClient = extern struct {
    vtable: *const IpcResourceManagerVtable,
};

threadlocal var g_last_error: [256]u8 = [_]u8{0} ** 256;

fn setError(msg: []const u8) void {
    const n = @min(msg.len, g_last_error.len - 1);
    @memcpy(g_last_error[0..n], msg[0..n]);
    g_last_error[n] = 0;
}

pub export fn pp_dmabuf_bank_last_error() [*:0]const u8 {
    return @ptrCast(&g_last_error[0]);
}

pub export fn pp_dmabuf_bank_bind_overlay(
    api_ptr: ?*c.VR_IVROverlay_FnTable,
    overlay_handle: u64,
    shared_handle: u64,
) i32 {
    const api = api_ptr orelse return -1;
    if (overlay_handle == 0 or shared_handle == 0) return -1;
    const set_tex = api.SetOverlayTexture orelse return -1;
    var handle_copy: u64 = shared_handle;
    var texture = c.Texture_t{
        .handle = @ptrCast(&handle_copy),
        .eType = kTextureTypeSharedTextureHandle,
        .eColorSpace = c.EColorSpace_ColorSpace_Auto,
    };
    return @intCast(set_tex(overlay_handle, &texture));
}

pub export fn pp_overlay_set_projection(
    api_ptr: ?*c.VR_IVROverlay_FnTable,
    left: u64,
    right: u64,
    views_ptr: ?[*]const f32,
    frusta_ptr: ?[*]const f32,
) i32 {
    const api = api_ptr orelse return -1;
    const views = views_ptr orelse return -1;
    const frusta = frusta_ptr orelse return -1;
    if (left == 0 or right == 0) return -1;
    const set_proj = api.SetOverlayTransformProjection orelse return -1;

    const handles = [2]u64{ left, right };
    for (0..2) |i| {
        var view: c.HmdMatrix34_t = undefined;
        var projection: c.VROverlayProjection_t = undefined;
        @memcpy(std.mem.asBytes(&view), std.mem.sliceAsBytes(views[i * 12 .. i * 12 + 12]));
        @memcpy(std.mem.asBytes(&projection), std.mem.sliceAsBytes(frusta[i * 4 .. i * 4 + 4]));
        const err: i32 = @intCast(set_proj(
            handles[i],
            c.ETrackingUniverseOrigin_TrackingUniverseStanding,
            &view,
            &projection,
            @intCast(i),
        ));
        if (err != 0) return err;
    }
    return 0;
}

pub export fn pp_overlay_flip_banks(
    api_ptr: ?*c.VR_IVROverlay_FnTable,
    show_left: u64,
    show_right: u64,
    hide_left: u64,
    hide_right: u64,
    stats_ptr: ?[*]f64,
) i32 {
    const api = api_ptr orelse return -1;
    const stats = stats_ptr orelse return -1;
    if (show_left == 0) return -1;
    const show_ov = api.ShowOverlay orelse return -1;
    const hide_ov = api.HideOverlay orelse return -1;

    const t = presenter.nowMs();
    var err: i32 = @intCast(show_ov(show_left));
    if (err == 0) stats[3] += 1.0;
    if (err == 0 and show_right != 0) {
        err = @intCast(show_ov(show_right));
        if (err == 0) stats[3] += 1.0;
    }
    if (err == 0 and hide_left != 0 and hide_left != show_left) {
        err = @intCast(hide_ov(hide_left));
        if (err == 0) stats[3] += 1.0;
    }
    if (err == 0 and hide_right != 0 and hide_right != show_right) {
        err = @intCast(hide_ov(hide_right));
        if (err == 0) stats[3] += 1.0;
    }
    stats[2] = presenter.nowMs() - t;
    stats[4] = @floatFromInt(err);
    return err;
}

pub export fn pp_overlay_fence_finish(stats_ptr: ?[*]f64) i32 {
    const stats = stats_ptr orelse return -1;
    @memset(stats[0..6], 0.0);
    if (builtin.os.tag != .linux) return 0;

    if (vk.glGetString(vk.GL_VERSION) == null) {
        stats[4] = -2.0;
        return -2;
    }
    const t = presenter.nowMs();
    const pFence = loadGlProc(vk.PFNGLFENCESYNCPROC, "glFenceSync");
    const pWait = loadGlProc(vk.PFNGLCLIENTWAITSYNCPROC, "glClientWaitSync");
    const pDel = loadGlProc(vk.PFNGLDELETESYNCPROC, "glDeleteSync");
    if (pFence != null and pWait != null and pDel != null) {
        if (pFence.?(vk.GL_SYNC_GPU_COMMANDS_COMPLETE, 0)) |sync| {
            vk.glFlush();
            const res = pWait.?(sync, 0, vk.GL_TIMEOUT_IGNORED);
            pDel.?(sync);
            if (res != vk.GL_ALREADY_SIGNALED and res != vk.GL_CONDITION_SATISFIED) {
                vk.glFinish();
            }
        } else {
            vk.glFinish();
        }
    } else {
        vk.glFinish();
    }
    stats[0] = presenter.nowMs() - t;
    return 0;
}

fn loadGlProc(comptime T: type, comptime name: [:0]const u8) T {
    if (builtin.os.tag != .linux) return null;
    const raw = vk.glXGetProcAddress(@ptrCast(name.ptr));
    if (raw == null) return null;
    return @ptrCast(raw);
}

const GlProcs = struct {
    createMemoryObjects: vk.PFNGLCREATEMEMORYOBJECTSEXTPROC = null,
    deleteMemoryObjects: vk.PFNGLDELETEMEMORYOBJECTSEXTPROC = null,
    importMemoryFd: vk.PFNGLIMPORTMEMORYFDEXTPROC = null,
    memoryObjectParameteriv: vk.PFNGLMEMORYOBJECTPARAMETERIVEXTPROC = null,
    texStorageMem2D: vk.PFNGLTEXSTORAGEMEM2DEXTPROC = null,
    getUnsignedBytei_v: vk.PFNGLGETUNSIGNEDBYTEI_VEXTPROC = null,
    genFramebuffers: vk.PFNGLGENFRAMEBUFFERSPROC = null,
    deleteFramebuffers: vk.PFNGLDELETEFRAMEBUFFERSPROC = null,
    bindFramebuffer: vk.PFNGLBINDFRAMEBUFFERPROC = null,
    framebufferTexture2D: vk.PFNGLFRAMEBUFFERTEXTURE2DPROC = null,
    checkFramebufferStatus: vk.PFNGLCHECKFRAMEBUFFERSTATUSPROC = null,
    genRenderbuffers: vk.PFNGLGENRENDERBUFFERSPROC = null,
    deleteRenderbuffers: vk.PFNGLDELETERENDERBUFFERSPROC = null,
    bindRenderbuffer: vk.PFNGLBINDRENDERBUFFERPROC = null,
    renderbufferStorage: vk.PFNGLRENDERBUFFERSTORAGEPROC = null,
    framebufferRenderbuffer: vk.PFNGLFRAMEBUFFERRENDERBUFFERPROC = null,

    fn load() ?GlProcs {
        const p = GlProcs{
            .createMemoryObjects = loadGlProc(vk.PFNGLCREATEMEMORYOBJECTSEXTPROC, "glCreateMemoryObjectsEXT"),
            .deleteMemoryObjects = loadGlProc(vk.PFNGLDELETEMEMORYOBJECTSEXTPROC, "glDeleteMemoryObjectsEXT"),
            .importMemoryFd = loadGlProc(vk.PFNGLIMPORTMEMORYFDEXTPROC, "glImportMemoryFdEXT"),
            .memoryObjectParameteriv = loadGlProc(vk.PFNGLMEMORYOBJECTPARAMETERIVEXTPROC, "glMemoryObjectParameterivEXT"),
            .texStorageMem2D = loadGlProc(vk.PFNGLTEXSTORAGEMEM2DEXTPROC, "glTexStorageMem2DEXT"),
            .getUnsignedBytei_v = loadGlProc(vk.PFNGLGETUNSIGNEDBYTEI_VEXTPROC, "glGetUnsignedBytei_vEXT"),
            .genFramebuffers = loadGlProc(vk.PFNGLGENFRAMEBUFFERSPROC, "glGenFramebuffers"),
            .deleteFramebuffers = loadGlProc(vk.PFNGLDELETEFRAMEBUFFERSPROC, "glDeleteFramebuffers"),
            .bindFramebuffer = loadGlProc(vk.PFNGLBINDFRAMEBUFFERPROC, "glBindFramebuffer"),
            .framebufferTexture2D = loadGlProc(vk.PFNGLFRAMEBUFFERTEXTURE2DPROC, "glFramebufferTexture2D"),
            .checkFramebufferStatus = loadGlProc(vk.PFNGLCHECKFRAMEBUFFERSTATUSPROC, "glCheckFramebufferStatus"),
            .genRenderbuffers = loadGlProc(vk.PFNGLGENRENDERBUFFERSPROC, "glGenRenderbuffers"),
            .deleteRenderbuffers = loadGlProc(vk.PFNGLDELETERENDERBUFFERSPROC, "glDeleteRenderbuffers"),
            .bindRenderbuffer = loadGlProc(vk.PFNGLBINDRENDERBUFFERPROC, "glBindRenderbuffer"),
            .renderbufferStorage = loadGlProc(vk.PFNGLRENDERBUFFERSTORAGEPROC, "glRenderbufferStorage"),
            .framebufferRenderbuffer = loadGlProc(vk.PFNGLFRAMEBUFFERRENDERBUFFERPROC, "glFramebufferRenderbuffer"),
        };
        if (p.createMemoryObjects == null or p.deleteMemoryObjects == null or
            p.importMemoryFd == null or p.memoryObjectParameteriv == null or
            p.texStorageMem2D == null or p.genFramebuffers == null or
            p.deleteFramebuffers == null or p.bindFramebuffer == null or
            p.framebufferTexture2D == null or p.checkFramebufferStatus == null or
            p.genRenderbuffers == null or p.deleteRenderbuffers == null or
            p.bindRenderbuffer == null or p.renderbufferStorage == null or
            p.framebufferRenderbuffer == null)
        {
            return null;
        }
        return p;
    }
};

const VkProcs = struct {
    lib: ?*anyopaque = null,
    createInstance: vk.PFN_vkCreateInstance = null,
    destroyInstance: vk.PFN_vkDestroyInstance = null,
    enumeratePhysicalDevices: vk.PFN_vkEnumeratePhysicalDevices = null,
    getPhysicalDeviceProperties2: vk.PFN_vkGetPhysicalDeviceProperties2 = null,
    getPhysicalDeviceMemoryProperties: vk.PFN_vkGetPhysicalDeviceMemoryProperties = null,
    createDevice: vk.PFN_vkCreateDevice = null,
    destroyDevice: vk.PFN_vkDestroyDevice = null,
    getDeviceProcAddr: vk.PFN_vkGetDeviceProcAddr = null,
    createImage: vk.PFN_vkCreateImage = null,
    destroyImage: vk.PFN_vkDestroyImage = null,
    getImageMemoryRequirements: vk.PFN_vkGetImageMemoryRequirements = null,
    getImageSubresourceLayout: vk.PFN_vkGetImageSubresourceLayout = null,
    allocateMemory: vk.PFN_vkAllocateMemory = null,
    freeMemory: vk.PFN_vkFreeMemory = null,
    bindImageMemory: vk.PFN_vkBindImageMemory = null,
    getMemoryFdKHR: vk.PFN_vkGetMemoryFdKHR = null,

    fn loadLib() ?VkProcs {
        const lib = vk.dlopen("libvulkan.so.1", vk.RTLD_LAZY | vk.RTLD_LOCAL) orelse return null;
        const sym = struct {
            fn get(h: *anyopaque, comptime T: type, comptime name: [:0]const u8) T {
                const raw = vk.dlsym(h, name.ptr);
                if (raw == null) return null;
                return @ptrCast(raw);
            }
        }.get;
        const p = VkProcs{
            .lib = lib,
            .createInstance = sym(lib, vk.PFN_vkCreateInstance, "vkCreateInstance"),
            .destroyInstance = sym(lib, vk.PFN_vkDestroyInstance, "vkDestroyInstance"),
            .enumeratePhysicalDevices = sym(lib, vk.PFN_vkEnumeratePhysicalDevices, "vkEnumeratePhysicalDevices"),
            .getPhysicalDeviceProperties2 = sym(lib, vk.PFN_vkGetPhysicalDeviceProperties2, "vkGetPhysicalDeviceProperties2"),
            .getPhysicalDeviceMemoryProperties = sym(lib, vk.PFN_vkGetPhysicalDeviceMemoryProperties, "vkGetPhysicalDeviceMemoryProperties"),
            .createDevice = sym(lib, vk.PFN_vkCreateDevice, "vkCreateDevice"),
            .destroyDevice = sym(lib, vk.PFN_vkDestroyDevice, "vkDestroyDevice"),
            .getDeviceProcAddr = sym(lib, vk.PFN_vkGetDeviceProcAddr, "vkGetDeviceProcAddr"),
            .createImage = sym(lib, vk.PFN_vkCreateImage, "vkCreateImage"),
            .destroyImage = sym(lib, vk.PFN_vkDestroyImage, "vkDestroyImage"),
            .getImageMemoryRequirements = sym(lib, vk.PFN_vkGetImageMemoryRequirements, "vkGetImageMemoryRequirements"),
            .getImageSubresourceLayout = sym(lib, vk.PFN_vkGetImageSubresourceLayout, "vkGetImageSubresourceLayout"),
            .allocateMemory = sym(lib, vk.PFN_vkAllocateMemory, "vkAllocateMemory"),
            .freeMemory = sym(lib, vk.PFN_vkFreeMemory, "vkFreeMemory"),
            .bindImageMemory = sym(lib, vk.PFN_vkBindImageMemory, "vkBindImageMemory"),
        };
        if (p.createInstance == null or p.destroyInstance == null or
            p.enumeratePhysicalDevices == null or p.getPhysicalDeviceMemoryProperties == null or
            p.createDevice == null or p.destroyDevice == null or p.getDeviceProcAddr == null or
            p.createImage == null or p.destroyImage == null or
            p.getImageMemoryRequirements == null or p.getImageSubresourceLayout == null or
            p.allocateMemory == null or p.freeMemory == null or p.bindImageMemory == null)
        {
            _ = vk.dlclose(lib);
            return null;
        }
        return p;
    }
};

const BankSlot = struct {
    vkImage: vk.VkImage = null,
    vkMemory: vk.VkDeviceMemory = null,
    glMemObj: u32 = 0,
    glTexture: u32 = 0,
    glFbo: u32 = 0,
    sharedHandle: u64 = 0,
};

const DmabufBankPool = struct {
    ipc: *IpcResourceManagerClient,
    gl: GlProcs,
    vkp: VkProcs,
    instance: vk.VkInstance = null,
    device: vk.VkDevice = null,
    depthRbos: [2]u32 = .{ 0, 0 },
    eyeCount: u32 = 0,
    slots: [8]BankSlot = [_]BankSlot{.{}} ** 8,
    slotCount: u32 = 0,

    fn destroy(self: *DmabufBankPool) void {
        const hasGl = vk.glGetString(vk.GL_VERSION) != null;
        for (self.slots[0..self.slotCount]) |*s| {
            if (s.sharedHandle != 0) {
                _ = self.ipc.vtable.unrefResource(self.ipc, s.sharedHandle);
                s.sharedHandle = 0;
            }
            if (hasGl) {
                if (s.glFbo != 0) self.gl.deleteFramebuffers.?(1, &s.glFbo);
                if (s.glTexture != 0) vk.glDeleteTextures(1, &s.glTexture);
                if (s.glMemObj != 0) self.gl.deleteMemoryObjects.?(1, &s.glMemObj);
            }
            if (self.device != null) {
                if (s.vkImage != null) self.vkp.destroyImage.?(self.device, s.vkImage, null);
                if (s.vkMemory != null) self.vkp.freeMemory.?(self.device, s.vkMemory, null);
            }
        }
        if (hasGl and self.eyeCount > 0) {
            self.gl.deleteRenderbuffers.?(@intCast(self.eyeCount), &self.depthRbos[0]);
        }
        if (self.device != null) self.vkp.destroyDevice.?(self.device, null);
        if (self.instance != null) self.vkp.destroyInstance.?(self.instance, null);
        if (self.vkp.lib) |lib| _ = vk.dlclose(lib);
        std.heap.c_allocator.destroy(self);
    }
};

fn selectPhysicalDevice(vkp: *const VkProcs, instance: vk.VkInstance, gl: *const GlProcs) vk.VkPhysicalDevice {
    var count: u32 = 0;
    if (vkp.enumeratePhysicalDevices.?(instance, &count, null) != vk.VK_SUCCESS or count == 0) {
        return null;
    }
    var devices: [16]vk.VkPhysicalDevice = undefined;
    var n: u32 = @min(count, 16);
    if (vkp.enumeratePhysicalDevices.?(instance, &n, &devices[0]) != vk.VK_SUCCESS or n == 0) {
        return null;
    }
    if (gl.getUnsignedBytei_v != null and vkp.getPhysicalDeviceProperties2 != null) {
        var numUuids: vk.GLint = 0;
        vk.glGetIntegerv(vk.GL_NUM_DEVICE_UUIDS_EXT, &numUuids);
        if (numUuids > 0) {
            var glUuid = [_]u8{0} ** 16;
            gl.getUnsignedBytei_v.?(vk.GL_DEVICE_UUID_EXT, 0, &glUuid[0]);
            for (devices[0..n]) |pd| {
                var idProps = std.mem.zeroes(vk.VkPhysicalDeviceIDProperties);
                idProps.sType = vk.VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_ID_PROPERTIES;
                var props2 = std.mem.zeroes(vk.VkPhysicalDeviceProperties2);
                props2.sType = vk.VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PROPERTIES_2;
                props2.pNext = &idProps;
                vkp.getPhysicalDeviceProperties2.?(pd, &props2);
                if (std.mem.eql(u8, &idProps.deviceUUID, &glUuid)) {
                    return pd;
                }
            }
        }
    }
    return devices[0];
}

pub export fn pp_dmabuf_bank_create(
    ipc_client_ptr: ?*anyopaque,
    width: u32,
    height: u32,
    bank_count: u32,
    eye_count: u32,
    out_fbos_ptr: ?[*]u32,
    out_color_textures_ptr: ?[*]u32,
    out_depth_rbos_ptr: ?[*]u32,
    out_shared_handles_ptr: ?[*]u64,
) ?*anyopaque {
    g_last_error[0] = 0;
    if (builtin.os.tag != .linux) {
        setError("DMA-BUF banks are supported on Linux only");
        return null;
    }
    const ipc_raw = ipc_client_ptr orelse {
        setError("Null IVRIPCResourceManagerClient pointer");
        return null;
    };
    const out_fbos = out_fbos_ptr orelse return null;
    const out_color_textures = out_color_textures_ptr orelse return null;
    const out_depth_rbos = out_depth_rbos_ptr orelse return null;
    const out_shared_handles = out_shared_handles_ptr orelse return null;

    if (width == 0 or height == 0 or bank_count < 2 or bank_count > 4 or eye_count < 1 or eye_count > 2) {
        setError("Invalid bank/eye/dimension parameters");
        return null;
    }
    if (vk.glGetString(vk.GL_VERSION) == null) {
        setError("No current OpenGL context");
        return null;
    }

    const gl = GlProcs.load() orelse {
        setError("GL_EXT_memory_object_fd / FBO functions unavailable in current GL context");
        return null;
    };
    const vkp = VkProcs.loadLib() orelse {
        setError("libvulkan.so.1 unavailable");
        return null;
    };

    const ipc: *IpcResourceManagerClient = @ptrCast(@alignCast(ipc_raw));

    // Verify SteamVR supports DRM_FORMAT_ABGR8888 (GL_RGBA8 / VK_FORMAT_R8G8B8A8_UNORM).
    var fmtCount: u32 = 0;
    if (!ipc.vtable.getDmabufFormats(ipc, &fmtCount, null) or fmtCount == 0) {
        setError("SteamVR GetDmabufFormats returned no formats");
        if (vkp.lib) |lib| _ = vk.dlclose(lib);
        return null;
    }
    var fmtsBuf: [64]u32 = undefined;
    var queryCount: u32 = @min(fmtCount, 64);
    if (!ipc.vtable.getDmabufFormats(ipc, &queryCount, &fmtsBuf)) {
        setError("SteamVR GetDmabufFormats failed");
        if (vkp.lib) |lib| _ = vk.dlclose(lib);
        return null;
    }
    var hasAbgr = false;
    for (fmtsBuf[0..queryCount]) |f| {
        if (f == kDrmFormatAbgr8888) {
            hasAbgr = true;
            break;
        }
    }
    if (!hasAbgr) {
        setError("SteamVR does not advertise DRM_FORMAT_ABGR8888 DMA-BUF support");
        if (vkp.lib) |lib| _ = vk.dlclose(lib);
        return null;
    }

    const pool = std.heap.c_allocator.create(DmabufBankPool) catch {
        setError("Out of memory allocating DmabufBankPool");
        if (vkp.lib) |lib| _ = vk.dlclose(lib);
        return null;
    };
    pool.* = .{
        .ipc = ipc,
        .gl = gl,
        .vkp = vkp,
        .eyeCount = eye_count,
        .slotCount = bank_count * eye_count,
    };

    var app = std.mem.zeroes(vk.VkApplicationInfo);
    app.sType = vk.VK_STRUCTURE_TYPE_APPLICATION_INFO;
    app.pApplicationName = "PetPlayDmabufBanks";
    app.apiVersion = vk.VK_API_VERSION_1_2;

    var ici = std.mem.zeroes(vk.VkInstanceCreateInfo);
    ici.sType = vk.VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO;
    ici.pApplicationInfo = &app;
    if (pool.vkp.createInstance.?(&ici, null, &pool.instance) != vk.VK_SUCCESS) {
        setError("vkCreateInstance failed");
        pool.destroy();
        return null;
    }

    const pd = selectPhysicalDevice(&pool.vkp, pool.instance, &pool.gl);
    if (pd == null) {
        setError("No Vulkan physical device found");
        pool.destroy();
        return null;
    }

    var prio: f32 = 1.0;
    var qci = std.mem.zeroes(vk.VkDeviceQueueCreateInfo);
    qci.sType = vk.VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO;
    qci.queueFamilyIndex = 0;
    qci.queueCount = 1;
    qci.pQueuePriorities = &prio;

    const exts = [_][*c]const u8{
        vk.VK_KHR_EXTERNAL_MEMORY_EXTENSION_NAME,
        vk.VK_KHR_EXTERNAL_MEMORY_FD_EXTENSION_NAME,
        vk.VK_EXT_EXTERNAL_MEMORY_DMA_BUF_EXTENSION_NAME,
    };
    var dci = std.mem.zeroes(vk.VkDeviceCreateInfo);
    dci.sType = vk.VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO;
    dci.queueCreateInfoCount = 1;
    dci.pQueueCreateInfos = &qci;
    dci.enabledExtensionCount = exts.len;
    dci.ppEnabledExtensionNames = &exts[0];
    if (pool.vkp.createDevice.?(pd, &dci, null, &pool.device) != vk.VK_SUCCESS) {
        setError("vkCreateDevice with external memory extensions failed");
        pool.destroy();
        return null;
    }

    const rawGetFd = pool.vkp.getDeviceProcAddr.?(pool.device, "vkGetMemoryFdKHR");
    if (rawGetFd == null) {
        setError("vkGetMemoryFdKHR unavailable");
        pool.destroy();
        return null;
    }
    pool.vkp.getMemoryFdKHR = @ptrCast(rawGetFd);

    var memProps = std.mem.zeroes(vk.VkPhysicalDeviceMemoryProperties);
    pool.vkp.getPhysicalDeviceMemoryProperties.?(pd, &memProps);

    // Save GL state so Raylib is undisturbed.
    var prevFbo: vk.GLint = 0;
    var prevTex: vk.GLint = 0;
    var prevRbo: vk.GLint = 0;
    vk.glGetIntegerv(vk.GL_FRAMEBUFFER_BINDING, &prevFbo);
    vk.glGetIntegerv(vk.GL_TEXTURE_BINDING_2D, &prevTex);
    vk.glGetIntegerv(vk.GL_RENDERBUFFER_BINDING, &prevRbo);
    defer {
        pool.gl.bindFramebuffer.?(vk.GL_FRAMEBUFFER, @intCast(prevFbo));
        vk.glBindTexture(vk.GL_TEXTURE_2D, @intCast(prevTex));
        pool.gl.bindRenderbuffer.?(vk.GL_RENDERBUFFER, @intCast(prevRbo));
    }

    pool.gl.genRenderbuffers.?(@intCast(eye_count), &pool.depthRbos[0]);
    for (0..eye_count) |e| {
        pool.gl.bindRenderbuffer.?(vk.GL_RENDERBUFFER, pool.depthRbos[e]);
        pool.gl.renderbufferStorage.?(vk.GL_RENDERBUFFER, vk.GL_DEPTH24_STENCIL8, @intCast(width), @intCast(height));
    }

    for (0..pool.slotCount) |i| {
        const slot = &pool.slots[i];
        const eye = i % eye_count;

        var emi = std.mem.zeroes(vk.VkExternalMemoryImageCreateInfo);
        emi.sType = vk.VK_STRUCTURE_TYPE_EXTERNAL_MEMORY_IMAGE_CREATE_INFO;
        emi.handleTypes = vk.VK_EXTERNAL_MEMORY_HANDLE_TYPE_OPAQUE_FD_BIT |
            vk.VK_EXTERNAL_MEMORY_HANDLE_TYPE_DMA_BUF_BIT_EXT;

        var imgCi = std.mem.zeroes(vk.VkImageCreateInfo);
        imgCi.sType = vk.VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO;
        imgCi.pNext = &emi;
        imgCi.imageType = vk.VK_IMAGE_TYPE_2D;
        imgCi.format = vk.VK_FORMAT_R8G8B8A8_UNORM;
        imgCi.extent = .{ .width = width, .height = height, .depth = 1 };
        imgCi.mipLevels = 1;
        imgCi.arrayLayers = 1;
        imgCi.samples = vk.VK_SAMPLE_COUNT_1_BIT;
        imgCi.tiling = vk.VK_IMAGE_TILING_LINEAR;
        imgCi.usage = vk.VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT | vk.VK_IMAGE_USAGE_SAMPLED_BIT |
            vk.VK_IMAGE_USAGE_TRANSFER_SRC_BIT | vk.VK_IMAGE_USAGE_TRANSFER_DST_BIT;
        imgCi.initialLayout = vk.VK_IMAGE_LAYOUT_UNDEFINED;

        if (pool.vkp.createImage.?(pool.device, &imgCi, null, &slot.vkImage) != vk.VK_SUCCESS) {
            setError("vkCreateImage failed for bank slot");
            pool.destroy();
            return null;
        }

        var req = std.mem.zeroes(vk.VkMemoryRequirements);
        pool.vkp.getImageMemoryRequirements.?(pool.device, slot.vkImage, &req);
        var memType: ?u32 = null;
        for (0..memProps.memoryTypeCount) |t| {
            const bit = @as(u32, 1) << @intCast(t);
            if ((req.memoryTypeBits & bit) != 0 and
                (memProps.memoryTypes[t].propertyFlags & vk.VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT) != 0)
            {
                memType = @intCast(t);
                break;
            }
        }
        if (memType == null) {
            for (0..memProps.memoryTypeCount) |t| {
                const bit = @as(u32, 1) << @intCast(t);
                if ((req.memoryTypeBits & bit) != 0) {
                    memType = @intCast(t);
                    break;
                }
            }
        }
        const chosenMemType = memType orelse {
            setError("No compatible Vulkan memory type");
            pool.destroy();
            return null;
        };

        var emai = std.mem.zeroes(vk.VkExportMemoryAllocateInfo);
        emai.sType = vk.VK_STRUCTURE_TYPE_EXPORT_MEMORY_ALLOCATE_INFO;
        emai.handleTypes = vk.VK_EXTERNAL_MEMORY_HANDLE_TYPE_OPAQUE_FD_BIT |
            vk.VK_EXTERNAL_MEMORY_HANDLE_TYPE_DMA_BUF_BIT_EXT;

        var mdai = std.mem.zeroes(vk.VkMemoryDedicatedAllocateInfo);
        mdai.sType = vk.VK_STRUCTURE_TYPE_MEMORY_DEDICATED_ALLOCATE_INFO;
        mdai.pNext = &emai;
        mdai.image = slot.vkImage;

        var mai = std.mem.zeroes(vk.VkMemoryAllocateInfo);
        mai.sType = vk.VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO;
        mai.pNext = &mdai;
        mai.allocationSize = req.size;
        mai.memoryTypeIndex = chosenMemType;

        if (pool.vkp.allocateMemory.?(pool.device, &mai, null, &slot.vkMemory) != vk.VK_SUCCESS or
            pool.vkp.bindImageMemory.?(pool.device, slot.vkImage, slot.vkMemory, 0) != vk.VK_SUCCESS)
        {
            setError("vkAllocateMemory/vkBindImageMemory failed");
            pool.destroy();
            return null;
        }

        const sub = vk.VkImageSubresource{
            .aspectMask = vk.VK_IMAGE_ASPECT_COLOR_BIT,
            .mipLevel = 0,
            .arrayLayer = 0,
        };
        var layout = std.mem.zeroes(vk.VkSubresourceLayout);
        pool.vkp.getImageSubresourceLayout.?(pool.device, slot.vkImage, &sub, &layout);

        var fg = std.mem.zeroes(vk.VkMemoryGetFdInfoKHR);
        fg.sType = vk.VK_STRUCTURE_TYPE_MEMORY_GET_FD_INFO_KHR;
        fg.memory = slot.vkMemory;
        fg.handleType = vk.VK_EXTERNAL_MEMORY_HANDLE_TYPE_OPAQUE_FD_BIT;
        var opaqueFd: c_int = -1;
        if (pool.vkp.getMemoryFdKHR.?(pool.device, &fg, &opaqueFd) != vk.VK_SUCCESS or opaqueFd < 0) {
            setError("vkGetMemoryFdKHR(OPAQUE_FD) failed");
            pool.destroy();
            return null;
        }

        while (vk.glGetError() != vk.GL_NO_ERROR) {}

        pool.gl.createMemoryObjects.?(1, &slot.glMemObj);
        var dedicated: vk.GLint = vk.GL_TRUE;
        pool.gl.memoryObjectParameteriv.?(slot.glMemObj, vk.GL_DEDICATED_MEMORY_OBJECT_EXT, &dedicated);
        pool.gl.importMemoryFd.?(slot.glMemObj, req.size, vk.GL_HANDLE_TYPE_OPAQUE_FD_EXT, opaqueFd);
        if (vk.glGetError() != vk.GL_NO_ERROR) {
            _ = vk.close(opaqueFd);
            setError("glImportMemoryFdEXT failed");
            pool.destroy();
            return null;
        }

        vk.glGenTextures(1, &slot.glTexture);
        vk.glBindTexture(vk.GL_TEXTURE_2D, slot.glTexture);
        vk.glTexParameteri(vk.GL_TEXTURE_2D, vk.GL_TEXTURE_TILING_EXT, vk.GL_LINEAR_TILING_EXT);
        vk.glTexParameteri(vk.GL_TEXTURE_2D, vk.GL_TEXTURE_MIN_FILTER, vk.GL_LINEAR);
        vk.glTexParameteri(vk.GL_TEXTURE_2D, vk.GL_TEXTURE_MAG_FILTER, vk.GL_LINEAR);
        vk.glTexParameteri(vk.GL_TEXTURE_2D, vk.GL_TEXTURE_WRAP_S, vk.GL_CLAMP_TO_EDGE);
        vk.glTexParameteri(vk.GL_TEXTURE_2D, vk.GL_TEXTURE_WRAP_T, vk.GL_CLAMP_TO_EDGE);
        pool.gl.texStorageMem2D.?(vk.GL_TEXTURE_2D, 1, vk.GL_RGBA8, @intCast(width), @intCast(height), slot.glMemObj, 0);

        pool.gl.genFramebuffers.?(1, &slot.glFbo);
        pool.gl.bindFramebuffer.?(vk.GL_FRAMEBUFFER, slot.glFbo);
        pool.gl.framebufferTexture2D.?(vk.GL_FRAMEBUFFER, vk.GL_COLOR_ATTACHMENT0, vk.GL_TEXTURE_2D, slot.glTexture, 0);
        pool.gl.framebufferRenderbuffer.?(vk.GL_FRAMEBUFFER, vk.GL_DEPTH_STENCIL_ATTACHMENT, vk.GL_RENDERBUFFER, pool.depthRbos[eye]);
        const fboStatus = pool.gl.checkFramebufferStatus.?(vk.GL_FRAMEBUFFER);
        if (fboStatus != vk.GL_FRAMEBUFFER_COMPLETE or vk.glGetError() != vk.GL_NO_ERROR) {
            setError("Bank FBO incomplete");
            pool.destroy();
            return null;
        }

        vk.glClearColor(0.0, 0.0, 0.0, 0.0);
        vk.glClear(vk.GL_COLOR_BUFFER_BIT);
        vk.glFinish();

        fg.handleType = vk.VK_EXTERNAL_MEMORY_HANDLE_TYPE_DMA_BUF_BIT_EXT;
        var dmabufFd: c_int = -1;
        if (pool.vkp.getMemoryFdKHR.?(pool.device, &fg, &dmabufFd) != vk.VK_SUCCESS or dmabufFd < 0) {
            setError("vkGetMemoryFdKHR(DMA_BUF) failed");
            pool.destroy();
            return null;
        }

        var attrs = DmabufAttributes{
            .pNext = null,
            .unWidth = width,
            .unHeight = height,
            .unDepth = 1,
            .unMipLevels = 1,
            .unArrayLayers = 1,
            .unSampleCount = 1,
            .unFormat = kDrmFormatAbgr8888,
            .ulModifier = 0,
            .unPlaneCount = 1,
            .plane = .{
                .{
                    .unOffset = @intCast(layout.offset),
                    .unStride = @intCast(layout.rowPitch),
                    .nFd = dmabufFd,
                },
                .{ .unOffset = 0, .unStride = 0, .nFd = 0 },
                .{ .unOffset = 0, .unStride = 0, .nFd = 0 },
                .{ .unOffset = 0, .unStride = 0, .nFd = 0 },
            },
        };

        var sharedHandle: u64 = 0;
        const imported = pool.ipc.vtable.importDmabuf(
            pool.ipc,
            c.EVRApplicationType_VRApplication_Overlay,
            &attrs,
            &sharedHandle,
        );
        _ = vk.close(dmabufFd);
        if (!imported or sharedHandle == 0) {
            setError("SteamVR ImportDmabuf failed");
            pool.destroy();
            return null;
        }
        slot.sharedHandle = sharedHandle;

        out_fbos[i] = slot.glFbo;
        out_color_textures[i] = slot.glTexture;
        out_depth_rbos[i] = pool.depthRbos[eye];
        out_shared_handles[i] = sharedHandle;
    }

    return pool;
}

pub export fn pp_dmabuf_bank_destroy(pool_ptr: ?*anyopaque) void {
    const raw = pool_ptr orelse return;
    const pool: *DmabufBankPool = @ptrCast(@alignCast(raw));
    pool.destroy();
}
