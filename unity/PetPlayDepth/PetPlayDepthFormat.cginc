// PetPlay depth block, version 4: the shader half of classes/vrchatDepth/format.ts.
// That file is the reference and documents the layout; keep the two identical.
#ifndef PETPLAY_DEPTH_FORMAT
#define PETPLAY_DEPTH_FORMAT

#define PPD_MAGIC 0x50445050u
#define PPD_VERSION 4u
#define PPD_PREAMBLE_BITS 64u
#define PPD_HEADER_WORDS 48u
#define PPD_LIGHTING_WORDS 1728u // 130 base lighting + 1598 paged spatial SH; format v4 is length-delimited
#define PPD_CHECKSUM_WORD 47u
#define PPD_QUIET_CELLS 2
#define PPD_CALIBRATION_3D 0x80u   // preamble flag in the bitsR byte
#define PPD_MAX_LEVEL_INSET 64u

#define PPD_FLAG_PROJECTION_FLIPPED 1u
#define PPD_FLAG_REVERSED_Z 2u
#define PPD_FLAG_STEREO_INSTANCED 4u
#define PPD_FLAG_SINGLE_PASS_DOUBLE_WIDE 8u
#define PPD_FLAG_VRCHAT_CAMERA 16u
#define PPD_FLAG_DEPTH_CAMERA 32u     // depth from the avatar's own depth camera, not this pass

struct PPDLayout
{
    uint3 bits;
    uint calibration3D;   // 1: one calibration cell per level combination (equal bits)
    uint gridWidth;
    uint depthWidth;
    uint depthHeight;
    uint lightingWords;
    uint levelInset;      // level bytes span inset .. 255 - 2 inset
    uint bitsPerCell;
    uint calibrationCells;
    uint dataStartRow;
    uint headWords;       // header + lighting record
    uint headCells;
    uint depthStartCell;  // one cell per depth sample
    uint trailerStartCell;
    uint dataCells;
    uint gridHeight;
};

PPDLayout PPDDeriveLayout(uint3 bits, uint gridWidth, uint depthWidth, uint depthHeight, uint calibration3D, uint levelInset)
{
    PPDLayout l;
    l.calibration3D = calibration3D;
    // 3D calibration needs n^3 cells and equal channels: red's bits for all, at most 6.
    if (calibration3D != 0u) bits = (uint3)min(bits.x, 6u);
    l.bits = bits;
    l.gridWidth = gridWidth;
    l.depthWidth = depthWidth;
    l.depthHeight = depthHeight;
    l.lightingWords = PPD_LIGHTING_WORDS;
    l.levelInset = min(levelInset, PPD_MAX_LEVEL_INSET);
    l.bitsPerCell = bits.x + bits.y + bits.z;
    l.calibrationCells = calibration3D != 0u
        ? (1u << bits.x) * (1u << bits.x) * (1u << bits.x)
        : (1u << bits.x) + (1u << bits.y) + (1u << bits.z);
    l.dataStartRow = 2u + (l.calibrationCells + gridWidth - 1u) / gridWidth;
    l.headWords = PPD_HEADER_WORDS + PPD_LIGHTING_WORDS;
    l.headCells = (l.headWords * 32u + l.bitsPerCell - 1u) / l.bitsPerCell;
    l.depthStartCell = l.headCells;
    l.trailerStartCell = l.depthStartCell + depthWidth * depthHeight;
    l.dataCells = l.trailerStartCell + (32u + l.bitsPerCell - 1u) / l.bitsPerCell;
    l.gridHeight = l.dataStartRow + (l.dataCells + gridWidth - 1u) / gridWidth;
    return l;
}

uint PPDLayoutWord0(PPDLayout l)
{
    uint r = l.bits.x | (l.calibration3D != 0u ? PPD_CALIBRATION_3D : 0u);
    return PPD_VERSION | (r << 8) | (l.bits.y << 16) | (l.bits.z << 24);
}
uint PPDLayoutWord1(PPDLayout l) { return l.gridWidth | (l.gridHeight << 16); }

