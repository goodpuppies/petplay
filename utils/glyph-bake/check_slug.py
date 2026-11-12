"""Decode Slug glyphs from baked .font.glb files and compare with the source fonts' outlines.

Usage (from the directory holding roboto.font.glb and icons.font.glb):
    python3 -I <repo>/utils/glyph-bake/check_slug.py
Needs fontTools. See markdown/glyph-portable-text.md.
"""
import io, json, os, struct, sys
from fontTools.ttLib import TTFont
from fontTools.pens.basePen import BasePen

def load(glb):
    b = open(glb, 'rb').read()
    jl = struct.unpack('<I', b[12:16])[0]
    j = json.loads(b[20:20 + jl])
    binoff = 20 + jl + 8
    view = lambda i: b[binoff + j['bufferViews'][i]['byteOffset']:binoff + j['bufferViews'][i]['byteOffset'] + j['bufferViews'][i]['byteLength']]
    font = j['extensions']['PMNDRS_font']; slug = j['extensions']['PMNDRS_font_slug']
    shaping = TTFont(io.BytesIO(view(font['shaping']['bufferView'])))
    page = slug['pages'][0]
    ktx = view(page['curve']['variants'][0]['source']['bufferView'])
    assert ktx[:12] == b'\xabKTX 20\xbb\r\n\x1a\n', 'not KTX2'
    vk, _, w, h = struct.unpack('<4I', ktx[12:28]); scheme = struct.unpack('<I', ktx[44:48])[0]
    lo, ln = struct.unpack('<QQ', ktx[80:96])
    assert scheme == 0, f'supercompressed ({scheme})'
    curves = ktx[lo:lo + ln]
    return dict(cmap=shaping.getBestCmap(), order=shaping.getGlyphOrder(), records=view(slug['recordBufferView']),
                curves=curves, width=w, upem=font['metrics']['unitsPerEm'], vk=vk)

def half(bs, o): return struct.unpack('<e', bs[o:o + 2])[0]

def decode(f, gid):
    r = f['records'][gid * 40:gid * 40 + 40]
    left, bottom, right, top, page, hb, vb, flags, base, span = struct.unpack('<4h4H2I', r[:24])
    pts = []
    for t in range(base, base + span):
        v = [half(f['curves'], t * 8 + 2 * c) for c in range(4)]
        pts.append((v[0], v[1]))  # start (or contour end point); skips padding only if all zero
    return (left, bottom, right, top), pts

class Points(BasePen):
    def __init__(s, gs): super().__init__(gs); s.on = []
    def _moveTo(s, p): s.on.append(p)
    def _lineTo(s, p): s.on.append(p)
    def _qCurveToOne(s, c, p): s.on.append(p)
    def _curveToOne(s, a, b, p): s.on.append(p)

def check(glb, ttf, chars):
    f = load(glb); src = TTFont(ttf); gs = src.getGlyphSet(); scmap = src.getBestCmap(); ok = True
    for ch in chars:
        gid = f['order'].index(f['cmap'][ch])
        bounds, decoded = decode(f, gid)
        pen = Points(gs); gs[scmap[ch]].draw(pen)
        want = {(round(x / f['upem'], 3), round(y / f['upem'], 3)) for x, y in pen.on}
        got = {(round(x, 3), round(y, 3)) for x, y in decoded}
        missing = [p for p in want if not any(abs(p[0] - q[0]) <= 2e-3 and abs(p[1] - q[1]) <= 2e-3 for q in got)]
        xs = [p[0] for p in want]; ys = [p[1] for p in want]
        b = [round(v / 2048, 3) for v in bounds]
        status = 'ok' if not missing else f'MISSING {len(missing)}/{len(want)}'
        ok &= not missing
        print(f'U+{ch:04X} gid={gid} texels={len(decoded)} on-curve={len(want)} {status} bounds={b} src=[{min(xs)},{min(ys)},{max(xs)},{max(ys)}]')
    return ok

def check_gaps(glb, ttf):
    """glyphFont.ts fills zero last-column curve texels from the next texel. That is exact unless a
    contour can close at (0, 0) em, which this bake must rule out for every glyph with such a gap."""
    from fontTools.ttLib import TTFont
    f = load(glb); w = f['width']; glyf = TTFont(ttf)['glyf']; ok = True
    names = {gid: name for name, gid in ((n, f['order'].index(n)) for n in f['order'])}
    for gid in range(len(f['records']) // 40):
        page, = struct.unpack('<H', f['records'][gid * 40 + 8:gid * 40 + 10])
        if page == 0xFFFF: continue
        base, span = struct.unpack('<2I', f['records'][gid * 40 + 16:gid * 40 + 24])
        gaps = [t for t in range(base, base + span - 1)
                if t % w == w - 1 and f['curves'][t * 8:t * 8 + 8] == bytes(8)]
        if not gaps: continue
        glyph = glyf[names[gid]] if names[gid] in glyf else None
        at_origin = glyph is not None and glyph.numberOfContours > 0 and \
            (0, 0) in [tuple(p) for p in glyph.getCoordinates(glyf)[0]]
        print(f'{glb}: glyph {names[gid]} has {len(gaps)} packer gap(s); ' + ('AMBIGUOUS: has a point at (0, 0)' if at_origin else 'unambiguous'))
        ok &= not at_origin
    return ok

if __name__ == '__main__':
    fonts = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'resources', 'fonts') + os.sep
    a = check('roboto.font.glb', fonts + 'roboto/Roboto-Regular.ttf', [ord(c) for c in '@sAgé€'])
    b = check('icons.font.glb', fonts + 'material-icons/MaterialIcons-Regular.ttf', [0xE5C4, 0xE145, 0xE8B8] )
    c = check_gaps('roboto.font.glb', fonts + 'roboto/Roboto-Regular.ttf')
    d = check_gaps('icons.font.glb', fonts + 'material-icons/MaterialIcons-Regular.ttf')
    sys.exit(0 if a and b and c and d else 1)
