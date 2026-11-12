//! Native adapter for the pinned pmndrs/glyph curve/band generator and packed Slug V0 data.
use super::{error, integers, GlState};
use font_kit::{font::Font, hinting::HintingOptions, outline::OutlineSink};
use pathfinder_geometry::{line_segment::LineSegment2F, vector::Vector2F};
use pmndrs_glyph_slug_core::{
    self as slug, Bounds, Cubic, GlyphForPacking, Point, Quadratic, SlugGlyphRecord,
};
use std::{
    collections::{BTreeSet, HashMap},
    ffi::CString,
    panic::{catch_unwind, AssertUnwindSafe},
    ptr, slice,
    sync::Arc,
};

struct FontPage {
    textures: [u32; 3],
}
impl Drop for FontPage {
    fn drop(&mut self) {
        unsafe {
            gl::DeleteTextures(3, self.textures.as_ptr());
        }
    }
}
struct Glyph {
    record: SlugGlyphRecord,
    bounds: [f32; 4],
    page: usize,
}
pub struct GlyphRenderer {
    program: u32,
    vao: u32,
    buffer: u32,
    instance_buffer: u32,
    instances: Vec<u32>,
    pages: Vec<FontPage>,
    glyphs: HashMap<(u8, u32), Glyph>,
}

struct Collector {
    curves: Vec<Quadratic>,
    contours: Vec<u16>,
    current: Option<Point>,
    first: Option<Point>,
    units: f32,
    exact_lines: bool,
}
impl Collector {
    fn line(&self, a: Point, b: Point) -> Quadratic {
        if self.exact_lines {
            Quadratic {p0:a,p1:Point::new((a.x+b.x)*0.5,(a.y+b.y)*0.5),p2:b}
        } else { slug::line_to_quadratic(a,b,self.units) }
    }
    fn point(&self, p: Vector2F) -> Point {
        Point::new(p.x() / self.units, p.y() / self.units)
    }
    fn close_contour(&mut self) {
        if let (Some(a), Some(b)) = (self.current, self.first) {
            if a != b {
                self.curves.push(self.line(a, b));
            }
        }
        self.current = None;
        self.first = None;
    }
}
impl OutlineSink for Collector {
    fn move_to(&mut self, p: Vector2F) {
        self.close_contour();
        let p = self.point(p);
        self.contours.push(self.curves.len() as u16);
        self.first = Some(p);
        self.current = Some(p);
    }
    fn line_to(&mut self, p: Vector2F) {
        let p = self.point(p);
        self.curves.push(self.line(self.current.unwrap(), p));
        self.current = Some(p);
    }
    fn quadratic_curve_to(&mut self, c: Vector2F, p: Vector2F) {
        let p = self.point(p);
        self.curves.push(Quadratic {
            p0: self.current.unwrap(),
            p1: self.point(c),
            p2: p,
        });
        self.current = Some(p);
    }
    fn cubic_curve_to(&mut self, c: LineSegment2F, p: Vector2F) {
        let p = self.point(p);
        let zero = Point::new(0., 0.);
        let mut scratch = [Quadratic {
            p0: zero,
            p1: zero,
            p2: zero,
        }; slug::MAX_CUBIC_SUBDIVISIONS];
        let n = slug::cubic_to_quadratics_into(
            Cubic {
                p0: self.current.unwrap(),
                p1: self.point(c.from()),
                p2: self.point(c.to()),
                p3: p,
            },
            slug::DEFAULT_CUBIC_SUBDIVISIONS,
            &mut scratch,
        );
        self.curves.extend_from_slice(&scratch[..n]);
        self.current = Some(p);
    }
    fn close(&mut self) {
        self.close_contour();
    }
}

