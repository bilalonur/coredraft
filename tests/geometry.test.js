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
  sampleShapePoints
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
