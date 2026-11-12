"""Exercise the production native text library in a headless EGL context.

Run after `deno task text:pathfinder:build`:
  python3 tests/pathfinder_text/headless.py
Exports an exact framebuffer readback under _scratch/, never a desktop screenshot.
"""
import ctypes as C
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
egl, gl = C.CDLL("libEGL.so.1"), C.CDLL("libGL.so.1")

def function(lib, name, result, *args):
    f = getattr(lib, name)
    f.restype, f.argtypes = result, list(args)
    return f

P, I, U, F = C.c_void_p, C.c_int, C.c_uint, C.c_float
get_display = function(egl, "eglGetPlatformDisplay", P, U, P, P)
initialize = function(egl, "eglInitialize", U, P, P, P)
bind_api = function(egl, "eglBindAPI", U, U)
choose = function(egl, "eglChooseConfig", U, P, P, P, I, P)
surface_create = function(egl, "eglCreatePbufferSurface", P, P, P, P)
context_create = function(egl, "eglCreateContext", P, P, P, P, P)
make_current = function(egl, "eglMakeCurrent", U, P, P, P, P)
display = get_display(0x31DD, None, None)
assert display and initialize(display, None, None) and bind_api(0x30A2)
config, count = P(), I()
attrs = (I * 13)(0x3033, 1, 0x3040, 8, 0x3024, 8, 0x3023, 8, 0x3022, 8, 0x3021, 8, 0x3038)
assert choose(display, attrs, C.byref(config), 1, C.byref(count)) and count.value == 1
surface = surface_create(display, config, (I * 5)(0x3057, 512, 0x3056, 256, 0x3038))
context = context_create(display, config, None, (I * 7)(0x3098, 3, 0x30FB, 3, 0x30FD, 1, 0x3038))
assert surface and context and make_current(display, surface, surface, context)

get_int = function(gl, "glGetIntegerv", None, U, P)
get_float = function(gl, "glGetFloatv", None, U, P)
is_enabled = function(gl, "glIsEnabled", C.c_ubyte, U)
enable = function(gl, "glEnable", None, U)
disable = function(gl, "glDisable", None, U)
viewport = function(gl, "glViewport", None, I, I, I, I)
scissor = function(gl, "glScissor", None, I, I, I, I)
clear_color = function(gl, "glClearColor", None, F, F, F, F)
clear = function(gl, "glClear", None, U)
read = function(gl, "glReadPixels", None, I, I, I, I, U, U, P)
get_error = function(gl, "glGetError", U)
bind_texture = function(gl, "glBindTexture", None, U, U)
active_texture = function(gl, "glActiveTexture", None, U)
gen_texture = function(gl, "glGenTextures", None, I, P)
tex_image = function(gl, "glTexImage2D", None, U, I, I, I, I, I, U, U, P)
tex_param = function(gl, "glTexParameteri", None, U, U, I)
gen_framebuffer = function(gl, "glGenFramebuffers", None, I, P)
bind_framebuffer = function(gl, "glBindFramebuffer", None, U, U)
attach = function(gl, "glFramebufferTexture2D", None, U, U, U, U, I)
gen_vao = function(gl, "glGenVertexArrays", None, I, P)
bind_vao = function(gl, "glBindVertexArray", None, U)

texture, framebuffer, vao = U(), U(), U()
gen_texture(1, C.byref(texture))
bind_texture(0x0DE1, texture)
tex_image(0x0DE1, 0, 0x8058, 512, 256, 0, 0x1908, 0x1401, None)
tex_param(0x0DE1, 0x2801, 0x2601)
tex_param(0x0DE1, 0x2800, 0x2601)
gen_framebuffer(1, C.byref(framebuffer))
bind_framebuffer(0x8D40, framebuffer)
attach(0x8D40, 0x8CE0, 0x0DE1, texture, 0)
gen_vao(1, C.byref(vao))
bind_vao(vao)
viewport(0, 0, 512, 256)
clear_color(0.05, 0.15, 0.25, 1)
clear(0x4000)
enable(0x0C11)  # Deliberately non-default host scissor; vector pass must isolate it.
scissor(7, 9, 11, 13)
active_texture(0x84C3)
bind_texture(0x0DE1, texture)