unsafe fn shader(kind: u32, source: &str) -> Result<u32, String> {
    let shader = gl::CreateShader(kind);
    let source = CString::new(source).unwrap();
    gl::ShaderSource(shader, 1, &source.as_ptr(), ptr::null());
    gl::CompileShader(shader);
    let mut ok = 0;
    gl::GetShaderiv(shader, gl::COMPILE_STATUS, &mut ok);
    if ok == 0 {
        let mut log = vec![0u8; 8192];
        gl::GetShaderInfoLog(shader, 8192, ptr::null_mut(), log.as_mut_ptr().cast());
        gl::DeleteShader(shader);
        return Err(String::from_utf8_lossy(&log).into());
    }
    Ok(shader)
}
unsafe fn program(windfoil: bool) -> Result<u32, String> {
    let vs = shader(gl::VERTEX_SHADER, include_str!("glyph.vert"))?;
    let fs = match shader(gl::FRAGMENT_SHADER, if windfoil {include_str!("windfoil.frag")} else {include_str!("glyph.frag")}) {
        Ok(s) => s,
        Err(e) => {
            gl::DeleteShader(vs);
            return Err(e);
        }
    };
    let p = gl::CreateProgram();
    gl::AttachShader(p, vs);
    gl::AttachShader(p, fs);
    gl::LinkProgram(p);
    gl::DeleteShader(vs);
    gl::DeleteShader(fs);
    let mut ok = 0;
    gl::GetProgramiv(p, gl::LINK_STATUS, &mut ok);
    if ok == 0 {
        gl::DeleteProgram(p);
        return Err("Glyph Slug shader link failed".into());
    }
    Ok(p)
}
unsafe fn uniform(program: u32, name: &str) -> i32 {
    gl::GetUniformLocation(program, CString::new(name).unwrap().as_ptr())
}
unsafe fn texture(internal: i32, format: u32, kind: u32, w: u16, h: u16, bytes: &[u8]) -> u32 {
    let mut t = 0;
    gl::GenTextures(1, &mut t);
    gl::BindTexture(gl::TEXTURE_2D, t);
    gl::TexImage2D(
        gl::TEXTURE_2D,
        0,
        internal,
        w.into(),
        h.into(),
        0,
        format,
        kind,
        bytes.as_ptr().cast(),
    );
    gl::TexParameteri(gl::TEXTURE_2D, gl::TEXTURE_MIN_FILTER, gl::NEAREST as i32);
    gl::TexParameteri(gl::TEXTURE_2D, gl::TEXTURE_MAG_FILTER, gl::NEAREST as i32);
    gl::TexParameteri(gl::TEXTURE_2D, gl::TEXTURE_WRAP_S, gl::CLAMP_TO_EDGE as i32);
    gl::TexParameteri(gl::TEXTURE_2D, gl::TEXTURE_WRAP_T, gl::CLAMP_TO_EDGE as i32);
    t
}

