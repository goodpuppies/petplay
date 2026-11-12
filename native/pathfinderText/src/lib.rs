//! Experimental vector text pass for PetPlay's raythree renderer. All calls stay on the GL owner.
#![allow(deprecated)] // Upstream Pathfinder's current perspective/clip API.
mod glyph;
mod windfoil;
use font_kit::{font::Font, hinting::HintingOptions, outline::OutlineSink};
use pathfinder_color::ColorF;
use pathfinder_content::{
    clip::PolygonClipper3D,
    outline::{Contour, Outline},
};
use pathfinder_geometry::{
    line_segment::LineSegment2F,
    rect::RectF,
    transform2d::Transform2F,
    transform3d::{Perspective, Transform4F},
    vector::{vec2f, vec2i, Vector2F},
};
use pathfinder_gl::{GLDevice, GLVersion};
use pathfinder_renderer::{
    concurrent::executor::SequentialExecutor,
    gpu::{
        options::{DestFramebuffer, RendererLevel, RendererMode, RendererOptions},
        renderer::Renderer,
    },
    options::BuildOptions,
    paint::Paint,
    scene::{DrawPath, Scene},
};
use pathfinder_resources::embedded::EmbeddedResourceLoader;
use std::{
    cell::RefCell,
    collections::HashMap,
    ffi::{c_char, c_void, CString},
    panic::{catch_unwind, AssertUnwindSafe},
    ptr, slice,
};

#[link(name = "GL")]
extern "C" {
    fn glXGetProcAddress(name: *const u8) -> *const c_void;
}
thread_local! { static ERROR: RefCell<CString> = RefCell::new(CString::new("").unwrap()); }
fn error(message: impl ToString) {
    ERROR.with(|e| *e.borrow_mut() = CString::new(message.to_string().replace('\0', "?")).unwrap());
}
#[no_mangle]
pub extern "C" fn pp_pf_abi() -> u32 {
    1
}
#[no_mangle]
pub extern "C" fn pp_pf_error() -> *const c_char {
    ERROR.with(|e| e.borrow().as_ptr())
}

pub struct TextRenderer {
    renderer: Renderer<GLDevice>,
    fonts: [Font; 2],
    outlines: HashMap<(u8, u32), Outline>,
}

// OutlineSink is the font-kit/Pathfinder adapter; coordinates remain in font units.
struct Sink {
    outline: Outline,
    contour: Contour,
}
impl Default for Sink {
    fn default() -> Self {
        Self {
            outline: Outline::new(),
            contour: Contour::new(),
        }
    }
}
impl Sink {
    fn flush(&mut self) {
        if !self.contour.is_empty() {
            self.outline
                .push_contour(std::mem::replace(&mut self.contour, Contour::new()));
        }
    }
}
impl OutlineSink for Sink {
    fn move_to(&mut self, to: Vector2F) {
        self.flush();
        self.contour.push_endpoint(to);
    }
    fn line_to(&mut self, to: Vector2F) {
        self.contour.push_endpoint(to);
    }
    fn quadratic_curve_to(&mut self, control: Vector2F, to: Vector2F) {
        self.contour.push_quadratic(control, to);
    }
    fn cubic_curve_to(&mut self, control: LineSegment2F, to: Vector2F) {
        self.contour.push_cubic(control.from(), control.to(), to);
    }
    fn close(&mut self) {
        self.contour.close();
    }
}

