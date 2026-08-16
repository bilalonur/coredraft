/* ============================================================
   coredraft — geometry unit tests
   ------------------------------------------------------------
   Zero-dependency test runner: `node tests/geometry.test.js`
   Exits non-zero on any failure. Covers the pure helpers in
   geometry.js (eraser interval math and shape sampling).
   ============================================================ */

const {
  circleSegmentInterval,
  mergeIntervals,
  complementIntervals,
  sampleShapePoints,
  simplifyPath,
  classifyStroke,
  refineStroke,
  refinePrecision
} = require('../geometry.js');

let passed = 0;
let failed = 0;

function assertClose(a, b, eps = 1e-9, label = '') {
  const ok = Math.abs(a - b) <= eps;
  if (ok) { passed++; } else {
    failed++;
    console.error(`FAIL ${label}: expected ${a} ≈ ${b} (diff ${Math.abs(a - b)})`);
  }
}

function assertEqual(actual, expected, label = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) { passed++; } else {
    failed++;
    console.error(`FAIL ${label}: expected ${b}, got ${a}`);
  }
}

function assertTrue(cond, label = '') {
  if (cond) { passed++; } else { failed++; console.error(`FAIL ${label}`); }
}

// ── circleSegmentInterval ─────────────────────────────────

// Segment fully inside circle → [0, 1]
assertEqual(circleSegmentInterval(0, 0, 1, 0, 0.5, 0, 2), [0, 1], 'segment fully inside');

// Segment fully outside circle → null
assertEqual(circleSegmentInterval(0, 0, 1, 0, 5, 5, 1), null, 'segment fully outside');

// Circle overlapping one endpoint: segment (0,0)→(10,0), circle at (0,0) r=2 → [0, 0.2]
assertClose(circleSegmentInterval(0, 0, 10, 0, 0, 0, 2)[0], 0, 1e-9, 'endpoint overlap lo');
assertClose(circleSegmentInterval(0, 0, 10, 0, 0, 0, 2)[1], 0.2, 1e-9, 'endpoint overlap hi');

// Circle in the middle: segment (0,0)→(10,0), circle at (5,0) r=1 → [0.4, 0.6]
assertClose(circleSegmentInterval(0, 0, 10, 0, 5, 0, 1)[0], 0.4, 1e-9, 'mid overlap lo');
assertClose(circleSegmentInterval(0, 0, 10, 0, 5, 0, 1)[1], 0.6, 1e-9, 'mid overlap hi');

// Line passes close but misses (disc < 0) → null
assertEqual(circleSegmentInterval(0, 0, 10, 0, 5, 2, 1), null, 'line misses circle');

// Segment fully inside but infinite line misses (disc < 0, c < 0) → [0, 1]
assertEqual(circleSegmentInterval(0, 0, 1, 0, 0.5, 0, 2), [0, 1], 'covered by big circle');

// Degenerate point segment inside circle → [0, 1]
assertEqual(circleSegmentInterval(3, 3, 3, 3, 3, 3, 1), [0, 1], 'degenerate point inside');

// Degenerate point segment outside circle → null
assertEqual(circleSegmentInterval(3, 3, 3, 3, 10, 10, 1), null, 'degenerate point outside');

// Circle contains the whole segment (disc > 0 but roots outside [0,1]) → [0, 1]
assertEqual(circleSegmentInterval(0, 0, 1, 0, 50, 0, 60), [0, 1], 'segment inside huge circle');

// ── mergeIntervals ────────────────────────────────────────

assertEqual(mergeIntervals([]), [], 'empty input');
assertEqual(mergeIntervals([[0.1, 0.2]]), [[0.1, 0.2]], 'single interval');
assertEqual(
  mergeIntervals([[0.5, 0.9], [0.1, 0.2]]),
  [[0.1, 0.2], [0.5, 0.9]],
  'sorted disjoint'
);
assertEqual(
  mergeIntervals([[0.1, 0.5], [0.4, 0.8]]),
  [[0.1, 0.8]],
  'overlapping merge'
);
assertEqual(
  mergeIntervals([[0.1, 0.4], [0.4, 0.8]]),
  [[0.1, 0.8]],
  'adjacent merge'
);
assertEqual(
  mergeIntervals([[0.2, 0.3], [0.5, 0.6], [0.1, 0.25]]),
  [[0.1, 0.3], [0.5, 0.6]],
  'three-way merge'
);
assertEqual(
  mergeIntervals([[0.2, 0.3], [0.1, 0.8]]),
  [[0.1, 0.8]],
  'contained merge'
);

