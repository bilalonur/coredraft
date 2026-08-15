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

  // Export for both browser (globals) and Node (unit tests).
  const api = {
    circleSegmentInterval,
    mergeIntervals,
    complementIntervals,
    sampleShapePoints
  };
  Object.keys(api).forEach((name) => { global[name] = api[name]; });
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
