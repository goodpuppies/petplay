const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const mod = b.createModule(.{
        .root_source_file = b.path("src/presenter.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    mod.addIncludePath(b.path("../../submodules/OpenVR_TS_Bindings_Deno/CTest"));
    mod.addIncludePath(b.path("../../submodules/petplay_ovrdriver/vendor/vulkan"));
    if (target.result.os.tag == .linux) {
        mod.linkSystemLibrary("GL", .{});
    }

    const lib = b.addLibrary(.{
        .name = "petplay_overlay_presenter",
        .linkage = .dynamic,
        .use_lld = true,
        .root_module = mod,
    });
    b.installArtifact(lib);

    const test_mod = b.createModule(.{
        .root_source_file = b.path("src/presenter.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    test_mod.addIncludePath(b.path("../../submodules/OpenVR_TS_Bindings_Deno/CTest"));
    test_mod.addIncludePath(b.path("../../submodules/petplay_ovrdriver/vendor/vulkan"));
    if (target.result.os.tag == .linux) {
        test_mod.linkSystemLibrary("GL", .{});
    }
    const unit_tests = b.addTest(.{ .root_module = test_mod, .use_lld = true });
    const run_tests = b.addRunArtifact(unit_tests);
    const test_step = b.step("test", "Run pure-Zig overlay presenter unit tests");
    test_step.dependOn(&run_tests.step);
}