// ── complementIntervals ───────────────────────────────────

assertEqual(complementIntervals([], 0, 1), [[0, 1]], 'no removal → full survivor');
assertEqual(complementIntervals([[0, 1]], 0, 1), [], 'full removal → no survivors');
assertEqual(
  complementIntervals([[0.4, 0.6]], 0, 1),
  [[0, 0.4], [0.6, 1]],
  'middle removal → two survivors'
);
assertEqual(
  complementIntervals([[0, 0.3], [0.7, 1]], 0, 1),
  [[0.3, 0.7]],
  'both ends removed → middle survivor'
);
assertEqual(
  complementIntervals([[0.2, 0.4], [0.6, 0.8]], 0, 1),
  [[0, 0.2], [0.4, 0.6], [0.8, 1]],
  'two middle removals → three survivors'
);
assertEqual(
  complementIntervals([[0.5, 0.9]], 0.5, 0.9),
  [],
  'removal exactly covering window → no survivors'
);

// ── sampleShapePoints ─────────────────────────────────────

// Line from (0,0) to (10,0): 49 points, first at (0,0), last at (10,0)
const linePts = sampleShapePoints({ type: 'line', x1: 0, y1: 0, x2: 10, y2: 0 });
assertEqual(linePts.length, 49, 'line point count');
assertClose(linePts[0].x, 0, 1e-9, 'line first point x');
assertClose(linePts[0].y, 0, 1e-9, 'line first point y');
assertClose(linePts[48].x, 10, 1e-9, 'line last point x');

// Rect (0,0)-(10,10): 48 points total (12 per side), all on the outline
const rectPts = sampleShapePoints({ type: 'rect', x1: 0, y1: 0, x2: 10, y2: 10 });
assertEqual(rectPts.length, 48, 'rect point count');
assertTrue(rectPts.every(p => p.x >= 0 && p.x <= 10 && p.y >= 0 && p.y <= 10), 'rect points within bounds');
assertTrue(
  rectPts.every(p => Math.abs(p.x) < 1e-9 || Math.abs(p.x - 10) < 1e-9 ||
                     Math.abs(p.y) < 1e-9 || Math.abs(p.y - 10) < 1e-9),
  'rect points on outline'
);

// Rect with reversed corners (dragging up-left) normalizes correctly
const rectPtsRev = sampleShapePoints({ type: 'rect', x1: 10, y1: 10, x2: 0, y2: 0 });
assertEqual(rectPtsRev.length, 48, 'reversed rect point count');
assertTrue(rectPtsRev.every(p => p.x >= 0 && p.x <= 10 && p.y >= 0 && p.y <= 10), 'reversed rect within bounds');

// Circle centered at (5,5) with radii 5: 49 points, all at distance ~5 from center
const circlePts = sampleShapePoints({ type: 'circle', x1: 0, y1: 0, x2: 10, y2: 10 });
assertEqual(circlePts.length, 49, 'circle point count');
assertTrue(
  circlePts.every(p => Math.abs(Math.hypot(p.x - 5, p.y - 5) - 5) < 1e-9),
  'circle points on outline'
);
assertClose(circlePts[0].x, 10, 1e-9, 'circle first point x (angle 0)');
assertClose(circlePts[0].y, 5, 1e-9, 'circle first point y (angle 0)');

// Arrow uses the same sampling as line
const arrowPts = sampleShapePoints({ type: 'arrow', x1: 0, y1: 0, x2: 10, y2: 0 });
assertEqual(arrowPts.length, 49, 'arrow point count');
assertClose(arrowPts[48].x, 10, 1e-9, 'arrow last point x');

// Unknown type → empty array
assertEqual(sampleShapePoints({ type: 'text' }), [], 'unknown type → empty');

// ── Smart stroke helpers ──────────────────────────────────

