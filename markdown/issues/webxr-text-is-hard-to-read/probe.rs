//! Headless direct-framebuffer Pathfinder feasibility probe; no desktop or VR session.
use std::{ffi::{c_void, CString}, fs::File, io::Write, ptr, time::Instant};
use font_kit::handle::Handle;
use pathfinder_canvas::{Canvas, CanvasFontContext};
use pathfinder_color::{ColorF, ColorU};
use pathfinder_geometry::vector::{vec2f, vec2i};
use pathfinder_geometry::transform3d::{Perspective, Transform4F};
use pathfinder_gl::{GLDevice, GLVersion};
use pathfinder_renderer::{concurrent::{rayon::RayonExecutor, scene_proxy::SceneProxy},
    gpu::{options::{DestFramebuffer, RendererMode, RendererOptions}, renderer::Renderer},
    options::{BuildOptions, RenderTransform}};
use pathfinder_resources::embedded::EmbeddedResourceLoader;

#[link(name = "EGL")]
extern "C" {
    fn eglGetPlatformDisplay(platform: u32, native: *mut c_void, attrs: *const isize) -> *mut c_void;
    fn eglInitialize(display: *mut c_void, major: *mut i32, minor: *mut i32) -> u32;
    fn eglBindAPI(api: u32) -> u32;
    fn eglChooseConfig(display: *mut c_void, attrs: *const i32, configs: *mut *mut c_void, size: i32, count: *mut i32) -> u32;
    fn eglCreatePbufferSurface(display: *mut c_void, config: *mut c_void, attrs: *const i32) -> *mut c_void;
    fn eglCreateContext(display: *mut c_void, config: *mut c_void, share: *mut c_void, attrs: *const i32) -> *mut c_void;
    fn eglMakeCurrent(display: *mut c_void, draw: *mut c_void, read: *mut c_void, context: *mut c_void) -> u32;
    fn eglGetProcAddress(name: *const i8) -> *const c_void;
    fn eglDestroyContext(display: *mut c_void, context: *mut c_void) -> u32;
    fn eglDestroySurface(display: *mut c_void, surface: *mut c_void) -> u32;
    fn eglTerminate(display: *mut c_void) -> u32;
}