// Log depth over `bits` bits from `near` to `far` (format.ts quantizeDepth); 0 = no depth.
uint PPDQuantizeDepth(float metres, float near, float far, uint bits)
{
    if (!(metres > 0.0) || isinf(metres)) return 0u;
    float top = (float)((1u << bits) - 1u);
    float t = log(metres / near) / log(far / near);
    return (uint)clamp(1.0 + round(t * (top - 1.0)), 1.0, top);
}

// The per-frame values the header carries; the exporter fills it once per fragment.
struct PPDFrame
{
    uint timeTag;
    uint eye;
    uint flags;
    float4x4 viewToWorld;   // rows 0..2 are exported
    float4 projection;      // m00, m11, m02, m12
    float nearPlane;
    float farPlane;
    float2 screenSize;
    float depthRef;         // log depth near
    float depthFar;         // log depth far
    float4x4 anchorToWorld; // rows 0..2 are exported: the head anchor's frame, scale removed
};

// -0.0 is written as +0.0: shader compilers don't keep the sign of zero consistently between two
// uses of one value, and the checksum must see exactly the bits that were sent.
uint PPDFloatWord(float v)
{
    uint u = asuint(v);
    return (u & 0x7fffffffu) == 0u ? 0u : u;
}

uint PPDHeaderWordRaw(PPDLayout l, PPDFrame f, uint i)
{
    if (i == 0u) return PPD_MAGIC;
    if (i == 1u) return PPDLayoutWord0(l);
    if (i == 2u) return PPDLayoutWord1(l);
    if (i == 3u) return l.depthWidth | (l.depthHeight << 16);
    if (i == 4u) return f.timeTag;
    if (i == 5u) return (f.eye & 0xffu) | ((f.flags & 0xffffffu) << 8);
    if (i < 18u)
    {
        uint k = i - 6u;
        return PPDFloatWord(f.viewToWorld[k / 4u][k % 4u]);
    }
    if (i < 22u) return PPDFloatWord(f.projection[i - 18u]);
    if (i == 22u) return PPDFloatWord(f.nearPlane);
    if (i == 23u) return PPDFloatWord(f.farPlane);
    if (i == 24u) return PPDFloatWord(f.screenSize.x);
    if (i == 25u) return PPDFloatWord(f.screenSize.y);
    if (i == 26u) return PPDFloatWord(f.depthRef);
    if (i < 39u)
    {
        uint k = i - 27u;
        return PPDFloatWord(f.anchorToWorld[k / 4u][k % 4u]);
    }
    if (i == 39u) return l.lightingWords;
    if (i == 40u) return PPDFloatWord(f.depthFar);
    if (i == 41u) return l.levelInset;
    return 0u;   // 42..46 reserved
}

uint PPDHeaderWord(PPDLayout l, PPDFrame f, uint i)
{
    if (i != PPD_CHECKSUM_WORD) return PPDHeaderWordRaw(l, f, i);
    uint h = 0x811c9dc5u;
    [loop] for (uint k = 0u; k < PPD_CHECKSUM_WORD; k++) h = (h ^ PPDHeaderWordRaw(l, f, k)) * 0x01000193u;
    return h;
}

// Supplied by the exporter: quantized depth of sample `index` (PPDQuantizeDepth over
// l.bitsPerCell bits), row-major from the top-left of the eye image.
uint PPDDepthSample(PPDLayout l, PPDFrame f, uint index);
// Supplied by the exporter: float `index` of the lighting record (format.ts LIGHTING).
float PPDLightingFloat(uint index);

// Head word i: the header, then the lighting record.
uint PPDWord(PPDLayout l, PPDFrame f, uint i)
{
    if (i < PPD_HEADER_WORDS) return PPDHeaderWord(l, f, i);
    if (i < l.headWords) return PPDFloatWord(PPDLightingFloat(i - PPD_HEADER_WORDS));
    return 0u;
}