// Deterministic pseudo-random wobble so the shape tests never flake.
let seed = 12345;
function wobble(amp) {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return ((seed / 0x7fffffff) - 0.5) * 2 * amp;
}

// Trace a closed polygon outline, optionally starting part-way along it
// (a user rarely starts drawing exactly on a corner).
function tracePolygon(corners, samples, noise, startFraction = 0) {
  const segs = [];
  let perimeter = 0;
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i], b = corners[(i + 1) % corners.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    segs.push({ a, b, len });
    perimeter += len;
  }
  const pts = [];
  for (let k = 0; k <= samples; k++) {
    let d = ((k / samples + startFraction) % 1) * perimeter;
    for (const s of segs) {
      if (d <= s.len) {
        const f = s.len ? d / s.len : 0;
        pts.push({
          x: s.a.x + (s.b.x - s.a.x) * f + wobble(noise),
          y: s.a.y + (s.b.y - s.a.y) * f + wobble(noise),
          w: 3
        });
        break;
      }
      d -= s.len;
    }
  }
  return pts;
}

function traceCircle(cx, cy, r, samples, noise) {
  const pts = [];
  for (let i = 0; i <= samples; i++) {
    const a = (i / samples) * Math.PI * 2;
    pts.push({ x: cx + (r + wobble(noise)) * Math.cos(a), y: cy + (r + wobble(noise)) * Math.sin(a), w: 3 });
  }
  return pts;
}

// ── simplifyPath ──────────────────────────────────────────

// Fewer than three points: nothing to drop, returned as a copy
assertEqual(simplifyPath([], 1), [], 'simplify empty');
assertEqual(simplifyPath([{ x: 0, y: 0, w: 1 }], 1), [{ x: 0, y: 0, w: 1 }], 'simplify single point');

// Collinear points collapse to the two endpoints
const straight = [];
for (let i = 0; i <= 10; i++) straight.push({ x: i * 10, y: 0, w: 2 });
assertEqual(simplifyPath(straight, 1).length, 2, 'collinear collapses to endpoints');

// A point that deviates beyond the tolerance survives; below it, it does not
const bent = [{ x: 0, y: 0, w: 2 }, { x: 50, y: 20, w: 2 }, { x: 100, y: 0, w: 2 }];
assertEqual(simplifyPath(bent, 5).length, 3, 'corner above tolerance kept');
assertEqual(simplifyPath(bent, 30).length, 2, 'corner below tolerance dropped');

// An L-shape keeps exactly its elbow
const elbow = [];
for (let i = 0; i <= 10; i++) elbow.push({ x: i * 10, y: 0, w: 2 });
for (let i = 1; i <= 10; i++) elbow.push({ x: 100, y: i * 10, w: 2 });
assertEqual(simplifyPath(elbow, 2).length, 3, 'L-shape keeps its elbow');

// Simplification never invents points and always keeps the endpoints
const simplifiedElbow = simplifyPath(elbow, 2);
assertEqual(simplifiedElbow[0], elbow[0], 'simplify keeps first point');
assertEqual(simplifiedElbow[simplifiedElbow.length - 1], elbow[elbow.length - 1], 'simplify keeps last point');

// ── classifyStroke ────────────────────────────────────────

assertEqual(classifyStroke(traceCircle(100, 100, 80, 60, 0)), 'circle', 'clean circle');
assertEqual(classifyStroke(traceCircle(100, 100, 80, 60, 4)), 'circle', 'wobbly circle');
assertEqual(classifyStroke(traceCircle(-50, 220, 12, 40, 0.5)), 'circle', 'small off-origin circle');

const squareCorners = [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 190 }, { x: 0, y: 190 }];
assertEqual(classifyStroke(tracePolygon(squareCorners, 80, 2)), 'rectangle', 'square from a corner');
assertEqual(classifyStroke(tracePolygon(squareCorners, 80, 2, 0.13)), 'rectangle', 'square starting mid-edge');

const wideRect = [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 90 }, { x: 0, y: 90 }];
assertEqual(classifyStroke(tracePolygon(wideRect, 90, 3)), 'rectangle', 'wide rectangle');