def snapshot():
    values = []
    for enum, n in [(0x8CA6, 1), (0x8CAA, 1), (0x0BA2, 4), (0x0C10, 4),
                    (0x8B8D, 1), (0x85B5, 1), (0x84E0, 1), (0x8069, 1),
                    (0x80C9, 1), (0x80C8, 1), (0x80CB, 1), (0x80CA, 1),
                    (0x8009, 1), (0x883D, 1), (0x0B72, 1), (0x0B74, 1)]:
        a = (I * n)()
        get_int(enum, a)
        values += list(a)
    values += [is_enabled(e) for e in (0x0BE2, 0x0B71, 0x0B90, 0x0B44, 0x0C11, 0x8DB9)]
    color = (F * 4)()
    get_float(0x0C22, color)
    values += list(color)
    return values

lib = C.CDLL(str(ROOT / "resources/libpetplay_pathfinder_text.so"))
backend = "windfoil" if "--windfoil" in sys.argv else "glyph" if "--glyph" in sys.argv else "pf"
create = function(lib, f"pp_{backend}_create", P)
draw_backend = "glyph" if backend == "windfoil" else backend
draw = function(lib, f"pp_{draw_backend}_draw", I, P, P, U)
destroy = function(lib, f"pp_{draw_backend}_destroy", None, P)
error = function(lib, "pp_pf_error", C.c_char_p)
before = snapshot()
renderer = create()
assert renderer, error()
assert snapshot() == before, "create leaked GL state"

records = []
for row, tilt in enumerate((0.0, 0.001)):
    for column, (code, slot) in enumerate(((ord('A'), 0), (ord('g'), 0), (ord('ö'), 0), (ord('€'), 0), (0xe31b, 1))):
        # Same local baseline; each glyph gets a different model transform, in one submission.
        m = [2/512, 0, 0, tilt, 0, -2/256, 0, 0, 0, 0, 1, 0,
             -0.9 + column * 0.35, 0.6 - row * 0.8, 0, 1]
        records += [code, 0, 0, 32, slot, *m, 1, 1, 1, 1]
