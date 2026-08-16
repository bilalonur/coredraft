/* ============================================================
   coredraft — pure geometry helpers
   ------------------------------------------------------------
   Zero dependencies, no DOM access. Loaded as a classic script
   (globals) so the app keeps working when opened via file://,
   and mirrored to module.exports for Node-based unit tests.
   ============================================================ */

(function (global) {
  'use strict';

  // Compute the interval [t1, t2] ⊆ [0,1] along segment AB that falls
  // inside the eraser circle (center ex,ey, radius er).
  // Returns null when the segment does not overlap the circle.
  function circleSegmentInterval(ax, ay, bx, by, ex, ey, er) {
    const dx = bx - ax, dy = by - ay;
    const fx = ax - ex, fy = ay - ey;
    const a = dx * dx + dy * dy;
    const b = 2 * (fx * dx + fy * dy);
    const c = fx * fx + fy * fy - er * er;

    if (a === 0) return c <= 0 ? [0, 1] : null;       // degenerate (point) segment
    const disc = b * b - 4 * a * c;
    if (disc < 0) return c < 0 ? [0, 1] : null;        // line misses circle entirely

    const sq = Math.sqrt(disc);
    const lo = Math.max(0, (-b - sq) / (2 * a));
    const hi = Math.min(1, (-b + sq) / (2 * a));
    return lo <= hi ? [lo, hi] : null;
  }

  // Merge overlapping / adjacent [lo, hi] intervals into a sorted list.
  function mergeIntervals(intervals) {
    if (intervals.length === 0) return [];
    intervals.sort((a, b) => a[0] - b[0]);
    const merged = [[intervals[0][0], intervals[0][1]]];
    for (let i = 1; i < intervals.length; i++) {
      const last = merged[merged.length - 1];
      if (intervals[i][0] <= last[1]) {
        last[1] = Math.max(last[1], intervals[i][1]);
      } else {
        merged.push([intervals[i][0], intervals[i][1]]);
      }
    }
    return merged;
  }

  // Return the gaps (surviving regions) between merged intervals, within [lo, hi].
  function complementIntervals(merged, lo, hi) {
    const result = [];
    let cursor = lo;
    for (const [m0, m1] of merged) {
      if (cursor < m0) result.push([cursor, m0]);
      cursor = Math.max(cursor, m1);
    }
    if (cursor < hi) result.push([cursor, hi]);
    return result;
  }

  // Sample points along a shape defined by two corners (for rect/circle/line/arrow).
  // Returns an array of {x, y} points on the shape's outline.
  function sampleShapePoints(obj) {
    const pts = [];
    const steps = 48;
    if (obj.type === 'line' || obj.type === 'arrow') {
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        pts.push({ x: obj.x1 + (obj.x2 - obj.x1) * t, y: obj.y1 + (obj.y2 - obj.y1) * t });
      }
    } else if (obj.type === 'rect') {
      const x1 = Math.min(obj.x1, obj.x2), x2 = Math.max(obj.x1, obj.x2);
      const y1 = Math.min(obj.y1, obj.y2), y2 = Math.max(obj.y1, obj.y2);
      const w = x2 - x1, h = y2 - y1;
      const per = Math.max(1, Math.floor(steps / 4));
      for (let i = 0; i < per; i++) pts.push({ x: x1 + w * i / per, y: y1 });
      for (let i = 0; i < per; i++) pts.push({ x: x2, y: y1 + h * i / per });
      for (let i = 0; i < per; i++) pts.push({ x: x2 - w * i / per, y: y2 });
      for (let i = 0; i < per; i++) pts.push({ x: x1, y: y2 - h * i / per });
    } else if (obj.type === 'circle') {
      const cx = (obj.x1 + obj.x2) / 2, cy = (obj.y1 + obj.y2) / 2;
      const rx = Math.abs(obj.x2 - obj.x1) / 2, ry = Math.abs(obj.y2 - obj.y1) / 2;
      for (let i = 0; i <= steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        pts.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) });
      }
    }
    return pts;
  }

  // ── Smart stroke refinement ─────────────────────────────
  // Classifies a finished freehand stroke as a circle / rectangle /
  // triangle / freehand and rewrites its point list into a cleaner path.
  // Everything stays a plain {x, y, w} point array committed as a normal
  // 'stroke' object, so the eraser, renderer and undo stack are unaffected.

  // RDP tolerance, as a fraction of the stroke's bounding-box diagonal.
  // Scale-relative so a small doodle and a large sweep classify the same.
  const SIMPLIFY_RATIO = 0.04;
  // A stroke whose endpoints sit further apart than this fraction of the
  // diagonal is treated as open, and open strokes are never a shape.
  const CLOSURE_RATIO = 0.15;
  // Vertices whose interior angle is at least this (degrees) count as
  // "straight through" rather than a corner. The point where the user
  // started drawing usually lands mid-edge and shows up as such a vertex.
  const STRAIGHT_ANGLE = 150;
  const RECT_ANGLE_MIN = 75, RECT_ANGLE_MAX = 105;
  const CIRCLE_ASPECT_MIN = 0.8, CIRCLE_ASPECT_MAX = 1.2;
  // Radial spread (std-dev / mean) below which the ring reads as a circle.
  const CIRCLE_VARIANCE_MAX = 0.18;
  const CIRCLE_POINTS = 36;
  // Upper bound on the samples emitted for one polygon edge, so a dense
  // scribble that classifies as a shape can't explode the point count.
  const MAX_SEGMENT_SAMPLES = 200;

  function pointDistance(a, b) {
    return Math.hypot(b.x - a.x, b.y - a.y);
  }

  function pointWidth(p) {
    return typeof p.w === 'number' ? p.w : 1;
  }

  // Axis-aligned bounds plus the derived values the heuristics need.
  function strokeBounds(points) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const width = maxX - minX, height = maxY - minY;
    return {
      minX, minY, maxX, maxY, width, height,
      cx: minX + width / 2,
      cy: minY + height / 2,
      diagonal: Math.hypot(width, height)
    };
  }

  // Distance from p to segment AB. Clamped to the segment (rather than the
  // infinite line) so a near-closed path, whose RDP anchors nearly coincide,
  // still degrades gracefully into a point distance.
  function segmentDistance(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  // Interior angle at vertex v between neighbours a and b, in degrees.
  // Degenerate (zero-length) neighbours read as perfectly straight.
  function interiorAngle(a, v, b) {
    const ax = a.x - v.x, ay = a.y - v.y;
    const bx = b.x - v.x, by = b.y - v.y;
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la === 0 || lb === 0) return 180;
    const cos = Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)));
    return Math.acos(cos) * 180 / Math.PI;
  }

  // Ramer-Douglas-Peucker: drop every point that sits within `tolerance` of
  // the line through the points that survive around it. Iterative (explicit
  // stack) so a long stroke can't blow the call stack. Returns the surviving
  // *indices*, which the precision pass needs to slice the original runs.
  function simplifyIndices(points, tolerance) {
    if (points.length <= 2) return points.map((p, i) => i);

    const keep = new Array(points.length).fill(false);
    keep[0] = true;
    keep[points.length - 1] = true;

    const stack = [[0, points.length - 1]];
    while (stack.length > 0) {
      const [first, last] = stack.pop();
      let maxDist = -1, farthest = -1;
      for (let i = first + 1; i < last; i++) {
        const d = segmentDistance(points[i], points[first], points[last]);
        if (d > maxDist) { maxDist = d; farthest = i; }
      }
      if (farthest !== -1 && maxDist > tolerance) {
        keep[farthest] = true;
        stack.push([first, farthest], [farthest, last]);
      }
    }

    const indices = [];
    for (let i = 0; i < points.length; i++) if (keep[i]) indices.push(i);
    return indices;
  }

  function simplifyPath(points, tolerance) {
    if (!Array.isArray(points) || points.length <= 2) {
      return Array.isArray(points) ? points.slice() : [];
    }
    return simplifyIndices(points, tolerance).map((i) => points[i]);
  }

  // Running arc length at every point, so runs can be measured in distance
  // rather than in sample counts (which vary with how fast the pen moved).
  function cumulativeLengths(points) {
    const cum = new Array(points.length);
    cum[0] = 0;
    for (let i = 1; i < points.length; i++) {
      cum[i] = cum[i - 1] + pointDistance(points[i - 1], points[i]);
    }
    return cum;
  }

  // Reduce a closed stroke to its true corners: simplify, drop the closing
  // duplicate, then discard vertices that pass straight through.
  function cornerRing(points, bounds) {
    const b = bounds || strokeBounds(points);
    if (b.diagonal === 0) return [];

    const ring = simplifyPath(points, b.diagonal * SIMPLIFY_RATIO);
    if (ring.length > 2 &&
        pointDistance(ring[0], ring[ring.length - 1]) <= b.diagonal * CLOSURE_RATIO) {
      ring.pop();
    }
    if (ring.length < 3) return ring;

    const corners = [];
    for (let i = 0; i < ring.length; i++) {
      const prev = ring[(i - 1 + ring.length) % ring.length];
      const next = ring[(i + 1) % ring.length];
      if (interiorAngle(prev, ring[i], next) < STRAIGHT_ANGLE) corners.push(ring[i]);
    }
    return corners;
  }

  // Spread of the points' distance from the bounding-box centre, normalised
  // by the mean radius so the measure is scale-free. ~0 for a true circle.
  function radialVariance(points, bounds) {
    let sum = 0;
    for (const p of points) sum += Math.hypot(p.x - bounds.cx, p.y - bounds.cy);
    const mean = sum / points.length;
    if (mean === 0) return Infinity;
    let acc = 0;
    for (const p of points) {
      const d = Math.hypot(p.x - bounds.cx, p.y - bounds.cy) - mean;
      acc += d * d;
    }
    return Math.sqrt(acc / points.length) / mean;
  }

  // Decide what the user meant to draw: 'circle' | 'rectangle' | 'triangle' | 'freehand'.
  function classifyStroke(points) {
    if (!Array.isArray(points) || points.length < 8) return 'freehand';

    const bounds = strokeBounds(points);
    if (bounds.diagonal === 0) return 'freehand';

    // Shapes are closed: the pen has to come back to where it started.
    const gap = pointDistance(points[0], points[points.length - 1]);
    if (gap > bounds.diagonal * CLOSURE_RATIO) return 'freehand';

    const corners = cornerRing(points, bounds);

    if (corners.length === 3) return 'triangle';

    if (corners.length === 4) {
      let square = true;
      for (let i = 0; i < 4; i++) {
        const angle = interiorAngle(corners[(i + 3) % 4], corners[i], corners[(i + 1) % 4]);
        if (angle < RECT_ANGLE_MIN || angle > RECT_ANGLE_MAX) { square = false; break; }
      }
      if (square) return 'rectangle';
    }

    if (corners.length > 5 && bounds.height > 0) {
      const aspect = bounds.width / bounds.height;
      if (aspect >= CIRCLE_ASPECT_MIN && aspect <= CIRCLE_ASPECT_MAX &&
          radialVariance(points, bounds) <= CIRCLE_VARIANCE_MAX) {
        return 'circle';
      }
    }

    return 'freehand';
  }

  // Build a sampler that maps a fraction of the original stroke's arc length
  // back to the width recorded there, so the velocity-driven taper survives
  // being redrawn onto brand new coordinates.
  function makeWidthSampler(points) {
    const cum = cumulativeLengths(points);
    const total = cum[points.length - 1];

    return function widthAt(t) {
      if (!(total > 0)) return pointWidth(points[0]);
      const target = Math.max(0, Math.min(1, t)) * total;
      let lo = 0, hi = points.length - 1;
      while (lo < hi - 1) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] <= target) lo = mid; else hi = mid;
      }
      const span = cum[hi] - cum[lo];
      const f = span > 0 ? (target - cum[lo]) / span : 0;
      return pointWidth(points[lo]) + (pointWidth(points[hi]) - pointWidth(points[lo])) * f;
    };
  }

  // Replace the ring with a perfect circle through its centroid, kept at the
  // drawn start angle and sweep direction so the seam lands where the pen lifted.
  function refineCircle(points) {
    let sx = 0, sy = 0;
    for (const p of points) { sx += p.x; sy += p.y; }
    const cx = sx / points.length, cy = sy / points.length;

    let radius = 0;
    for (const p of points) radius += Math.hypot(p.x - cx, p.y - cy);
    radius /= points.length;

    // Shoelace sign tells us whether the stroke ran clockwise or not.
    let cross = 0;
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      cross += (a.x - cx) * (b.y - cy) - (b.x - cx) * (a.y - cy);
    }
    const direction = cross < 0 ? -1 : 1;
    const startAngle = Math.atan2(points[0].y - cy, points[0].x - cx);

    const widthAt = makeWidthSampler(points);
    const out = [];
    const steps = CIRCLE_POINTS - 1; // last sample lands back on the first
    for (let i = 0; i < CIRCLE_POINTS; i++) {
      const t = i / steps;
      const angle = startAngle + direction * t * Math.PI * 2;
      out.push({
        x: cx + radius * Math.cos(angle),
        y: cy + radius * Math.sin(angle),
        w: widthAt(t)
      });
    }
    return out;
  }

  // Walk the detected corners with dead-straight edges, sampling at roughly
  // the density of the original stroke so widths still vary along the path.
  function refinePolygon(points, corners) {
    let originalLength = 0;
    for (let i = 1; i < points.length; i++) originalLength += pointDistance(points[i - 1], points[i]);
    const density = originalLength > 0 ? (points.length - 1) / originalLength : 0;

    // Closed edge list: corner[0]→corner[1]→…→corner[n-1]→corner[0].
    const edges = [];
    let perimeter = 0;
    for (let i = 0; i < corners.length; i++) {
      const a = corners[i], b = corners[(i + 1) % corners.length];
      const len = pointDistance(a, b);
      edges.push({ a, b, len });
      perimeter += len;
    }
    if (perimeter === 0) return points.slice();

    const widthAt = makeWidthSampler(points);
    const out = [];
    let travelled = 0;
    for (const edge of edges) {
      const steps = Math.max(1, Math.min(MAX_SEGMENT_SAMPLES, Math.round(edge.len * density)));
      for (let k = 0; k < steps; k++) {
        const f = k / steps;
        out.push({
          x: edge.a.x + (edge.b.x - edge.a.x) * f,
          y: edge.a.y + (edge.b.y - edge.a.y) * f,
          w: widthAt((travelled + edge.len * f) / perimeter)
        });
      }
      travelled += edge.len;
    }
    // Close the outline back onto the first corner.
    out.push({ x: corners[0].x, y: corners[0].y, w: widthAt(1) });
    return out;
  }

  // Chaikin's corner cutting: replace every segment with its 1/4 and 3/4
  // points, keeping the endpoints pinned. Shaves mouse jitter without
  // pulling the path away from what was drawn.
  function chaikinSmooth(points, iterations) {
    let current = points.slice();
    for (let it = 0; it < iterations; it++) {
      if (current.length < 3) break;
      const next = [current[0]];
      for (let i = 0; i < current.length - 1; i++) {
        const a = current[i], b = current[i + 1];
        next.push({
          x: a.x * 0.75 + b.x * 0.25,
          y: a.y * 0.75 + b.y * 0.25,
          w: pointWidth(a) * 0.75 + pointWidth(b) * 0.25
        });
        next.push({
          x: a.x * 0.25 + b.x * 0.75,
          y: a.y * 0.25 + b.y * 0.75,
          w: pointWidth(a) * 0.25 + pointWidth(b) * 0.75
        });
      }
      next.push(current[current.length - 1]);
      current = next;
    }
    return current;
  }

  // Rewrite a stroke's points for the given classification. Always returns a
  // fresh {x, y, w} array — never mutates the input.
  function refineStroke(points, shapeType) {
    if (!Array.isArray(points) || points.length < 3) {
      return Array.isArray(points) ? points.slice() : [];
    }
    if (shapeType === 'circle') return refineCircle(points);
    if (shapeType === 'rectangle' || shapeType === 'triangle') {
      const corners = cornerRing(points);
      // Corner detection disagreeing with the classifier is not fatal —
      // fall back to smoothing rather than dropping the stroke.
      if (corners.length >= 3) return refinePolygon(points, corners);
      return chaikinSmooth(points, 2);
    }
    return chaikinSmooth(points, 2);
  }

  // ── Precision refinement (Smart Stroke 2) ───────────────
  // Where the pass above forces a whole stroke into one ideal primitive,
  // this one keeps the structure that was actually drawn — open or closed,
  // one segment or twelve — and makes each piece exact. Straight runs become
  // dead-straight lines (pulled onto a 45° step when they are already close),
  // curved runs become fitted circular arcs. That is what letterforms need:
  // hardly any letter is a single closed primitive, but nearly every one is
  // a short chain of lines and arcs meeting at corners.

  const PRECISION_SIMPLIFY_RATIO = 0.025; // tighter than the shape pass — letter details are small
  const PRECISION_CLOSURE_RATIO = 0.10;   // endpoints this close are pulled together exactly
  const STRAIGHT_DEVIATION_RATIO = 0.08;  // bow, relative to a run's own chord, still read as straight
  const STRAIGHT_LENGTH_RATIO = 1.03;     // a run that wanders is longer than its chord, however shallow
  const ANGLE_SNAP_STEP = 45;             // degrees
  const ANGLE_SNAP_TOLERANCE = 7;         // only nudge a line already this close to a step
  const ARC_FIT_TOLERANCE = 0.12;         // max residual, as a fraction of the fitted radius
  const CORNER_TURN = 40;                 // degrees of direction change that make a vertex a corner
  const TURN_WINDOW_RATIO = 0.08;         // arc length each side of a vertex used to measure that turn
  const CORNER_SPACING_RATIO = 0.06;      // corners closer than this along the stroke collapse into one
  const SNAP_MIN_LENGTH_RATIO = 0.08;     // runs shorter than this are too small to be worth snapping
  const DENOISE_HALF_WINDOW = 2;          // samples each side averaged before the stroke is analysed
  const MAX_SPLIT_DEPTH = 3;

  // Light moving average, used only to analyse the stroke. It keeps index
  // correspondence with the original so widths still line up, while stopping
  // single-sample tremor from registering as an anchor or a corner — without
  // it, a shaky circle shatters into a dozen tiny runs that then drift apart.
  function denoise(points, halfWindow) {
    if (points.length < 3 || halfWindow < 1) return points.slice();
    const out = new Array(points.length);
    for (let i = 0; i < points.length; i++) {
      const lo = Math.max(0, i - halfWindow);
      const hi = Math.min(points.length - 1, i + halfWindow);
      let sx = 0, sy = 0;
      for (let j = lo; j <= hi; j++) { sx += points[j].x; sy += points[j].y; }
      const n = hi - lo + 1;
      out[i] = { x: sx / n, y: sy / n, w: points[i].w };
    }
    // Pin the ends: averaging pulls them inward, and the endpoints are the
    // one place the user's intent is unambiguous.
    out[0] = { x: points[0].x, y: points[0].y, w: points[0].w };
    const last = points.length - 1;
    out[last] = { x: points[last].x, y: points[last].y, w: points[last].w };
    return out;
  }

  // Largest deviation of a run from the straight chord joining its ends.
  function runDeviation(points, i0, i1) {
    let max = 0;
    for (let i = i0 + 1; i < i1; i++) {
      const d = segmentDistance(points[i], points[i0], points[i1]);
      if (d > max) max = d;
    }
    return max;
  }

  function maxDeviationIndex(points, i0, i1) {
    let max = -1, index = -1;
    for (let i = i0 + 1; i < i1; i++) {
      const d = segmentDistance(points[i], points[i0], points[i1]);
      if (d > max) { max = d; index = i; }
    }
    return index;
  }

  // Corners are where direction changes sharply over a *fixed arc length*.
  // Measuring the turn over a distance window rather than between adjacent
  // samples is what separates a real corner from a smooth curve: a circle
  // turns gently over any window, a box corner turns 90° over even a short one.
  function cornerBreakpoints(points, bounds, anchors) {
    const cum = cumulativeLengths(points);
    const window = bounds.diagonal * TURN_WINDOW_RATIO;
    const spacing = bounds.diagonal * CORNER_SPACING_RATIO;
    const breaks = [0];

    for (let a = 1; a < anchors.length - 1; a++) {
      const i = anchors[a];
      let j = i, k = i;
      while (j > 0 && cum[i] - cum[j] < window) j--;
      while (k < points.length - 1 && cum[k] - cum[i] < window) k++;
      if (j === i || k === i) continue;
      if (180 - interiorAngle(points[j], points[i], points[k]) < CORNER_TURN) continue;
      // Two corners a hair apart are one corner plus a wobble.
      if (cum[i] - cum[breaks[breaks.length - 1]] < spacing) continue;
      breaks.push(i);
    }

    // Drop a final corner that sits right on top of the stroke's end.
    const end = points.length - 1;
    if (breaks.length > 1 && cum[end] - cum[breaks[breaks.length - 1]] < spacing) breaks.pop();
    breaks.push(end);
    return breaks;
  }

  // Least-squares circle through points[i0..i1] (Kåsa's method). The samples
  // are centred on their own mean first, which keeps the normal equations
  // well conditioned no matter how far the stroke sits from the origin.
  function fitCircle(points, i0, i1) {
    const n = i1 - i0 + 1;
    if (n < 3) return null;

    let mx = 0, my = 0;
    for (let i = i0; i <= i1; i++) { mx += points[i].x; my += points[i].y; }
    mx /= n; my /= n;

    let sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0, sz = 0;
    for (let i = i0; i <= i1; i++) {
      const x = points[i].x - mx, y = points[i].y - my, z = x * x + y * y;
      sxx += x * x; syy += y * y; sxy += x * y;
      sxz += x * z; syz += y * z; sz += z;
    }

    // Centred data makes the linear terms vanish, leaving a 2x2 solve for the
    // centre of x² + y² + Dx + Ey + F = 0, with F fixed by the mean radius.
    const det = sxx * syy - sxy * sxy;
    if (Math.abs(det) < 1e-9) return null;
    const d = (-sxz * syy + syz * sxy) / det;
    const e = (-syz * sxx + sxz * sxy) / det;
    const cx = -d / 2, cy = -e / 2;
    const r2 = cx * cx + cy * cy + sz / n;
    if (!(r2 > 0)) return null;

    return { cx: cx + mx, cy: cy + my, r: Math.sqrt(r2) };
  }

  function circleResidual(points, i0, i1, circle) {
    let max = 0;
    for (let i = i0; i <= i1; i++) {
      const d = Math.abs(Math.hypot(points[i].x - circle.cx, points[i].y - circle.cy) - circle.r);
      if (d > max) max = d;
    }
    return max;
  }

  // Distance travelled measured along the run's *simplified* polyline. Raw
  // sample-to-sample distance would count every tremor as travel — on a short
  // stroke that inflates the total by 20% — while the simplified path keeps
  // genuine waviness and ignores the jitter.
  function simplifiedLength(points, anchorIndices, i0, i1) {
    let length = 0, prev = i0;
    for (const index of anchorIndices) {
      if (index <= i0 || index >= i1) continue;
      length += pointDistance(points[prev], points[index]);
      prev = index;
    }
    return length + pointDistance(points[prev], points[i1]);
  }

  // A run counts as straight only if it barely bows *and* barely wanders.
  // The bow test alone is not enough: a long shallow wave stays well inside
  // 8% of its own chord, yet flattening it would erase the drawing. Comparing
  // distance travelled against the chord is what tells the two apart.
  function isStraightRun(points, i0, i1, anchorIndices) {
    if (i1 - i0 < 2) return true;
    const chord = pointDistance(points[i0], points[i1]);
    if (chord === 0) return false;

    if (runDeviation(points, i0, i1) > chord * STRAIGHT_DEVIATION_RATIO) return false;
    return simplifiedLength(points, anchorIndices, i0, i1) <= chord * STRAIGHT_LENGTH_RATIO;
  }

  // Decide how to redraw points[i0..i1]: one straight line, one arc, or —
  // when neither fits, as in an S-curve — split at the worst-fitting point
  // and try again on each half before falling back to plain smoothing.
  function planRuns(points, i0, i1, bounds, anchorIndices, depth, out) {
    if (isStraightRun(points, i0, i1, anchorIndices)) {
      out.push({ i0, i1, kind: 'line' });
      return;
    }

    const circle = fitCircle(points, i0, i1);
    if (circle && circle.r <= bounds.diagonal * 50 &&
        circleResidual(points, i0, i1, circle) <= circle.r * ARC_FIT_TOLERANCE) {
      out.push({ i0, i1, kind: 'arc', circle, span: arcSpan(points, i0, i1, circle) });
      return;
    }

    if (depth < MAX_SPLIT_DEPTH && i1 - i0 >= 6) {
      const mid = maxDeviationIndex(points, i0, i1);
      if (mid > i0 && mid < i1) {
        planRuns(points, i0, mid, bounds, anchorIndices, depth + 1, out);
        planRuns(points, mid, i1, bounds, anchorIndices, depth + 1, out);
        return;
      }
    }

    out.push({ i0, i1, kind: 'smooth' });
  }

  // Principal axis of a run (total-least-squares), oriented along the way the
  // pen travelled. Every sample votes on the direction, so a shaky endpoint
  // can no longer tilt a whole line the way an endpoint-to-endpoint chord does.
  function fitDirection(points, i0, i1, travelX, travelY) {
    const n = i1 - i0 + 1;
    let mx = 0, my = 0;
    for (let i = i0; i <= i1; i++) { mx += points[i].x; my += points[i].y; }
    mx /= n; my /= n;

    let sxx = 0, sxy = 0, syy = 0;
    for (let i = i0; i <= i1; i++) {
      const dx = points[i].x - mx, dy = points[i].y - my;
      sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
    }
    if (sxx + syy === 0) return null;

    const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    let ux = Math.cos(angle), uy = Math.sin(angle);
    // The principal axis has no inherent sign; point it the way we are going.
    if (ux * travelX + uy * travelY < 0) { ux = -ux; uy = -uy; }
    return { x: ux, y: uy };
  }

  // Walk the run endpoints as a connected chain: straight runs are rebuilt
  // along their fitted direction, snapped onto a 45° step when already close.
  // Chaining (rather than rotating each run about its own midpoint) is what
  // keeps the path joined up afterwards.
  function snapAnchors(points, runs, closed, minSnapLength) {
    const anchors = [runStart(points, runs[0])];

    for (const run of runs) {
      const a = runStart(points, run), b = runEnd(points, run);
      let dx = b.x - a.x, dy = b.y - a.y;

      if (run.kind === 'line') {
        const direction = fitDirection(points, run.i0, run.i1, dx, dy);
        if (direction) {
          // Keep the distance travelled, but along the fitted axis.
          const length = dx * direction.x + dy * direction.y;
          let rad = Math.atan2(direction.y, direction.x);

          if (length >= minSnapLength) {
            const degrees = rad * 180 / Math.PI;
            const snapped = Math.round(degrees / ANGLE_SNAP_STEP) * ANGLE_SNAP_STEP;
            if (Math.abs(degrees - snapped) <= ANGLE_SNAP_TOLERANCE) rad = snapped * Math.PI / 180;
          }
          dx = Math.cos(rad) * length;
          dy = Math.sin(rad) * length;
        }
      }

      const prev = anchors[anchors.length - 1];
      anchors.push({ x: prev.x + dx, y: prev.y + dy });
    }

    // Close the traverse: spread whatever drift snapping introduced evenly
    // over the chain so a closed stroke ends exactly where it started.
    if (closed && anchors.length > 2) {
      const last = anchors[anchors.length - 1];
      const ex = last.x - anchors[0].x, ey = last.y - anchors[0].y;
      const n = anchors.length - 1;
      for (let i = 1; i <= n; i++) {
        anchors[i].x -= ex * i / n;
        anchors[i].y -= ey * i / n;
      }
    }
    return anchors;
  }

  // Total angle the pen actually travelled around the fitted centre, summed
  // step by step so a three-quarter arc stays three quarters and a full loop
  // stays a full loop instead of collapsing into the shorter way round.
  function arcSpan(points, i0, i1, circle) {
    const startAngle = Math.atan2(points[i0].y - circle.cy, points[i0].x - circle.cx);
    let sweep = 0, prev = startAngle;
    for (let i = i0 + 1; i <= i1; i++) {
      const a = Math.atan2(points[i].y - circle.cy, points[i].x - circle.cx);
      let step = a - prev;
      while (step > Math.PI) step -= Math.PI * 2;
      while (step < -Math.PI) step += Math.PI * 2;
      sweep += step;
      prev = a;
    }
    return { startAngle, sweep };
  }

  function arcPointAt(circle, span, t) {
    const a = span.startAngle + span.sweep * t;
    return { x: circle.cx + circle.r * Math.cos(a), y: circle.cy + circle.r * Math.sin(a) };
  }

  function sampleArc(circle, span, steps) {
    const out = [];
    for (let s = 0; s <= steps; s++) out.push(arcPointAt(circle, span, s / steps));
    return out;
  }

  // Where a run ideally starts and ends. For arcs that is the fitted circle,
  // not the raw samples — anchoring the chain to noisy endpoints would drag
  // the whole arc off its own radius.
  function runStart(points, run) {
    if (run.kind === 'arc') return arcPointAt(run.circle, run.span, 0);
    const p = points[run.i0];
    return { x: p.x, y: p.y };
  }

  function runEnd(points, run) {
    if (run.kind === 'arc') return arcPointAt(run.circle, run.span, 1);
    const p = points[run.i1];
    return { x: p.x, y: p.y };
  }

  // Shift a generated run so its ends land exactly on the snapped anchors,
  // blending the two corrections along it so the interior follows smoothly.
  function alignRun(run, startTarget, endTarget) {
    if (run.length === 0) return run;
    const dx0 = startTarget.x - run[0].x, dy0 = startTarget.y - run[0].y;
    const last = run[run.length - 1];
    const dx1 = endTarget.x - last.x, dy1 = endTarget.y - last.y;
    const n = run.length - 1;

    return run.map((p, i) => {
      const t = n > 0 ? i / n : 0;
      return { x: p.x + dx0 + (dx1 - dx0) * t, y: p.y + dy0 + (dy1 - dy0) * t };
    });
  }

  function runGeometry(points, run, density) {
    const a = points[run.i0], b = points[run.i1];

    if (run.kind === 'line') {
      const len = pointDistance(a, b);
      const steps = Math.max(1, Math.min(MAX_SEGMENT_SAMPLES, Math.round(len * density)));
      const out = [];
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      }
      return out;
    }

    if (run.kind === 'arc') {
      const arcLength = Math.abs(run.span.sweep) * run.circle.r;
      const steps = Math.max(2, Math.min(MAX_SEGMENT_SAMPLES, Math.round(arcLength * density)));
      return sampleArc(run.circle, run.span, steps);
    }

    return chaikinSmooth(points.slice(run.i0, run.i1 + 1), 2)
      .map((p) => ({ x: p.x, y: p.y }));
  }

  // Re-attach the velocity-driven widths, sampled by how far along the
  // refined path each new point sits.
  function applyWidths(path, source) {
    const widthAt = makeWidthSampler(source);
    const cum = cumulativeLengths(path);
    const total = cum[path.length - 1];
    return path.map((p, i) => ({ x: p.x, y: p.y, w: widthAt(total > 0 ? cum[i] / total : 0) }));
  }

  // Rewrite a stroke as exact lines and arcs, preserving its corners.
  // Always returns a fresh {x, y, w} array — never mutates the input.
  function refinePrecision(points) {
    if (!Array.isArray(points) || points.length < 4) {
      return Array.isArray(points) ? points.slice() : [];
    }
    const bounds = strokeBounds(points);
    if (bounds.diagonal === 0) return points.slice();

    // Everything below reads the denoised copy; only the widths come from the
    // raw stroke. Indices line up between the two.
    const shape = denoise(points, DENOISE_HALF_WINDOW);

    const anchorIndices = simplifyIndices(shape, bounds.diagonal * PRECISION_SIMPLIFY_RATIO);
    const breaks = cornerBreakpoints(shape, bounds, anchorIndices);
    const runs = [];
    for (let b = 0; b < breaks.length - 1; b++) {
      planRuns(shape, breaks[b], breaks[b + 1], bounds, anchorIndices, 0, runs);
    }
    if (runs.length === 0) return points.slice();

    const closed = pointDistance(shape[0], shape[shape.length - 1]) <=
                   bounds.diagonal * PRECISION_CLOSURE_RATIO;

    // A closed loop drawn as a single arc — an O, or a circle — should come
    // back to its exact start, so round a nearly-complete sweep up to a full turn.
    if (closed && runs.length === 1 && runs[0].kind === 'arc') {
      const span = runs[0].span;
      const turns = Math.round(span.sweep / (Math.PI * 2));
      if (turns !== 0 && Math.abs(span.sweep - turns * Math.PI * 2) <= 0.35) {
        span.sweep = turns * Math.PI * 2;
      }
    }

    const anchors = snapAnchors(shape, runs, closed, bounds.diagonal * SNAP_MIN_LENGTH_RATIO);

    const total = cumulativeLengths(points)[points.length - 1];
    const density = total > 0 ? (points.length - 1) / total : 0;

    const path = [];
    for (let k = 0; k < runs.length; k++) {
      const geometry = alignRun(runGeometry(shape, runs[k], density), anchors[k], anchors[k + 1]);
      // Skip each run's first point: it repeats the previous run's last one.
      for (let i = (k === 0 ? 0 : 1); i < geometry.length; i++) path.push(geometry[i]);
    }
    if (path.length < 2) return points.slice();

    return applyWidths(path, points);
  }

  // Export for both browser (globals) and Node (unit tests).
  const api = {
    circleSegmentInterval,
    mergeIntervals,
    complementIntervals,
    sampleShapePoints,
    simplifyPath,
    classifyStroke,
    refineStroke,
    refinePrecision
  };
  Object.keys(api).forEach((name) => { global[name] = api[name]; });
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