const triCorners = [{ x: 0, y: 0 }, { x: 150, y: 0 }, { x: 75, y: 130 }];
assertEqual(classifyStroke(tracePolygon(triCorners, 70, 2)), 'triangle', 'triangle from a corner');
assertEqual(classifyStroke(tracePolygon(triCorners, 70, 2, 0.2)), 'triangle', 'triangle starting mid-edge');

// Open paths are never shapes, however tidy they look
const openArc = traceCircle(100, 100, 80, 60, 0).slice(0, 40);
assertEqual(classifyStroke(openArc), 'freehand', 'open arc is freehand');

const squiggle = [];
for (let i = 0; i < 60; i++) squiggle.push({ x: i * 5, y: 40 * Math.sin(i / 6), w: 3 });
assertEqual(classifyStroke(squiggle), 'freehand', 'squiggle is freehand');

// A closed but lumpy loop stays freehand (radial variance too high)
const lumpy = [];
for (let i = 0; i <= 80; i++) {
  const a = (i / 80) * Math.PI * 2;
  const r = 80 + 35 * Math.sin(a * 5);
  lumpy.push({ x: 100 + r * Math.cos(a), y: 100 + r * Math.sin(a), w: 3 });
}
assertEqual(classifyStroke(lumpy), 'freehand', 'lumpy loop is freehand');

// Too few points to judge, and degenerate input
assertEqual(classifyStroke([{ x: 0, y: 0, w: 1 }, { x: 1, y: 1, w: 1 }]), 'freehand', 'two points are freehand');
assertEqual(classifyStroke([]), 'freehand', 'empty stroke is freehand');
const dot = [];
for (let i = 0; i < 12; i++) dot.push({ x: 5, y: 5, w: 3 });
assertEqual(classifyStroke(dot), 'freehand', 'zero-size stroke is freehand');

// ── refineStroke ──────────────────────────────────────────

// Circle → 36 points on one radius, closing back onto the start
const rawCircle = traceCircle(100, 100, 80, 60, 4);
const fineCircle = refineStroke(rawCircle, 'circle');
assertEqual(fineCircle.length, 36, 'circle refines to 36 points');
// The 35 distinct samples (the 36th repeats the first) average to the centre
const ring = fineCircle.slice(0, 35);
const fitX = ring.reduce((s, p) => s + p.x, 0) / ring.length;
const fitY = ring.reduce((s, p) => s + p.y, 0) / ring.length;
const rMean = ring.reduce((s, p) => s + Math.hypot(p.x - fitX, p.y - fitY), 0) / ring.length;
assertTrue(
  fineCircle.every(p => Math.abs(Math.hypot(p.x - fitX, p.y - fitY) - rMean) < 1e-9),
  'refined circle points are equidistant from the centre'
);
assertTrue(Math.hypot(fitX - 100, fitY - 100) < 5, 'refined circle is centred on the drawn circle');
assertTrue(Math.abs(rMean - 80) < 5, 'refined circle radius matches the drawn radius');
assertClose(fineCircle[0].x, fineCircle[35].x, 1e-9, 'refined circle closes (x)');
assertClose(fineCircle[0].y, fineCircle[35].y, 1e-9, 'refined circle closes (y)');
assertTrue(fineCircle.every(p => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.w)),
  'refined circle has no NaNs');

// Rectangle → points sit on the drawn outline and the path closes
const rawSquare = tracePolygon(squareCorners, 80, 2);
const fineSquare = refineStroke(rawSquare, 'rectangle');
function distanceToOutline(p, corners) {
  let best = Infinity;
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i], b = corners[(i + 1) % corners.length];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
  }
  return best;
}
assertTrue(fineSquare.length > 4, 'refined rectangle is densely sampled');
assertTrue(fineSquare.every(p => distanceToOutline(p, squareCorners) < 6), 'refined rectangle hugs the outline');
assertClose(fineSquare[0].x, fineSquare[fineSquare.length - 1].x, 1e-9, 'refined rectangle closes (x)');
assertClose(fineSquare[0].y, fineSquare[fineSquare.length - 1].y, 1e-9, 'refined rectangle closes (y)');