array = (F * len(records))(*records)
assert draw(renderer, array, len(records)//25) == 0, error()
assert snapshot() == before, "draw leaked GL state"
assert get_error() == 0, "native text pass left a GL error"
pixels = (C.c_ubyte * (512*256*4))()
read(0, 0, 512, 256, 0x1908, 0x1401, pixels)
rgb = bytes(pixels)
background = rgb[:4]
assert background[:3] == bytes((13, 38, 64)), f"background was cleared: {background}"
assert sum(rgb[i] > 100 for i in range(0, len(rgb), 4)) > 500, "glyphs did not render"
assert any(40 < rgb[i] < 240 for i in range(0, len(rgb), 4)), "no fractional edge coverage"
assert draw(renderer, array, 100001) == -1, "invalid count accepted"
assert snapshot() == before, "error path leaked GL state"
if backend == "glyph":
    # Independent CPU ray/curve evaluation checks the port and band/texture addressing
    # for a glyph with small curved counters and one with tight opposing arcs.
    import math
    import struct
    from fontTools.ttLib import TTFont
    from fontTools.pens.basePen import BasePen
    font = TTFont(ROOT / 'resources/fonts/roboto/Roboto-Regular.ttf')
    units = font['head'].unitsPerEm
    glyph_set = font.getGlyphSet()
    half = lambda v: struct.unpack('e', struct.pack('e', v))[0]

    class Pen(BasePen):
        def __init__(self):
            super().__init__(glyph_set)
            self.curves = []
        def add(self, a, b, c):
            self.curves.append(tuple((half(x/units), half(y/units)) for x, y in (a, b, c)))
        def _moveTo(self, point): self.first = point
        def _lineTo(self, end):
            a = self._getCurrentPoint()
            middle = [(a[0]+end[0])/2, (a[1]+end[1])/2]
            dx, dy = (end[0]-a[0])/units, (end[1]-a[1])/units
            if abs(dx) >= 1e-6 and abs(dy) >= 1e-6:
                length = math.hypot(dx, dy)
                middle[0] -= dy * 0.125 / length
                middle[1] += dx * 0.125 / length
            self.add(a, middle, end)
        def _qCurveToOne(self, control, end): self.add(self._getCurrentPoint(), control, end)
        def _closePath(self):
            if self._getCurrentPoint() != self.first: self._lineTo(self.first)

    def axis_coverage(curves, point, horizontal, width=1.):
        coverage, weight = 0., 0.
        axis, other = (1, 0) if horizontal else (0, 1)
        for curve in curves:
            p = [(x-point[0], y-point[1]) for x, y in curve]
            signs = sum((p[i][axis] < 0) << i for i in range(3))
            code = (0x2e74 >> signs) & 0x101
            if not code: continue
            a = p[0][axis] - 2*p[1][axis] + p[2][axis]
            b, c = p[0][axis] - p[1][axis], p[0][axis]
            d = b*b - a*c
            if abs(a) < 1/65536:
                roots = (c/(2*b),)*2
            elif d <= 0:
                roots = (b/a,)*2
            else:
                q = b + (math.sqrt(d) if b >= 0 else -math.sqrt(d))
                roots = (c/q, q/a) if b >= 0 else (q/a, c/q)
            for i, t in enumerate(roots):
                if not code & (1 if i == 0 else 256): continue
                hit = ((p[0][other]-2*p[1][other]+p[2][other])*t-2*(p[0][other]-p[1][other]))*t+p[0][other]
                hit *= 32 / width
                contribution = max(0., min(1., hit+0.5))
                coverage += contribution * (1 if (horizontal == (i == 0)) else -1)
                weight = max(weight, max(0., min(1., 1-2*abs(hit))))
        return coverage, weight

    for char in ('@', 's'):
        pen = Pen()
        glyph_set[font.getBestCmap()[ord(char)]].draw(pen)
        disable(0x0C11)
        clear_color(0, 0, 0, 1)
        clear(0x4000)
        record = (F * 25)(ord(char), 32, 200, 32, 0,
            2/512,0,0,0, 0,-2/256,0,0, 0,0,1,0, -1,1,0,1, 1,1,1,1)
        assert draw(renderer, record, 1) == 0, error()
        read(0, 0, 512, 256, 0x1908, 0x1401, pixels)
        difference = 0
        for y in range(48, 100):
            for x in range(24, 80):
                point = ((x+0.5-32)/32, (y+0.5-56)/32)
                a, wa = axis_coverage(pen.curves, point, True)
                b, wb = axis_coverage(pen.curves, point, False)
                coverage = min(1., max(abs(a*wa+b*wb)/max(wa+wb,1/65536), min(abs(a),abs(b))))
                difference = max(difference, abs(pixels[(y*512+x)*4]-round(255*coverage)))
        assert difference <= 3, f'{char}: GPU/reference coverage differs by {difference}/255'
        print(f'PASS: {char} Glyph GPU coverage matches independent curve reference ({difference}/255)')
    tuned = function(lib, 'pp_glyph_draw_tuned', I, P, P, U, F, F)
    filtered = function(lib, 'pp_glyph_draw_filtered', I, P, P, U, F, F, F)
    fractional = {1.: 0, 0.85: 0, 0.7: 0}
    for char in ('@', 's'):
        pen = Pen()
        glyph_set[font.getBestCmap()[ord(char)]].draw(pen)
        for phase in (0., 0.25, 0.5, 0.75):
            record = (F * 25)(ord(char), 32+phase, 200, 32, 0,
                2/512,0,0,0, 0,-2/256,0,0, 0,0,1,0, -1,1,0,1, 1,1,1,1)
            for width in fractional:
                clear_color(0, 0, 0, 1)
                clear(0x4000)
                state = snapshot()
                assert filtered(renderer, record, 1, 1., 0., width) == 0, error()
                assert snapshot() == state, 'AA width leaked GL state'
                read(0, 0, 512, 256, 0x1908, 0x1401, pixels)
                difference = 0
                for y in range(48, 100):
                    for x in range(24, 80):
                        point = ((x+0.5-32-phase)/32, (y+0.5-56)/32)
                        a, wa = axis_coverage(pen.curves, point, True, width)
                        b, wb = axis_coverage(pen.curves, point, False, width)
                        coverage = min(1., max(abs(a*wa+b*wb)/max(wa+wb,1/65536), min(abs(a),abs(b))))
                        value = pixels[(y*512+x)*4]
                        fractional[width] += 5 < value < 250
                        difference = max(difference, abs(value-round(255*coverage)))
                assert difference <= 3, f'AA width {width}, {char}, phase {phase}: shifted/reference error {difference}/255'
    assert fractional[0.7] < fractional[0.85] < fractional[1.], f'AA transition did not narrow: {fractional}'
    print('PASS: AA width matches unshifted CPU coverage at four pixel phases; partial-edge pixels:', fractional)
    state = snapshot()
    for width in (float('nan'), 0.49, 1.01):
        assert filtered(renderer, record, 1, 0.7, 0.125, width) == -1, 'invalid AA width accepted'
        assert snapshot() == state, 'invalid AA width leaked GL state'
    # Exact legacy/default parity, independent control effects, bounded weights,
    # perspective, light/dark polarity, opaque alpha and host-state restoration.
    for ppem in (16, 32):
        for tilt in (0., 0.003):
            for ink, paper in ((1., 0.), (0., 1.)):
                record = (F * 25)(ord('@'), 32, 100, ppem, 0,
                    2/512,0,0,tilt, 0,-2/256,0,0, 0,0,1,0, -0.5,0.5,0,1,
                    ink,ink,ink,1)
                def render_tuning(exponent=1., weight=0., legacy=False):
                    clear_color(paper, paper, paper, 1)
                    clear(0x4000)
                    state = snapshot()
                    status = draw(renderer, record, 1) if legacy else tuned(renderer, record, 1, exponent, weight)
                    assert status == 0, error()
                    assert snapshot() == state, 'tuning leaked host GL state'
                    read(0, 0, 512, 256, 0x1908, 0x1401, pixels)
                    result = bytes(pixels)
                    assert all(a == 255 for a in result[3::4]), 'tuning punched through opaque backdrop'
                    return result
                baseline = render_tuning(legacy=True)
                assert baseline == render_tuning(), 'default tuning changed legacy pixels'
                clear_color(paper, paper, paper, 1)
                clear(0x4000)
                assert filtered(renderer, record, 1, 1., 0., 1.) == 0, error()
                read(0, 0, 512, 256, 0x1908, 0x1401, pixels)
                assert bytes(pixels) == baseline, 'AA width 1 changed legacy pixels'
                base_ink = baseline[::4] if ink else bytes(255-v for v in baseline[::4])
                for exponent, weight in ((0.85, 0.), (0.7, 0.), (1., 0.125), (1., 0.25), (0.85, 0.125)):
                    result = render_tuning(exponent, weight)
                    values = result[::4] if ink else bytes(255-v for v in result[::4])
                    assert all(a >= b for a, b in zip(values, base_ink)), 'coverage tuning removed ink'
                    assert sum(values) > sum(base_ink), 'tuning had no pixel effect'
                    assert result[:64*4] == baseline[:64*4], 'tuning changed distant background'
                state = snapshot()
                for exponent, weight in ((float('nan'), 0.), (0.4, 0.), (1., -0.1), (1., 0.26)):
                    assert tuned(renderer, record, 1, exponent, weight) == -1, 'invalid tuning accepted'
                    assert snapshot() == state, 'invalid tuning leaked GL state'
    print('PASS: Glyph tuning legacy parity, coverage/weight effects, polarity, perspective and GL state')
    if '--bench' in sys.argv:
        import time
        import statistics
        finish = function(gl, 'glFinish', None)
        timings = {0.: [], 0.125: []}
        for pair in range(6):
            for weight in ((0., 0.125) if pair % 2 == 0 else (0.125, 0.)):
                finish()
                start = time.perf_counter()
                for _ in range(100):
                    assert tuned(renderer, array, len(records)//25, 0.85, weight) == 0
                finish()
                timings[weight].append((time.perf_counter()-start)*10)
        print('Paired submit+GPU-finish ms/draw (10 glyphs, 32px, 512x256; not full-scene GPU timing):',
              {weight: round(statistics.median(samples), 4) for weight, samples in timings.items()})
        print('Benchmark GL renderer:', function(gl, 'glGetString', C.c_char_p, U)(0x1F01).decode())
    # Restore host state used by the lifecycle checks below.
    enable(0x0C11)
    clear_color(0.05, 0.15, 0.25, 1)
if backend == "windfoil":
    # Independent numerical integration of original font curves: horizontal ray
    # crossings over 1024 y slices per pixel, not the shader's closed-form math.
    import numpy as np
    from fontTools.ttLib import TTFont
    from fontTools.pens.basePen import BasePen
    font = TTFont(ROOT / 'resources/fonts/roboto/Roboto-Regular.ttf')
    units = font['head'].unitsPerEm
    glyph_set = font.getGlyphSet()
    class OutlinePen(BasePen):
        def __init__(self): super().__init__(glyph_set); self.curves=[]
        def _moveTo(self, p): self.first=p
        def _lineTo(self, p):
            a=self._getCurrentPoint()
            self.curves.append(np.array([a,((a[0]+p[0])/2,(a[1]+p[1])/2),p])/units)
        def _qCurveToOne(self, c, p): self.curves.append(np.array([self._getCurrentPoint(),c,p])/units)
        def _closePath(self):
            if self._getCurrentPoint()!=self.first: self._lineTo(self.first)
    disable(0x0C11)
    filtered=function(lib,'pp_glyph_draw_filtered',I,P,P,U,F,F,F)
    for char in ('@','s','g','I'):
        pen=OutlinePen(); glyph_set[font.getBestCmap()[ord(char)]].draw(pen)
        for ppem, phase in ((16.,0.25),(32.,0.)):
            clear_color(0,0,0,1); clear(0x4000)
            record=(F*25)(ord(char),32+phase,200,ppem,0,
                2/512,0,0,0, 0,-2/256,0,0, 0,0,1,0, -1,1,0,1, 1,1,1,1)
            state=snapshot()
            assert draw(renderer,record,1)==0,error()
            assert snapshot()==state,'Windfoil draw leaked GL state'
            read(0,0,512,256,0x1908,0x1401,pixels)
            baseline=bytes(pixels)
            maximum=0
            for y in range(48,96):
                ys=(y-56+(np.arange(1024)+0.5)/1024)/ppem
                xlo=(np.arange(24,80)-32-phase)/ppem
                winding=np.zeros((len(ys),len(xlo)))
                for p0,p1,p2 in pen.curves:
                    a=p0-2*p1+p2; b=2*(p1-p0)
                    if abs(a[1])<1e-12:
                        if abs(b[1])<1e-12: continue
                        roots=[(ys-p0[1])/b[1]]
                    else:
                        disc=b[1]*b[1]-4*a[1]*(p0[1]-ys)
                        sq=np.sqrt(np.maximum(disc,0))
                        roots=[np.where(disc>=0,(-b[1]+sq)/(2*a[1]),-1),np.where(disc>=0,(-b[1]-sq)/(2*a[1]),-1)]
                    for t in roots:
                        valid=(t>=0)&(t<1)
                        x=(a[0]*t+b[0])*t+p0[0]
                        direction=np.sign(2*a[1]*t+b[1])*valid
                        winding+=np.clip((x[:,None]-xlo)*ppem,0,1)*direction[:,None]
                reference=np.clip(np.abs(np.mean(winding,axis=0)),0,1)*255
                actual=np.array([pixels[(y*512+x)*4] for x in range(24,80)])
                maximum=max(maximum,float(np.max(np.abs(actual-np.rint(reference)))))
            assert maximum<=3,f'Windfoil {char} {ppem}px differs from independent numerical area by {maximum}/255'
            clear(0x4000)
            assert filtered(renderer,record,1,1.,0.,1.)==0,error()
            read(0,0,512,256,0x1908,0x1401,pixels)
            assert bytes(pixels)==baseline,'Windfoil default tuning changed baseline'
            print(f'PASS: Windfoil {char} {ppem}px numerical box coverage max error {maximum}/255')
    enable(0x0C11); clear_color(0.05,0.15,0.25,1)
destroy(renderer)
assert snapshot() == before, "destroy leaked GL state"
assert get_error() == 0
output = ROOT / f"_scratch/{backend}-native-integration.ppm"
with output.open('wb') as file:
    file.write(b'P6\n512 256\n255\n')
    for y in range(255, -1, -1):
        for x in range(512):
            i = (y*512+x)*4
            file.write(rgb[i:i+3])
print(f"PASS: native create/draw/destroy, GL state, backgrounds, glyphs, perspective, input limit; {output}")
make_current(display, None, None, None)
function(egl, 'eglDestroyContext', U, P, P)(display, context)
function(egl, 'eglDestroySurface', U, P, P)(display, surface)
function(egl, 'eglTerminate', U, P)(display)
