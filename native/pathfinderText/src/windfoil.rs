//! Windfoil comparison preparation: exact lines and xy-monotone quadratic pieces.
//! Adapted from Rune's outline/build.rs and texel-org/windfoil-algorithm geometry.js.
//! See WINDFOIL-NOTICE.md for provenance and licenses. No hinting or outline dilation.
use pmndrs_glyph_slug_core::{Point, Quadratic};

fn mix(a: Point, b: Point, t: f32) -> Point {
    Point::new(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)
}
fn split(q: Quadratic, t: f32) -> (Quadratic, Quadratic) {
    let a = mix(q.p0, q.p1, t);
    let b = mix(q.p1, q.p2, t);
    let p = mix(a, b, t);
    (Quadratic { p0: q.p0, p1: a, p2: p }, Quadratic { p0: p, p1: b, p2: q.p2 })
}
pub fn monotone(q: Quadratic) -> Vec<Quadratic> {
    let mut cuts = Vec::new();
    for (a, b, c) in [(q.p0.x, q.p1.x, q.p2.x), (q.p0.y, q.p1.y, q.p2.y)] {
        let denominator = a - 2. * b + c;
        if denominator != 0. {
            let t = (a - b) / denominator;
            if t > 0. && t < 1. && !cuts.contains(&t) { cuts.push(t); }
        }
    }
    cuts.sort_by(f32::total_cmp);
    let mut pieces = Vec::new();
    let mut rest = q;
    let mut previous = 0.;
    for t in cuts {
        let (first, next) = split(rest, (t - previous) / (1. - previous));
        pieces.push(first);
        rest = next;
        previous = t;
    }
    pieces.push(rest);
    pieces
}