// Triangle → same guarantees
const rawTriangle = tracePolygon(triCorners, 70, 2);
const fineTriangle = refineStroke(rawTriangle, 'triangle');
assertTrue(fineTriangle.every(p => distanceToOutline(p, triCorners) < 6), 'refined triangle hugs the outline');
assertClose(fineTriangle[0].x, fineTriangle[fineTriangle.length - 1].x, 1e-9, 'refined triangle closes (x)');

// Freehand → two Chaikin passes: 2x points per pass, endpoints pinned
const jagged = [];
for (let i = 0; i < 20; i++) jagged.push({ x: i * 10, y: (i % 2) * 6, w: 2 + (i % 3) });
const smoothed = refineStroke(jagged, 'freehand');
assertEqual(smoothed.length, jagged.length * 4, 'two Chaikin passes quadruple the point count');
assertEqual(smoothed[0], jagged[0], 'Chaikin pins the first point');
assertEqual(smoothed[smoothed.length - 1], jagged[jagged.length - 1], 'Chaikin pins the last point');
// Smoothing must not push the path outside the range it was drawn in
const jaggedYs = jagged.map(p => p.y);
assertTrue(
  smoothed.every(p => p.y >= Math.min(...jaggedYs) - 1e-9 && p.y <= Math.max(...jaggedYs) + 1e-9),
  'Chaikin stays inside the original bounds'
);
// Widths must survive refinement, interpolated but never invented
const wMin = Math.min(...jagged.map(p => p.w)), wMax = Math.max(...jagged.map(p => p.w));
assertTrue(smoothed.every(p => p.w >= wMin - 1e-9 && p.w <= wMax + 1e-9), 'Chaikin interpolates widths in range');
const taper = traceCircle(100, 100, 80, 60, 0).map((p, i) => ({ x: p.x, y: p.y, w: 1 + i * 0.1 }));
const taperMax = Math.max(...taper.map(p => p.w));
assertTrue(
  fineCircle.every(p => p.w > 0) &&
  refineStroke(taper, 'circle').every(p => p.w >= 1 - 1e-9 && p.w <= taperMax + 1e-9),
  'circle refinement carries widths through in range'
);

// Unknown / short input falls back safely and never mutates the caller's array
assertEqual(refineStroke([{ x: 1, y: 1, w: 1 }], 'circle'), [{ x: 1, y: 1, w: 1 }], 'single point passes through');
assertEqual(refineStroke([], 'freehand'), [], 'empty stroke passes through');
const original = jagged.map(p => ({ x: p.x, y: p.y, w: p.w }));
refineStroke(jagged, 'freehand');
refineStroke(jagged, 'circle');
assertEqual(jagged, original, 'refineStroke does not mutate its input');

// ── refinePrecision (Smart Stroke 2) ──────────────────────

// Trace a polyline with hand wobble, sampling roughly every 3px.
function tracePolyline(corners, noise, close = false) {
  const path = close ? corners.concat([corners[0]]) : corners;
  const out = [];
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i], b = path[i + 1];
    const steps = Math.max(2, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / 3));
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      out.push({ x: a.x + (b.x - a.x) * t + wobble(noise), y: a.y + (b.y - a.y) * t + wobble(noise), w: 3 });
    }
  }
  const end = path[path.length - 1];
  out.push({ x: end.x + wobble(noise), y: end.y + wobble(noise), w: 3 });
  return out;
}

function traceArc(cx, cy, r, from, to, noise) {
  const out = [];
  const steps = Math.max(8, Math.round(Math.abs(to - from) * r / 3));
  for (let i = 0; i <= steps; i++) {
    const a = from + (to - from) * (i / steps);
    out.push({ x: cx + (r + wobble(noise)) * Math.cos(a), y: cy + (r + wobble(noise)) * Math.sin(a), w: 3 });
  }
  return out;
}

// Largest gap between consecutive output points, as a crude continuity check:
// a refined stroke must never tear apart at a run boundary.
function largestGap(path) {
  let max = 0;
  for (let i = 1; i < path.length; i++) {
    max = Math.max(max, Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y));
  }
  return max;
}