// `n` bits starting at bit `start` of the 64-bit window (w0 = word `base`, w1 = word `base + 1`).
uint PPDBits(uint w0, uint w1, uint start, uint n)
{
    uint v = start < 32u ? (w0 >> start) | (start == 0u ? 0u : (w1 << (32u - start))) : (w1 >> (start - 32u));
    return v & ((1u << n) - 1u);
}

float PPDLevelValue(uint level, uint bits, uint inset)
{
    // The byte lo + round(level * (hi - lo) / (2^bits - 1)), lo = inset, hi = 255 - 2 inset
    // (format.ts levelByte), as a linear value an sRGB target stores exactly.
    float lo = inset, hi = 255.0 - 2.0 * inset;
    float b = lo + round(level * (hi - lo) / ((1u << bits) - 1u));
    return GammaToLinearSpaceExact(b / 255.0);
}

// Colour of cell (cx, cy); cells outside the grid are the black quiet zone.
float3 PPDCellColor(PPDLayout l, PPDFrame f, int cx, int cy)
{
    if (cx < 0 || cy < 0 || cx >= (int)l.gridWidth || cy >= (int)l.gridHeight) return 0;
    uint x = (uint)cx;
    uint y = (uint)cy;
    if (y == 0u) return (x & 1u) == 0u ? 1.0 : 0.0;
    if (y == 1u)
    {
        if (x >= PPD_PREAMBLE_BITS) return 0;
        uint w = x < 32u ? PPDLayoutWord0(l) : PPDLayoutWord1(l);
        return ((w >> (x & 31u)) & 1u) ? 1.0 : 0.0;
    }
    uint index = y * l.gridWidth + x;
    uint calibration = index - 2u * l.gridWidth;
    if (y < l.dataStartRow)
    {
        if (l.calibration3D != 0u)
        {
            uint n = 1u << l.bits.x;
            if (calibration >= n * n * n) return 0;
            return float3(PPDLevelValue(calibration % n, l.bits.x, l.levelInset),
                PPDLevelValue((calibration / n) % n, l.bits.x, l.levelInset),
                PPDLevelValue(calibration / (n * n), l.bits.x, l.levelInset));
        }
        float3 c = 0;
        uint r = 1u << l.bits.x;
        uint g = 1u << l.bits.y;
        uint b = 1u << l.bits.z;
        if (calibration < r) c.r = PPDLevelValue(calibration, l.bits.x, l.levelInset);
        else if (calibration < r + g) c.g = PPDLevelValue(calibration - r, l.bits.y, l.levelInset);
        else if (calibration < r + g + b) c.b = PPDLevelValue(calibration - r - g, l.bits.z, l.levelInset);
        return c;
    }
    uint s = index - l.dataStartRow * l.gridWidth;
    if (s >= l.dataCells) return 0;
    uint v;
    if (s < l.headCells)
    {
        uint bit = s * l.bitsPerCell;
        uint base = bit >> 5;
        uint start = bit & 31u;
        // A cell carries at most 24 bits, so it spans at most two words.
        uint w0 = PPDWord(l, f, base);
        uint w1 = start + l.bitsPerCell > 32u ? PPDWord(l, f, base + 1u) : 0u;
        v = PPDBits(w0, w1, start, l.bitsPerCell);
    }
    else if (s < l.trailerStartCell)
    {
        v = PPDDepthSample(l, f, s - l.depthStartCell);
    }
    else
    {
        uint bit = (s - l.trailerStartCell) * l.bitsPerCell;
        v = PPDBits(f.timeTag, 0u, bit, l.bitsPerCell);
    }
    uint r = v & ((1u << l.bits.x) - 1u);
    uint g = (v >> l.bits.x) & ((1u << l.bits.y) - 1u);
    uint b = (v >> (l.bits.x + l.bits.y)) & ((1u << l.bits.z) - 1u);
    return float3(PPDLevelValue(r, l.bits.x, l.levelInset), PPDLevelValue(g, l.bits.y, l.levelInset),
        PPDLevelValue(b, l.bits.z, l.levelInset));
}

#endif