#[no_mangle]
pub unsafe extern "C" fn pp_pf_create() -> *mut TextRenderer {
    let result = catch_unwind(AssertUnwindSafe(|| -> Result<TextRenderer, String> {
        gl::load_with(|name| glXGetProcAddress(CString::new(name).unwrap().as_ptr().cast()));
        if gl::GetString(gl::VERSION).is_null() {
            return Err("Pathfinder requires a current OpenGL context".into());
        }
        let _state = GlState::capture();
        let fonts = [
            Font::from_bytes(
                std::sync::Arc::new(
                    include_bytes!("../../../resources/fonts/roboto/Roboto-Regular.ttf").to_vec(),
                ),
                0,
            ),
            Font::from_bytes(
                std::sync::Arc::new(
                    include_bytes!(
                        "../../../resources/fonts/material-icons/MaterialIcons-Regular.ttf"
                    )
                    .to_vec(),
                ),
                0,
            ),
        ];
        let [roboto, icons] = fonts;
        let fonts = [
            roboto.map_err(|e| format!("Roboto: {e:?}"))?,
            icons.map_err(|e| format!("Icons: {e:?}"))?,
        ];
        let device = GLDevice::new(GLVersion::GL3, integer(gl::DRAW_FRAMEBUFFER_BINDING) as u32);
        // GL3 raster backend: avoid compute/SSBO/image state changes in the host context.
        let renderer = Renderer::new(
            device,
            &EmbeddedResourceLoader::new(),
            RendererMode {
                level: RendererLevel::D3D9,
            },
            RendererOptions {
                dest: DestFramebuffer::full_window(vec2i(1, 1)),
                background_color: None,
                ..RendererOptions::default()
            },
        );
        Ok(TextRenderer {
            renderer,
            fonts,
            outlines: HashMap::new(),
        })
    }));
    match result {
        Ok(Ok(renderer)) => Box::into_raw(Box::new(renderer)),
        Ok(Err(e)) => {
            error(e);
            ptr::null_mut()
        }
        Err(_) => {
            error("Pathfinder initialization panicked");
            ptr::null_mut()
        }
    }
}

/// Packed f32 records: [codepoint, penX, baselineY, emSize, fontSlot, MVP column-major x16, RGBA x4].
#[no_mangle]
pub unsafe extern "C" fn pp_pf_draw(
    handle: *mut TextRenderer,
    records: *const f32,
    count: u32,
) -> i32 {
    if handle.is_null() || records.is_null() || count > 100_000 {
        error("Invalid Pathfinder draw arguments");
        return -1;
    }
    let result = catch_unwind(AssertUnwindSafe(|| -> Result<(), String> {
        let _state = GlState::capture();
        let viewport = integers::<4>(gl::VIEWPORT);
        if viewport[0] != 0 || viewport[1] != 0 || viewport[2] <= 0 || viewport[3] <= 0 {
            return Err("Pathfinder text currently requires a full, zero-origin viewport".into());
        }
        let size = vec2i(viewport[2], viewport[3]);
        let target = integer(gl::DRAW_FRAMEBUFFER_BINDING) as u32;
        let text = &mut *handle;
        text.renderer.device_mut().set_default_framebuffer(target);
        text.renderer.options_mut().dest = DestFramebuffer::full_window(size);
        // Existing UI pass uses coverage alpha in the encoded framebuffer color space.
        gl::Disable(gl::FRAMEBUFFER_SRGB);
        gl::Disable(gl::SCISSOR_TEST);
        gl::Disable(gl::CULL_FACE);
        let mut scene = Scene::new();
        scene.set_view_box(RectF::new(vec2f(0., 0.), size.to_f32()));
        for record in slice::from_raw_parts(records, count as usize * 25).chunks_exact(25) {
            if !record.iter().all(|v| v.is_finite()) {
                return Err("Non-finite glyph record".into());
            }
            let code = record[0] as u32;
            let slot = record[4] as usize;
            if slot > 1 || record[3] <= 0. {
                return Err("Invalid glyph font or em size".into());
            }
            let font = &text.fonts[slot];
            let key = (slot as u8, code);
            if !text.outlines.contains_key(&key) {
                let ch = char::from_u32(code).ok_or("Invalid glyph codepoint")?;
                let glyph = font
                    .glyph_for_char(ch)
                    .ok_or_else(|| format!("Missing outline U+{code:04X} in font {slot}"))?;
                let mut sink = Sink::default();
                font.outline(glyph, HintingOptions::None, &mut sink)
                    .map_err(|e| format!("Glyph outline: {e:?}"))?;
                sink.flush();
                text.outlines.insert(key, sink.outline);
            }
            let mut outline = text.outlines[&key].clone();
            let scale = record[3] / font.metrics().units_per_em as f32;
            outline.transform(
                &(Transform2F::from_translation(vec2f(record[1], record[2]))
                    * Transform2F::from_scale(vec2f(scale, -scale))),
            );
            let m = &record[5..21];
            let transform = Transform4F::row_major(
                m[0], m[4], m[8], m[12], m[1], m[5], m[9], m[13], m[2], m[6], m[10], m[14], m[3],
                m[7], m[11], m[15],
            );
            let perspective = Perspective::new(&transform, size);
            // Clip on the glyph plane before perspective division, as Pathfinder's global
            // perspective builder does. This permits many label planes in one scene/root.
            let bounds = outline.bounds();
            let points = [
                bounds.origin(),
                bounds.upper_right(),
                bounds.lower_right(),
                bounds.lower_left(),
            ]
            .iter()
            .map(|p| transform * p.to_4d())
            .collect();
            let clipped = PolygonClipper3D::new(points).clip();
            if clipped.len() < 3 {
                continue;
            }
            let inverse = transform.inverse();
            let polygon: Vec<_> = clipped
                .iter()
                .map(|p| (inverse * p.to_3d().to_4d()).to_2d())
                .collect();
            outline.clip_against_polygon(&polygon);
            outline.apply_perspective(&perspective);
            let paint = scene.push_paint(&Paint::from_color(
                ColorF::new(record[21], record[22], record[23], record[24]).to_u8(),
            ));
            scene.push_draw_path(DrawPath::new(outline, paint));
        }
        scene.build_and_render(
            &mut text.renderer,
            BuildOptions::default(),
            SequentialExecutor,
        );
        Ok(())
    }));
    match result {
        Ok(Ok(())) => 0,
        Ok(Err(e)) => {
            error(e);
            -1
        }
        Err(_) => {
            error("Pathfinder draw panicked");
            -1
        }
    }
}