// A stroke a few degrees off level comes out exactly level
const nearlyLevel = tracePolyline([{ x: 10, y: 40 }, { x: 210, y: 33 }], 1.2);
const leveled = refinePrecision(nearlyLevel);
assertClose(leveled[0].y, leveled[leveled.length - 1].y, 1e-9, 'near-horizontal line snaps exactly level');
assertTrue(leveled.every(p => Math.abs(p.y - leveled[0].y) < 1e-9), 'snapped line has no bow left');

// …and one a few degrees off vertical comes out exactly vertical
const nearlyUpright = tracePolyline([{ x: 40, y: 10 }, { x: 46, y: 190 }], 1.2);
const uprighted = refinePrecision(nearlyUpright);
assertTrue(uprighted.every(p => Math.abs(p.x - uprighted[0].x) < 1e-9), 'near-vertical line snaps exactly upright');

// A deliberate 71° diagonal keeps its angle — snapping must not grab it
const steep = tracePolyline([{ x: 20, y: 220 }, { x: 90, y: 16 }], 1.2);
const steeped = refinePrecision(steep);
const steepAngle = Math.atan2(
  steeped[steeped.length - 1].y - steeped[0].y,
  steeped[steeped.length - 1].x - steeped[0].x
) * 180 / Math.PI;
assertTrue(Math.abs(Math.abs(steepAngle) - 71) < 6, 'off-step diagonal keeps its own angle');
// but it is still perfectly straight
assertTrue(
  steeped.every(p => distanceToOutline(p, [steeped[0], steeped[steeped.length - 1]]) < 1e-6),
  'off-step diagonal is dead straight'
);

// Letter L: vertical stem, horizontal foot, sharp corner between them
const letterL = refinePrecision(tracePolyline([{ x: 20, y: 10 }, { x: 26, y: 190 }, { x: 150, y: 183 }], 1.4));
assertClose(letterL[0].x, letterL[Math.floor(letterL.length / 3)].x, 1e-9, 'L stem is exactly vertical');
const lFoot = letterL.slice(-Math.floor(letterL.length / 4));
assertClose(lFoot[0].y, lFoot[lFoot.length - 1].y, 1e-9, 'L foot is exactly horizontal');
assertTrue(largestGap(letterL) < 12, 'L stays connected across its corner');

// Letter O: a closed loop becomes a true circle that returns to its start
const letterO = refinePrecision(traceArc(120, 120, 90, 0, Math.PI * 2, 3));
const oCx = letterO.reduce((s, p) => s + p.x, 0) / letterO.length;
const oCy = letterO.reduce((s, p) => s + p.y, 0) / letterO.length;
const oRadii = letterO.map(p => Math.hypot(p.x - oCx, p.y - oCy));
assertTrue(Math.max(...oRadii) - Math.min(...oRadii) < 6, 'O comes out round');
assertTrue(Math.abs(oRadii.reduce((a, b) => a + b) / oRadii.length - 90) < 6, 'O keeps its drawn radius');
assertTrue(
  Math.hypot(letterO[0].x - letterO[letterO.length - 1].x, letterO[0].y - letterO[letterO.length - 1].y) < 1e-6,
  'O closes exactly'
);

// Letter C: an open arc stays open — closure must not be forced on it
const letterC = refinePrecision(traceArc(120, 120, 90, 0.6, Math.PI * 1.7, 3));
assertTrue(
  Math.hypot(letterC[0].x - letterC[letterC.length - 1].x, letterC[0].y - letterC[letterC.length - 1].y) > 40,
  'C keeps its opening'
);

// Letter S: neither one line nor one arc, so it splits and refits — the test
// is that it stays a connected, smooth, single path with its extent intact
const rawS = traceArc(80, 60, 40, Math.PI * 0.25, -Math.PI * 0.9, 2)
  .concat(traceArc(80, 138, 40, Math.PI * 1.1, Math.PI * 0.25 - Math.PI, 2));
const letterS = refinePrecision(rawS);
assertTrue(largestGap(letterS) < 15, 'S stays connected through its inflection');
const sBounds = { minY: Math.min(...letterS.map(p => p.y)), maxY: Math.max(...letterS.map(p => p.y)) };
const rawSBounds = { minY: Math.min(...rawS.map(p => p.y)), maxY: Math.max(...rawS.map(p => p.y)) };
assertTrue(Math.abs((sBounds.maxY - sBounds.minY) - (rawSBounds.maxY - rawSBounds.minY)) < 20, 'S keeps its height');