impl GlyphRenderer {
    unsafe fn new(windfoil: bool) -> Result<Self, String> {
        let mut result = Self {
            program: 0,
            vao: 0,
            buffer: 0,
            instance_buffer: 0,
            instances: Vec::new(),
            pages: Vec::new(),
            glyphs: HashMap::new(),
        };
        result.program = program(windfoil)?;
        let corners: [f32; 12] = [-1., -1., 1., -1., 1., 1., -1., -1., 1., 1., -1., 1.];
        gl::GenVertexArrays(1, &mut result.vao);
        gl::BindVertexArray(result.vao);
        gl::GenBuffers(1, &mut result.buffer);
        gl::BindBuffer(gl::ARRAY_BUFFER, result.buffer);
        gl::BufferData(
            gl::ARRAY_BUFFER,
            std::mem::size_of_val(&corners) as isize,
            corners.as_ptr().cast(),
            gl::STATIC_DRAW,
        );
        gl::EnableVertexAttribArray(0);
        gl::VertexAttribPointer(0, 2, gl::FLOAT, gl::FALSE, 8, ptr::null());
        gl::GenBuffers(1, &mut result.instance_buffer);
        let roboto = Font::from_bytes(
            Arc::new(include_bytes!("../../../resources/fonts/roboto/Roboto-Regular.ttf").to_vec()),
            0,
        )
        .map_err(|e| format!("Roboto: {e:?}"))?;
        let icons = Font::from_bytes(
            Arc::new(
                include_bytes!("../../../resources/fonts/material-icons/MaterialIcons-Regular.ttf")
                    .to_vec(),
            ),
            0,
        )
        .map_err(|e| format!("Icons: {e:?}"))?;
        let mut codes = [BTreeSet::new(), BTreeSet::new()];
        for data in [include_str!("../../../submodules/threewebxrwebgpudeno/vendor/three-msdf-text-utils/demo/fonts/roboto/roboto-regular.fnt"),include_str!("../../../resources/fonts/material-icons/material-icons.fnt")] {
            let json:serde_json::Value=serde_json::from_str(data).map_err(|e|e.to_string())?;
            for c in json["chars"].as_array().ok_or("Missing BMFont characters")? {let code=c["id"].as_u64().ok_or("Invalid BMFont code")? as u32;codes[usize::from(code>=0xe000)].insert(code);}
        }
        for (slot, font) in [roboto, icons].iter().enumerate() {
            let mut geometry = Vec::new();
            let mut codepoints = Vec::new();
            let mut windfoil_curves: Vec<f32> = Vec::new();
            for &code in &codes[slot] {
                let glyph = font
                    .glyph_for_char(char::from_u32(code).ok_or("Invalid codepoint")?)
                    .ok_or_else(|| format!("Missing outline U+{code:04X}"))?;
                let mut collector = Collector {
                    curves: Vec::new(),
                    contours: Vec::new(),
                    current: None,
                    first: None,
                    units: font.metrics().units_per_em as f32,
                    exact_lines: windfoil,
                };
                font.outline(glyph, HintingOptions::None, &mut collector)
                    .map_err(|e| format!("Outline: {e:?}"))?;
                collector.close_contour();
                if collector.curves.is_empty() {
                    continue;
                }
                if windfoil {
                    let base = (windfoil_curves.len()/4) as u32;
                    let pieces: Vec<_> = collector.curves.into_iter().flat_map(super::windfoil::monotone).collect();
                    if pieces.len()>4096 {return Err("Windfoil glyph exceeds 4096 pieces".into());}
                    let mut bounds=[f32::INFINITY,f32::INFINITY,f32::NEG_INFINITY,f32::NEG_INFINITY];
                    for q in &pieces {
                        for p in [q.p0,q.p1,q.p2] {
                            bounds[0]=bounds[0].min(p.x);bounds[1]=bounds[1].min(p.y);
                            bounds[2]=bounds[2].max(p.x);bounds[3]=bounds[3].max(p.y);
                        }
                        windfoil_curves.extend([q.p0.x,q.p0.y,q.p1.x,q.p1.y,q.p2.x,q.p2.y,0.,0.]);
                    }
                    result.glyphs.insert((slot as u8,code),Glyph {
                        page:result.pages.len(), bounds,
                        record:SlugGlyphRecord {curve_base_texel:base,horizontal_band_count:pieces.len() as u16,vertical_band_count:1,..SlugGlyphRecord::ABSENT},
                    });
                    continue;
                }
                // Match Glyph's prepare_geometry: quantize analytic inputs before bounds/bands.
                for q in &mut collector.curves {
                    for p in [&mut q.p0, &mut q.p1, &mut q.p2] {
                        p.x = slug::quantize_f16(p.x)
                            .map_err(|e| format!("Curve quantization: {e:?}"))?;
                        p.y = slug::quantize_f16(p.y)
                            .map_err(|e| format!("Curve quantization: {e:?}"))?;
                    }
                }
                let mut g = slug::build_glyph_geometry(
                    collector.curves,
                    collector.contours,
                    slug::DEFAULT_BAND_COUNT,
                )
                .map_err(|e| format!("Glyph geometry: {e:?}"))?;
                let b = g.bounds;
                let raw = [
                    (b.min_x * 2048.).floor(),
                    (b.min_y * 2048.).floor(),
                    (b.max_x * 2048.).ceil(),
                    (b.max_y * 2048.).ceil(),
                ];
                if raw
                    .iter()
                    .any(|v| *v < i16::MIN as f32 || *v > i16::MAX as f32)
                {
                    return Err("Glyph bounds overflow".into());
                }
                let bounds = raw.map(|v| v as i16);
                g.bounds = Bounds {
                    min_x: raw[0] / 2048.,
                    min_y: raw[1] / 2048.,
                    max_x: raw[2] / 2048.,
                    max_y: raw[3] / 2048.,
                };
                g.bands = slug::build_bands(&g.curves, g.bounds, slug::DEFAULT_BAND_COUNT)
                    .map_err(|e| format!("Glyph bands: {e:?}"))?;
                geometry.push((g, bounds));
                codepoints.push(code);
            }
            if windfoil {
                let width=1024usize;
                let height=((windfoil_curves.len()/4+width-1)/width).max(1);
                if height>16384 {return Err("Windfoil atlas exceeds texture limit".into());}
                windfoil_curves.resize(width*height*4,0.);
                let bytes=slice::from_raw_parts(windfoil_curves.as_ptr().cast::<u8>(),windfoil_curves.len()*4);
                let id=texture(gl::RGBA32F as i32,gl::RGBA,gl::FLOAT,width as u16,height as u16,bytes);
                result.pages.push(FontPage {textures:[id,0,0]});
                continue;
            }
            let inputs: Vec<_> = geometry
                .iter()
                .map(|(g, bounds)| GlyphForPacking::Present {
                    geometry: g,
                    plane_bounds: *bounds,
                })
                .collect();
            let mut packed = slug::pack_glyphs(
                &inputs,
                slug::PackerConfig {
                    curve_width: 1024,
                    header_width: 1024,
                    reference_width: 1024,
                    ..slug::PackerConfig::default()
                },
            )
            .map_err(|e| format!("Glyph packer: {e:?}"))?;
            // Pinned packer shares each curve's endpoint with the next curve's p0.
            // When it skips a final-row texel before a continuation, that slot is
            // left zero even though the previous curve still reads it as p2.
            // Fill only those proven continuation gaps, preserving all addresses.
            for (record, (g, _)) in packed.records.iter().zip(&geometry) {
                let page = &mut packed.pages[record.page as usize];
                let width = page.metadata.curve_width as usize;
                let mut cursor = record.curve_base_texel as usize;
                for (contour, start) in g.contour_starts.iter().enumerate() {
                    let end = g
                        .contour_starts
                        .get(contour + 1)
                        .map_or(g.curves.len(), |v| *v as usize);
                    for index in *start as usize..end {
                        if cursor % width == width - 1 {
                            cursor += 1;
                        }
                        if cursor % width == width - 2 && index + 1 < end {
                            let mut endpoint = [0u8; 4];
                            endpoint.copy_from_slice(
                                &page.curve_bytes[(cursor + 2) * 8..(cursor + 2) * 8 + 4],
                            );
                            page.curve_bytes[(cursor + 1) * 8..(cursor + 1) * 8 + 4]
                                .copy_from_slice(&endpoint);
                        }
                        cursor += 1;
                    }
                    cursor += 1; // Contour's explicit final endpoint texel.
                }
            }
            let base = result.pages.len();
            for p in packed.pages {
                let m = p.metadata;
                let textures = [
                    texture(
                        gl::RGBA16F as i32,
                        gl::RGBA,
                        gl::HALF_FLOAT,
                        m.curve_width,
                        m.curve_height,
                        &p.curve_bytes,
                    ),
                    texture(
                        gl::R32UI as i32,
                        gl::RED_INTEGER,
                        gl::UNSIGNED_INT,
                        m.header_width,
                        m.header_height,
                        &p.header_bytes,
                    ),
                    texture(
                        gl::R16UI as i32,
                        gl::RED_INTEGER,
                        gl::UNSIGNED_SHORT,
                        m.reference_width,
                        m.reference_height,
                        &p.reference_bytes,
                    ),
                ];
                result.pages.push(FontPage { textures });
            }
            for ((code, record), (g, _)) in codepoints.into_iter().zip(packed.records).zip(geometry)
            {
                let b = g.bounds;
                result.glyphs.insert(
                    (slot as u8, code),
                    Glyph {
                        page: base + record.page as usize,
                        record,
                        bounds: [b.min_x, b.min_y, b.max_x, b.max_y],
                    },
                );
            }
        }
        Ok(result)
    }
    unsafe fn draw(&mut self, records: &[f32], exponent: f32, weight: f32, aa_width: f32) -> Result<(), String> {
        // Validate the entire group before submitting any draws.
        for r in records.chunks_exact(25) {
            if !r.iter().all(|v| v.is_finite())
                || r[3] <= 0.
                || r[4] < 0.
                || r[4] > 1.
                || !self.glyphs.contains_key(&(r[4] as u8, r[0] as u32))
            {
                return Err("Missing/invalid Glyph placement".into());
            }
        }
        let viewport = integers::<4>(gl::VIEWPORT);
        if viewport[2] <= 0 || viewport[3] <= 0 {
            return Err("Invalid Glyph viewport".into());
        }
        gl::UseProgram(self.program);
        gl::Uniform1f(uniform(self.program, "uCoverageExponent"), exponent);
        gl::Uniform1f(uniform(self.program, "uWeightPixels"), weight);
        gl::Uniform1f(uniform(self.program, "uAaWidth"), aa_width);
        gl::BindVertexArray(self.vao);
        gl::Disable(gl::DEPTH_TEST);
        gl::DepthMask(gl::FALSE);
        gl::Disable(gl::CULL_FACE);
        gl::Disable(gl::STENCIL_TEST);
        gl::Disable(gl::SCISSOR_TEST);
        gl::Disable(gl::FRAMEBUFFER_SRGB);
        gl::Enable(gl::BLEND);
        gl::BlendEquation(gl::FUNC_ADD);
        gl::BlendFuncSeparate(
            gl::SRC_ALPHA,
            gl::ONE_MINUS_SRC_ALPHA,
            gl::ONE,
            gl::ONE_MINUS_SRC_ALPHA,
        );
        gl::Uniform1i(uniform(self.program, "uCurves"), 0);
        gl::Uniform1i(uniform(self.program, "uHeaders"), 1);
        gl::Uniform1i(uniform(self.program, "uReferences"), 2);
        gl::Uniform2f(
            uniform(self.program, "uViewport"),
            viewport[2] as f32,
            viewport[3] as f32,
        );
        self.instances.clear();
        let mut runs: Vec<(usize, usize, usize)> = Vec::new();
        for (index, r) in records.chunks_exact(25).enumerate() {
            let glyph = &self.glyphs[&(r[4] as u8, r[0] as u32)];
            let g = glyph.record;
            if let Some(run) = runs.last_mut().filter(|run| run.0 == glyph.page) {
                run.2 += 1;
            } else {
                runs.push((glyph.page, index, 1));
            }
            // Existing placement is Y-down BMFont units, Glyph curves are Y-up em.
            let m = &r[5..21];
            let mut matrix = [0.; 16];
            for row in 0..4 {
                matrix[row] = m[row] * r[3];
                matrix[4 + row] = -m[4 + row] * r[3];
                matrix[8 + row] = m[8 + row];
                matrix[12 + row] = m[row] * r[1] + m[4 + row] * r[2] + m[12 + row];
            }
            self.instances.extend(matrix.map(f32::to_bits));
            self.instances.extend(glyph.bounds.map(f32::to_bits));
            self.instances.extend([
                g.curve_base_texel,
                g.horizontal_header_base,
                g.vertical_header_base,
                g.curve_reference_base,
            ]);
            self.instances
                .extend([g.horizontal_band_count as u32, g.vertical_band_count as u32]);
            let b = glyph.bounds;
            let sx = g.vertical_band_count as f32 / (b[2] - b[0]);
            let sy = g.horizontal_band_count as f32 / (b[3] - b[1]);
            self.instances
                .extend([sx, sy, -b[0] * sx, -b[1] * sy].map(f32::to_bits));
            self.instances.extend(r[21..25].iter().map(|v| v.to_bits()));
        }
        gl::BindBuffer(gl::ARRAY_BUFFER, self.instance_buffer);
        gl::BufferData(
            gl::ARRAY_BUFFER,
            (self.instances.len() * 4) as isize,
            self.instances.as_ptr().cast(),
            gl::STREAM_DRAW,
        );
        // GL3 has no base-instance draw: advance attribute offsets for contiguous page runs.
        // Runs preserve the producer's glyph order, including mixed font overlaps.
        for (page, first, count) in runs {
            for (unit, t) in self.pages[page].textures.iter().enumerate() {
                gl::ActiveTexture(gl::TEXTURE0 + unit as u32);
                gl::BindTexture(gl::TEXTURE_2D, *t);
            }
            for (location, size, offset, integer) in [
                (1, 4, 0, false),
                (2, 4, 4, false),
                (3, 4, 8, false),
                (4, 4, 12, false),
                (5, 4, 16, false),
                (6, 4, 20, true),
                (7, 2, 24, true),
                (8, 4, 26, false),
                (9, 4, 30, false),
            ] {
                let pointer = ((first * 34 + offset) * 4) as *const std::ffi::c_void;
                gl::EnableVertexAttribArray(location);
                gl::VertexAttribDivisor(location, 1);
                if integer {
                    gl::VertexAttribIPointer(location, size, gl::UNSIGNED_INT, 136, pointer);
                } else {
                    gl::VertexAttribPointer(location, size, gl::FLOAT, gl::FALSE, 136, pointer);
                }
            }
            gl::DrawArraysInstanced(gl::TRIANGLES, 0, 6, count as i32);
        }
        Ok(())
    }
}
impl Drop for GlyphRenderer {
    fn drop(&mut self) {
        unsafe {
            gl::DeleteProgram(self.program);
            gl::DeleteVertexArrays(1, &self.vao);
            gl::DeleteBuffers(1, &self.buffer);
            gl::DeleteBuffers(1, &self.instance_buffer);
        }
    }
}