fn main() {
    let font_path = std::env::args().nth(1).expect("usage: spike FONT.ttf OUTPUT.ppm");
    let output = std::env::args().nth(2).expect("missing output path");
    let perspective = std::env::args().any(|arg| arg == "--perspective");
    let size = vec2i(1024, 512);
    unsafe {
        let display = eglGetPlatformDisplay(0x31DD, ptr::null_mut(), ptr::null()); // Mesa surfaceless
        assert!(!display.is_null());
        assert_ne!(eglInitialize(display, ptr::null_mut(), ptr::null_mut()), 0);
        assert_ne!(eglBindAPI(0x30A2), 0); // OpenGL
        let mut config = ptr::null_mut();
        let mut count = 0;
        let attrs = [0x3033, 1, 0x3040, 8, 0x3024, 8, 0x3023, 8, 0x3022, 8, 0x3021, 8, 0x3038];
        assert_ne!(eglChooseConfig(display, attrs.as_ptr(), &mut config, 1, &mut count), 0);
        assert_eq!(count, 1);
        let surface_attrs = [0x3057, size.x(), 0x3056, size.y(), 0x3038];
        let surface = eglCreatePbufferSurface(display, config, surface_attrs.as_ptr());
        assert!(!surface.is_null());
        let context_attrs = [0x3098, 3, 0x30FB, 3, 0x30FD, 1, 0x3038];
        let context = eglCreateContext(display, config, ptr::null_mut(), context_attrs.as_ptr());
        assert!(!context.is_null());
        assert_ne!(eglMakeCurrent(display, surface, surface, context), 0);
        gl::load_with(|name| eglGetProcAddress(CString::new(name).unwrap().as_ptr()));
        println!("GL: {}", std::ffi::CStr::from_ptr(gl::GetString(gl::RENDERER) as *const i8).to_string_lossy());

        // Simulate a caller-owned eye target, rather than requiring Pathfinder to own it.
        let (mut framebuffer, mut texture) = (0, 0);
        gl::GenTextures(1, &mut texture);
        gl::BindTexture(gl::TEXTURE_2D, texture);
        gl::TexImage2D(gl::TEXTURE_2D, 0, gl::RGBA8 as i32, size.x(), size.y(), 0,
            gl::RGBA, gl::UNSIGNED_BYTE, ptr::null());
        gl::TexParameteri(gl::TEXTURE_2D, gl::TEXTURE_MIN_FILTER, gl::LINEAR as i32);
        gl::TexParameteri(gl::TEXTURE_2D, gl::TEXTURE_MAG_FILTER, gl::LINEAR as i32);
        gl::GenFramebuffers(1, &mut framebuffer);
        gl::BindFramebuffer(gl::FRAMEBUFFER, framebuffer);
        gl::FramebufferTexture2D(gl::FRAMEBUFFER, gl::COLOR_ATTACHMENT0, gl::TEXTURE_2D, texture, 0);
        assert_eq!(gl::CheckFramebufferStatus(gl::FRAMEBUFFER), gl::FRAMEBUFFER_COMPLETE);
        let device = GLDevice::new(GLVersion::GL3, framebuffer);
        let mode = RendererMode::default_for_device(&device);
        let mut renderer = Renderer::new(device, &EmbeddedResourceLoader::new(), mode, RendererOptions {
            dest: DestFramebuffer::full_window(size), background_color: Some(ColorF::black()),
            ..RendererOptions::default()
        });
        let handle = Handle::from_path(font_path.into(), 0);
        let font = handle.load().unwrap();
        let name = font.postscript_name().unwrap();
        let fonts = CanvasFontContext::from_fonts(std::iter::once(handle));
        let mut canvas = Canvas::new(size.to_f32()).get_context_2d(fonts);
        canvas.set_font(name.as_str()).unwrap();
        canvas.set_fill_style(ColorU::white());
        for (i, font_size) in [11., 14., 18., 24., 32.].iter().enumerate() {
            canvas.set_font_size(*font_size);
            canvas.fill_text("PetPlay: Settings  Monitors  Ctrl  Shift  äöå  ffi  Il1 O0", vec2f(32., 40. + i as f32 * 65.));
        }
        let mut scene = SceneProxy::from_scene(canvas.into_canvas().into_scene(), renderer.mode().level, RayonExecutor);
        for frame in 0..4 {
            let start = Instant::now();
            let mut options = BuildOptions::default();
            if perspective {
                // Project a tilted plane. Its right side recedes; no intermediate text texture.
                let transform = Transform4F::row_major(
                    2. / 1024., 0., 0., -1.,
                    0., -2. / 512., 0., 1.,
                    0., 0., 1., 0.,
                    0.0005, 0., 0., 1.,
                );
                options.transform = RenderTransform::Perspective(Perspective::new(&transform, size));
            }
            scene.build_and_render(&mut renderer, options);
            gl::Finish();
            println!("frame {frame}: {:.3} ms (CPU + GPU, includes build)", start.elapsed().as_secs_f64() * 1000.);
        }
        let mut pixels = vec![0u8; (size.x() * size.y() * 4) as usize];
        gl::BindFramebuffer(gl::FRAMEBUFFER, framebuffer);
        gl::ReadPixels(0, 0, size.x(), size.y(), gl::RGBA, gl::UNSIGNED_BYTE, pixels.as_mut_ptr().cast());
        assert_eq!(gl::GetError(), gl::NO_ERROR);
        assert!(pixels.chunks_exact(4).any(|p| p[0] > 0 && p[0] < 255), "no fractional text coverage rendered");
        let mut file = File::create(output).unwrap();
        write!(file, "P6\n{} {}\n255\n", size.x(), size.y()).unwrap();
        for y in (0..size.y() as usize).rev() {
            for x in 0..size.x() as usize {
                let offset = (y * size.x() as usize + x) * 4;
                file.write_all(&pixels[offset..offset+3]).unwrap();
            }
        }
        drop(scene);
        drop(renderer);
        gl::DeleteFramebuffers(1, &framebuffer);
        gl::DeleteTextures(1, &texture);
        eglMakeCurrent(display, ptr::null_mut(), ptr::null_mut(), ptr::null_mut());
        eglDestroyContext(display, context);
        eglDestroySurface(display, surface);
        eglTerminate(display);
    }
}