#[no_mangle]
pub unsafe extern "C" fn pp_pf_destroy(handle: *mut TextRenderer) {
    if !handle.is_null() {
        let _state = GlState::capture();
        drop(Box::from_raw(handle));
    }
}

unsafe fn integer(name: u32) -> i32 {
    integers::<1>(name)[0]
}
unsafe fn integers<const N: usize>(name: u32) -> [i32; N] {
    let mut values = [0; N];
    gl::GetIntegerv(name, values.as_mut_ptr());
    values
}

/// Isolate the GL3 raster backend from Raylib's GL state/cache. Captured after flushing rlgl.
struct GlState {
    framebuffer: [i32; 2],
    viewport: [i32; 4],
    scissor: [i32; 4],
    program: i32,
    vao: i32,
    array: i32,
    element: i32,
    active: i32,
    textures: Vec<i32>,
    enabled: Vec<(u32, bool)>,
    blend: [i32; 6],
    depth: [i32; 2],
    color: [u8; 4],
    stencil: [[i32; 7]; 2],
    clear_color: [f32; 4],
    clear_depth: f64,
    clear_stencil: i32,
    pixel_buffers: [i32; 2],
}
impl GlState {
    unsafe fn capture() -> Self {
        let active = integer(gl::ACTIVE_TEXTURE);
        let textures = (0..integer(gl::MAX_TEXTURE_IMAGE_UNITS))
            .map(|unit| {
                gl::ActiveTexture(gl::TEXTURE0 + unit as u32);
                integer(gl::TEXTURE_BINDING_2D)
            })
            .collect();
        gl::ActiveTexture(active as u32);
        let enabled = [
            gl::BLEND,
            gl::DEPTH_TEST,
            gl::STENCIL_TEST,
            gl::CULL_FACE,
            gl::SCISSOR_TEST,
            gl::FRAMEBUFFER_SRGB,
        ]
        .iter()
        .map(|&cap| (cap, gl::IsEnabled(cap) != 0))
        .collect();
        let mut color = [0; 4];
        gl::GetBooleanv(gl::COLOR_WRITEMASK, color.as_mut_ptr());
        let mut clear_color = [0.; 4];
        gl::GetFloatv(gl::COLOR_CLEAR_VALUE, clear_color.as_mut_ptr());
        let mut clear_depth = 0.;
        gl::GetDoublev(gl::DEPTH_CLEAR_VALUE, &mut clear_depth);
        let pixel_buffers = [
            integer(gl::PIXEL_PACK_BUFFER_BINDING),
            integer(gl::PIXEL_UNPACK_BUFFER_BINDING),
        ];
        gl::BindBuffer(gl::PIXEL_PACK_BUFFER, 0);
        gl::BindBuffer(gl::PIXEL_UNPACK_BUFFER, 0);
        Self {
            framebuffer: [
                integer(gl::DRAW_FRAMEBUFFER_BINDING),
                integer(gl::READ_FRAMEBUFFER_BINDING),
            ],
            viewport: integers(gl::VIEWPORT),
            scissor: integers(gl::SCISSOR_BOX),
            program: integer(gl::CURRENT_PROGRAM),
            vao: integer(gl::VERTEX_ARRAY_BINDING),
            array: integer(gl::ARRAY_BUFFER_BINDING),
            element: integer(gl::ELEMENT_ARRAY_BUFFER_BINDING),
            active,
            textures,
            enabled,
            blend: [
                integer(gl::BLEND_SRC_RGB),
                integer(gl::BLEND_DST_RGB),
                integer(gl::BLEND_SRC_ALPHA),
                integer(gl::BLEND_DST_ALPHA),
                integer(gl::BLEND_EQUATION_RGB),
                integer(gl::BLEND_EQUATION_ALPHA),
            ],
            depth: [integer(gl::DEPTH_FUNC), integer(gl::DEPTH_WRITEMASK)],
            color,
            clear_color,
            clear_depth,
            clear_stencil: integer(gl::STENCIL_CLEAR_VALUE),
            pixel_buffers,
            stencil: [
                [
                    integer(gl::STENCIL_FUNC),
                    integer(gl::STENCIL_REF),
                    integer(gl::STENCIL_VALUE_MASK),
                    integer(gl::STENCIL_WRITEMASK),
                    integer(gl::STENCIL_FAIL),
                    integer(gl::STENCIL_PASS_DEPTH_FAIL),
                    integer(gl::STENCIL_PASS_DEPTH_PASS),
                ],
                [
                    integer(gl::STENCIL_BACK_FUNC),
                    integer(gl::STENCIL_BACK_REF),
                    integer(gl::STENCIL_BACK_VALUE_MASK),
                    integer(gl::STENCIL_BACK_WRITEMASK),
                    integer(gl::STENCIL_BACK_FAIL),
                    integer(gl::STENCIL_BACK_PASS_DEPTH_FAIL),
                    integer(gl::STENCIL_BACK_PASS_DEPTH_PASS),
                ],
            ],
        }
    }
}
impl Drop for GlState {
    fn drop(&mut self) {
        unsafe {
            gl::BindFramebuffer(gl::DRAW_FRAMEBUFFER, self.framebuffer[0] as u32);
            gl::BindFramebuffer(gl::READ_FRAMEBUFFER, self.framebuffer[1] as u32);
            gl::Viewport(
                self.viewport[0],
                self.viewport[1],
                self.viewport[2],
                self.viewport[3],
            );
            gl::Scissor(
                self.scissor[0],
                self.scissor[1],
                self.scissor[2],
                self.scissor[3],
            );
            gl::UseProgram(self.program as u32);
            gl::BindVertexArray(self.vao as u32);
            gl::BindBuffer(gl::ARRAY_BUFFER, self.array as u32);
            if self.vao != 0 {
                gl::BindBuffer(gl::ELEMENT_ARRAY_BUFFER, self.element as u32);
            }
            for (unit, &texture) in self.textures.iter().enumerate() {
                gl::ActiveTexture(gl::TEXTURE0 + unit as u32);
                gl::BindTexture(gl::TEXTURE_2D, texture as u32);
            }
            gl::ActiveTexture(self.active as u32);
            gl::BlendFuncSeparate(
                self.blend[0] as u32,
                self.blend[1] as u32,
                self.blend[2] as u32,
                self.blend[3] as u32,
            );
            gl::BlendEquationSeparate(self.blend[4] as u32, self.blend[5] as u32);
            gl::DepthFunc(self.depth[0] as u32);
            gl::DepthMask(self.depth[1] as u8);
            gl::ColorMask(self.color[0], self.color[1], self.color[2], self.color[3]);
            gl::ClearColor(
                self.clear_color[0],
                self.clear_color[1],
                self.clear_color[2],
                self.clear_color[3],
            );
            gl::ClearDepth(self.clear_depth);
            gl::ClearStencil(self.clear_stencil);
            gl::BindBuffer(gl::PIXEL_PACK_BUFFER, self.pixel_buffers[0] as u32);
            gl::BindBuffer(gl::PIXEL_UNPACK_BUFFER, self.pixel_buffers[1] as u32);
            for (face, s) in [gl::FRONT, gl::BACK].iter().zip(self.stencil.iter()) {
                gl::StencilFuncSeparate(*face, s[0] as u32, s[1], s[2] as u32);
                gl::StencilMaskSeparate(*face, s[3] as u32);
                gl::StencilOpSeparate(*face, s[4] as u32, s[5] as u32, s[6] as u32);
            }
            for &(cap, enabled) in &self.enabled {
                if enabled {
                    gl::Enable(cap);
                } else {
                    gl::Disable(cap);
                }
            }
        }
    }
}