// A wobbly square: four right angles, closed, hugging what was drawn
const rawSquare2 = tracePolyline(
  [{ x: 20, y: 20 }, { x: 220, y: 26 }, { x: 214, y: 226 }, { x: 14, y: 220 }], 2.5, true);
const preciseSquare = refinePrecision(rawSquare2);
assertTrue(largestGap(preciseSquare) < 12, 'square stays connected around its corners');
assertTrue(
  Math.hypot(preciseSquare[0].x - preciseSquare[preciseSquare.length - 1].x,
             preciseSquare[0].y - preciseSquare[preciseSquare.length - 1].y) < 1e-6,
  'square closes exactly'
);
// Every edge should now be axis-aligned: each point shares an x or a y with a corner
const sqXs = [Math.min(...preciseSquare.map(p => p.x)), Math.max(...preciseSquare.map(p => p.x))];
const sqYs = [Math.min(...preciseSquare.map(p => p.y)), Math.max(...preciseSquare.map(p => p.y))];
assertTrue(
  preciseSquare.every(p =>
    Math.abs(p.x - sqXs[0]) < 1.5 || Math.abs(p.x - sqXs[1]) < 1.5 ||
    Math.abs(p.y - sqYs[0]) < 1.5 || Math.abs(p.y - sqYs[1]) < 1.5),
  'square edges snap to axis-aligned sides'
);

// A long shallow wave must not be flattened. Its bow stays well inside 8% of
// its own chord, so the chord test alone would call it straight — only the
// distance-travelled test tells a wave apart from a line.
const rawWave = [];
for (let i = 0; i < 52; i++) {
  rawWave.push({ x: 10 + i * 14, y: 165 + 28 * Math.sin(i / 4.5) + wobble(2.5), w: 3 });
}
const refinedWave = refinePrecision(rawWave);
const waveIn = Math.max(...rawWave.map(p => p.y)) - Math.min(...rawWave.map(p => p.y));
const waveOut = Math.max(...refinedWave.map(p => p.y)) - Math.min(...refinedWave.map(p => p.y));
assertTrue(waveOut > waveIn * 0.8, 'a shallow wave keeps its amplitude instead of flattening');
assertTrue(largestGap(refinedWave) < 25, 'refined wave stays connected');

// Widths survive the rebuild, interpolated within the drawn range
const taperedLine = tracePolyline([{ x: 10, y: 40 }, { x: 210, y: 34 }], 1.2)
  .map((p, i, arr) => ({ x: p.x, y: p.y, w: 1 + 4 * i / (arr.length - 1) }));
const taperedOut = refinePrecision(taperedLine);
assertTrue(taperedOut.every(p => p.w >= 1 - 1e-9 && p.w <= 5 + 1e-9), 'precision pass keeps widths in range');
assertTrue(taperedOut[0].w < taperedOut[taperedOut.length - 1].w, 'precision pass keeps the taper direction');

// Degenerate and tiny inputs fall through safely, without mutating the caller
assertEqual(refinePrecision([]), [], 'precision: empty stroke');
assertEqual(refinePrecision([{ x: 1, y: 1, w: 1 }]), [{ x: 1, y: 1, w: 1 }], 'precision: single point');
const stationary = [];
for (let i = 0; i < 20; i++) stationary.push({ x: 7, y: 7, w: 2 });
assertEqual(refinePrecision(stationary).length, 20, 'precision: zero-size stroke passes through');
const precisionInput = tracePolyline([{ x: 0, y: 0 }, { x: 100, y: 4 }], 1);
const precisionCopy = precisionInput.map(p => ({ x: p.x, y: p.y, w: p.w }));
refinePrecision(precisionInput);
assertEqual(precisionInput, precisionCopy, 'refinePrecision does not mutate its input');

// Every output point must be finite for each of the shapes above
for (const [label, path] of [['L', letterL], ['O', letterO], ['C', letterC], ['S', letterS], ['square', preciseSquare]]) {
  assertTrue(path.every(p => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.w)),
    `precision ${label} has no NaNs`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