#[no_mangle]
pub unsafe extern "C" fn pp_glyph_create() -> *mut GlyphRenderer {
    create_renderer(false)
}

#[no_mangle]
pub unsafe extern "C" fn pp_windfoil_create() -> *mut GlyphRenderer {
    create_renderer(true)
}

unsafe fn create_renderer(windfoil: bool) -> *mut GlyphRenderer {
    let result = catch_unwind(AssertUnwindSafe(|| {
        gl::load_with(|name| super::glXGetProcAddress(CString::new(name).unwrap().as_ptr().cast()));
        if gl::GetString(gl::VERSION).is_null() {
            return Err("Glyph requires a current GL context".into());
        }
        let _state = GlState::capture();
        gl::ActiveTexture(gl::TEXTURE0);
        GlyphRenderer::new(windfoil)
    }));
    match result {
        Ok(Ok(r)) => Box::into_raw(Box::new(r)),
        Ok(Err(e)) => {
            error(e);
            ptr::null_mut()
        }
        Err(_) => {
            error("Glyph initialization panicked");
            ptr::null_mut()
        }
    }
}
#[no_mangle]
pub unsafe extern "C" fn pp_glyph_draw(
    handle: *mut GlyphRenderer,
    records: *const f32,
    count: u32,
) -> i32 {
    pp_glyph_draw_tuned(handle, records, count, 1., 0.)
}

/// Additive entry point: legacy callers keep baseline coverage and ABI.
#[no_mangle]
pub unsafe extern "C" fn pp_glyph_draw_tuned(
    handle: *mut GlyphRenderer,
    records: *const f32,
    count: u32,
    exponent: f32,
    weight: f32,
) -> i32 {
    pp_glyph_draw_filtered(handle, records, count, exponent, weight, 1.)
}

/// Additive entry point; width 1 preserves the original antialiasing footprint.
#[no_mangle]
pub unsafe extern "C" fn pp_glyph_draw_filtered(
    handle: *mut GlyphRenderer,
    records: *const f32,
    count: u32,
    exponent: f32,
    weight: f32,
    aa_width: f32,
) -> i32 {
    if handle.is_null() || records.is_null() || count > 100_000 {
        error("Invalid Glyph draw arguments");
        return -1;
    }
    if !exponent.is_finite() || !(0.5..=1.).contains(&exponent)
        || !weight.is_finite() || !(0.0..=0.25).contains(&weight)
        || !aa_width.is_finite() || !(0.5..=1.).contains(&aa_width) {
        error("Invalid Glyph tuning: exponent 0.5..1, weight 0..0.25 eye pixels, AA width 0.5..1");
        return -1;
    }
    let result = catch_unwind(AssertUnwindSafe(|| {
        let _state = GlState::capture();
        (*handle).draw(slice::from_raw_parts(records, count as usize * 25), exponent, weight, aa_width)
    }));
    match result {
        Ok(Ok(())) => 0,
        Ok(Err(e)) => {
            error(e);
            -1
        }
        Err(_) => {
            error("Glyph draw panicked");
            -1
        }
    }
}
#[no_mangle]
pub unsafe extern "C" fn pp_glyph_destroy(handle: *mut GlyphRenderer) {
    if !handle.is_null() {
        let _state = GlState::capture();
        drop(Box::from_raw(handle));
    }
}
