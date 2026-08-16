/* ============================================================
   coredraft — application logic
   ============================================================ */

const devicePixelRatio = window.devicePixelRatio || 1;
const PALETTE_COLORS = ['#e8e0c8', '#c8a96e', '#e87c5a', '#5ab0e8', '#7de87a', '#c87de8', '#e8e85a', '#e85a8b', '#5ae8d4', '#444444'];
// Sticky-note pads. Muted pastels rather than the saturated drawing palette:
// they carry a paragraph of text without fighting the strokes around them.
const STICKY_COLORS = ['#f5df8f', '#f7c3cd', '#c3e8b6', '#bcdcf7', '#dfcdf7', '#f7cfae', '#efece1', '#cdd3d9'];
const FALLBACK_WORDS = ['banaz', 'porsuk', 'aksu', 'anamur', 'biga', 'kali', 'maden', 'melen', 'meydan', 'munzur', 'sabun', 'sarisu', 'sariz', 'terme'];

const canvasWrap = document.getElementById('canvas-wrap');
const canvas = document.getElementById('canvas');
const canvasContext = canvas.getContext('2d');
const textInput = document.getElementById('text-input');
const statusBar = document.getElementById('status-bar');

let isDark = true;
let panX = 0, panY = 0, viewScale = 1;

// ── Canvas sizing ─────────────────────────────────────────
function resizeCanvas() {
  const width = canvasWrap.offsetWidth;
  const height = canvasWrap.offsetHeight;
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';
  canvas.width = width * devicePixelRatio;
  canvas.height = height * devicePixelRatio;
  canvasContext.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
}

function initCanvasView() {
  resizeCanvas();
  viewScale = 1;
  panX = canvasWrap.offsetWidth / 2;
  panY = canvasWrap.offsetHeight / 2;
  fullRedraw();
}

window.addEventListener('resize', () => {
  resizeCanvas();
  fullRedraw();
});

function toWorld(screenX, screenY) {
  return { x: (screenX - panX) / viewScale, y: (screenY - panY) / viewScale };
}

// ════════════════════════════════════════════════════════
// HISTORY + UNDO / REDO
// ════════════════════════════════════════════════════════
let history = [];   // committed objects

// Undo stack holds action descriptors. Each action knows how to undo/redo itself:
//   { type: 'add', obj }              — undo: remove obj, redo: re-add obj
//   { type: 'remove', obj }           — undo: re-add obj, redo: remove obj
//   { type: 'move', obj, from, to }   — undo: restore obj position to 'from', redo: to 'to'
//   { type: 'editText', obj, from, to }   — undo/redo: swap the text snapshot
//   { type: 'editSticky', obj, from, to } — undo/redo: swap the sticky-note snapshot
//   { type: 'erase', entries }        — undo: reverse each entry, redo: re-apply
let undoStack = [];
let redoStack = [];

// Push a new object onto history and record an 'add' action for undo.
function pushHistory(obj) {
  history.push(obj);
  undoStack.push({ type: 'add', obj });
  redoStack = [];
  syncUndoRedo();
}

function undo() {
  if (!undoStack.length) return;
  const action = undoStack.pop();
  if (action.type === 'add') {
    const idx = history.indexOf(action.obj);
    if (idx !== -1) history.splice(idx, 1);
    redoStack.push(action);
  } else if (action.type === 'remove') {
    history.push(action.obj);
    redoStack.push(action);
  } else if (action.type === 'move') {
    restorePosition(action.obj, action.from);
    redoStack.push(action);
  } else if (action.type === 'editText') {
    applyTextSnapshot(action.obj, action.from);
    redoStack.push(action);
  } else if (action.type === 'editSticky') {
    applyStickySnapshot(action.obj, action.from);
    redoStack.push(action);
  } else if (action.type === 'erase') {
    undoErase(action.entries);
    redoStack.push(action);
  }
  selectedIndex = -1;
  dragMoveInfo = null;
  stickyResize = null;
  syncUndoRedo();
  fullRedraw();
}

function redo() {
  if (!redoStack.length) return;
  const action = redoStack.pop();
  if (action.type === 'add') {
    history.push(action.obj);
    undoStack.push(action);
  } else if (action.type === 'remove') {
    const idx = history.indexOf(action.obj);
    if (idx !== -1) history.splice(idx, 1);
    undoStack.push(action);
  } else if (action.type === 'move') {
    restorePosition(action.obj, action.to);
    undoStack.push(action);
  } else if (action.type === 'editText') {
    applyTextSnapshot(action.obj, action.to);
    undoStack.push(action);
  } else if (action.type === 'editSticky') {
    applyStickySnapshot(action.obj, action.to);
    undoStack.push(action);
  } else if (action.type === 'erase') {
    redoErase(action.entries);
    undoStack.push(action);
  }
  selectedIndex = -1;
  dragMoveInfo = null;
  stickyResize = null;
  syncUndoRedo();
  fullRedraw();
}

function syncUndoRedo() {
  const undoButton = document.getElementById('undo-button');
  const redoButton = document.getElementById('redo-button');
  undoButton.disabled = undoStack.length === 0;
  redoButton.disabled = redoStack.length === 0;
  scheduleSave();
}

// Reverse an erase operation: for each entry, either re-insert the removed
// object, or replace the fragments with the original object.
function undoErase(entries) {
  // Process in reverse order of application (entries were unshifted, so
  // index 0 was the last object touched — process front-to-back to restore)
  for (const entry of entries) {
    if (entry.removed) {
      // Re-add the removed object
      history.push(entry.obj);
    } else if (entry.after !== undefined) {
      // Replace: remove all fragment objects, re-insert the original
      for (const frag of entry.after) {
        const idx = history.indexOf(frag);
        if (idx !== -1) history.splice(idx, 1);
      }
      // Re-insert original at its old position
      history.splice(Math.min(entry.replaceIndex, history.length), 0, entry.before.obj);
    }
  }
}

// Re-apply an erase operation: remove originals / re-insert fragments.
// Process in reverse order so chained splits replay in chronological order
// (split A → [A1,A2] must happen before split A1 → [A1a,A1b]).
function redoErase(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.removed) {
      const idx = history.indexOf(entry.obj);
      if (idx !== -1) history.splice(idx, 1);
    } else if (entry.after !== undefined) {
      // Remove original, insert fragments at the same index
      const idx = history.indexOf(entry.before.obj);
      if (idx !== -1) {
        history.splice(idx, 1);
        for (let j = entry.after.length - 1; j >= 0; j--) {
          history.splice(idx, 0, entry.after[j]);
        }
      }
    }
  }
}

// ── Draw all history onto any context ────────────────────
function drawObject(context, obj) {
  context.save();
  if (obj.type === 'stroke') {
    drawStroke(context, obj);
  } else if (obj.type === 'arrow') {
    drawArrowShape(context, obj.x1, obj.y1, obj.x2, obj.y2, obj.color, obj.size);
  } else if (obj.type === 'line') {
    const lineWidth = Math.max(1, obj.size * 0.75);
    context.strokeStyle = obj.color;
    context.lineWidth = lineWidth;
    context.lineCap = 'round';
    context.beginPath();
    context.moveTo(obj.x1, obj.y1);
    context.lineTo(obj.x2, obj.y2);
    context.stroke();
  } else if (obj.type === 'rect') {
    const lineWidth = Math.max(1, obj.size * 0.75);
    context.strokeStyle = obj.color;
    context.lineWidth = lineWidth;
    context.lineJoin = 'round';
    context.strokeRect(obj.x1, obj.y1, obj.x2 - obj.x1, obj.y2 - obj.y1);
  } else if (obj.type === 'circle') {
    const lineWidth = Math.max(1, obj.size * 0.75);
    const cx = (obj.x1 + obj.x2) / 2;
    const cy = (obj.y1 + obj.y2) / 2;
    const rx = Math.abs(obj.x2 - obj.x1) / 2;
    const ry = Math.abs(obj.y2 - obj.y1) / 2;
    context.strokeStyle = obj.color;
    context.lineWidth = lineWidth;
    context.beginPath();
    context.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    context.stroke();
  } else if (obj.type === 'text') {
    context.font = obj.font;
    context.fillStyle = obj.color;
    context.textBaseline = 'top';
    obj.lines.forEach((line, i) => {
      context.fillText(line, obj.x, obj.y + i * obj.lineH);
    });
  } else if (obj.type === 'image') {
    // Guard: during async restore the img may still be decoding.
    if (obj.img) context.drawImage(obj.img, obj.x, obj.y, obj.w, obj.h);
  } else if (obj.type === 'sticky') {
    drawSticky(context, obj);
  }
  context.restore();
}

function drawStroke(context, obj) {
  const pts = obj.pts;
  if (!pts || pts.length === 0) return;

  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.strokeStyle = obj.color;

  if (pts.length === 1) {
    context.beginPath();
    context.arc(pts[0].x, pts[0].y, pts[0].w / 2, 0, Math.PI * 2);
    context.fillStyle = obj.color;
    context.fill();
  } else {
    for (let i = 1; i < pts.length; i++) {
      const p0 = pts[Math.max(0, i - 2)];
      const p1 = pts[i - 1];
      const p2 = pts[i];
      const p3 = pts[Math.min(pts.length - 1, i + 1)];
      const cp1x = p1.x + (p2.x - p0.x) / 6;
      const cp1y = p1.y + (p2.y - p0.y) / 6;
      const cp2x = p2.x - (p3.x - p1.x) / 6;
      const cp2y = p2.y - (p3.y - p1.y) / 6;
      context.lineWidth = p1.w;
      context.beginPath();
      context.moveTo(p1.x, p1.y);
      context.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
      context.stroke();
    }
  }
}

// ── Geometric eraser ─────────────────────────────────
// The eraser modifies the actual geometry of the objects it touches:
// strokes get split into fragments clipped at the exact eraser-circle
// boundary, so only the portion under the eraser is removed — not the
// whole segment. This means erased regions travel with their objects.
// The interval math (circleSegmentInterval, mergeIntervals,
// complementIntervals) and shape sampling (sampleShapePoints) live in
// geometry.js so they can be unit-tested in Node without a DOM.

// Check if a text object intersects the eraser circle.
function textIntersectsEraser(obj, ex, ey, er) {
  canvasContext.save();
  canvasContext.font = obj.font;
  for (let li = 0; li < obj.lines.length; li++) {
    const lineY = obj.y + li * obj.lineH;
    const w = canvasContext.measureText(obj.lines[li]).width;
    // Check the bounding rect of this line against eraser
    if (ex + er >= obj.x && ex - er <= obj.x + w &&
        ey + er >= lineY && ey - er <= lineY + obj.lineH) {
      canvasContext.restore();
      return true;
    }
  }
  canvasContext.restore();
  return false;
}

// Check if an axis-aligned box (image, sticky note) intersects the eraser circle.
function boxIntersectsEraser(bounds, ex, ey, er) {
  return ex + er >= bounds.minX && ex - er <= bounds.maxX &&
         ey + er >= bounds.minY && ey - er <= bounds.maxY;
}

// Convert a shape (line, arrow, rect, circle) into a stroke-like object
// with sampled points, so it can be partially erased via splitStrokeByEraser.
function shapeToStrokeObj(obj) {
  const pts = sampleShapePoints(obj);
  const w = Math.max(1.5, obj.size * 0.75);
  return {
    type: 'stroke',
    color: obj.color,
    size: obj.size,
    pts: pts.map(p => ({ x: p.x, y: p.y, w: w }))
  };
}

// Apply a set of eraser points to all objects in history.
// Appends undo entries to the provided array: { obj, removed } or
// { replaceIndex, before, after } for replace (split) operations.
function applyEraserPath(eraserPath, undoEntries) {
  // Iterate backwards so we can safely splice
  for (let i = history.length - 1; i >= 0; i--) {
    const obj = history[i];

    if (obj.type === 'stroke' && !obj.isErase) {
      // Split the stroke around every eraser point
      const fragments = splitStrokeByEraser(obj, eraserPath);
      if (fragments === null) {
        // Not touched — leave as is
        continue;
      }
      // Remove the original, add fragments
      const before = { type: 'original', obj };
      history.splice(i, 1);
      const newFrags = [];
      for (const frag of fragments) {
        const newObj = {
          type: 'stroke',
          color: obj.color,
          size: obj.size,
          pts: frag
        };
        history.splice(i, 0, newObj);
        newFrags.push(newObj);
      }
      undoEntries.unshift({ obj: null, replaceIndex: i, before: before, after: newFrags });
    } else if (obj.type === 'stroke' && obj.isErase) {
      // Don't erase other eraser strokes
      continue;
    } else if (obj.type === 'text') {
      let touched = false;
      for (const ep of eraserPath) {
        if (textIntersectsEraser(obj, ep.x, ep.y, ep.w / 2)) { touched = true; break; }
      }
      if (touched) {
        history.splice(i, 1);
        undoEntries.unshift({ obj, removed: true });
      }
    } else if (obj.type === 'image' || obj.type === 'sticky') {
      // Both are solid boxes: the eraser takes the whole pad, never a hole in it.
      let touched = false;
      for (const ep of eraserPath) {
        if (boxIntersectsEraser(getObjectBounds(obj), ep.x, ep.y, ep.w / 2)) { touched = true; break; }
      }
      if (touched) {
        history.splice(i, 1);
        undoEntries.unshift({ obj, removed: true });
      }
    } else {
      // Shapes (arrow, line, rect, circle): convert to stroke points and split
      // so only the erased portion is removed, not the whole shape.
      const strokeObj = shapeToStrokeObj(obj);
      const fragments = splitStrokeByEraser(strokeObj, eraserPath);
      if (fragments === null) {
        continue; // Not touched
      }
      // Remove the original shape, add surviving stroke fragments
      const before = { type: 'original', obj };
      history.splice(i, 1);
      const newFrags = [];
      for (const frag of fragments) {
        const newObj = {
          type: 'stroke',
          color: obj.color,
          size: obj.size,
          pts: frag
        };
        history.splice(i, 0, newObj);
        newFrags.push(newObj);
      }
      undoEntries.unshift({ obj: null, replaceIndex: i, before: before, after: newFrags });
    }
  }
}

// Split a stroke into fragments, removing only the portions that fall
// inside any eraser circle. Fragments are clipped at the exact
// circle-segment intersection points, so only the erased part is removed.
// Returns null if the stroke is not touched at all.
// Returns an array of point-arrays (fragments) if touched (may be empty = fully erased).
function splitStrokeByEraser(strokeObj, eraserPath) {
  const pts = strokeObj.pts;
  if (pts.length === 0) return null;

  // Single-point stroke: erased if the point falls inside any eraser circle
  if (pts.length === 1) {
    for (const ep of eraserPath) {
      if (Math.hypot(pts[0].x - ep.x, pts[0].y - ep.y) <= ep.w / 2) return [];
    }
    return null;
  }

  // For each segment i (pts[i-1] → pts[i]), collect erased intervals in [0,1].
  const segErased = []; // array of merged interval-lists, one per segment
  let anyErased = false;

  for (let i = 1; i < pts.length; i++) {
    const p0 = pts[i - 1], p1 = pts[i];
    const intervals = [];
    for (const ep of eraserPath) {
      const iv = circleSegmentInterval(p0.x, p0.y, p1.x, p1.y, ep.x, ep.y, ep.w / 2);
      if (iv) intervals.push(iv);
    }
    if (intervals.length > 0) anyErased = true;
    segErased.push(mergeIntervals(intervals));
  }

  if (!anyErased) return null;

  // Walk segments, building fragments from surviving sub-intervals.
  // When a segment's last survivor reaches t=1 and the next segment's first
  // survivor starts at t=0, the shared endpoint is not duplicated.
  const lerp = (p0, p1, t) => ({
    x: p0.x + t * (p1.x - p0.x),
    y: p0.y + t * (p1.y - p0.y),
    w: p0.w + t * (p1.w - p0.w)
  });

  const fragments = [];
  let current = [];

  for (let si = 0; si < segErased.length; si++) {
    const p0 = pts[si], p1 = pts[si + 1];
    const survivors = complementIntervals(segErased[si], 0, 1);

    if (survivors.length === 0) {
      // Entire segment erased — close the current fragment
      if (current.length > 0) { fragments.push(current); current = []; }
      continue;
    }

    for (let svi = 0; svi < survivors.length; svi++) {
      const [slo, shi] = survivors[svi];

      if (slo > 0) {
        // Segment is erased before this survivor → boundary point, start fresh
        if (current.length > 0) { fragments.push(current); current = []; }
        current.push(lerp(p0, p1, slo));
      } else if (current.length === 0) {
        // slo === 0, fresh fragment → add the segment start point
        current.push(lerp(p0, p1, 0));
      }
      // else: slo === 0 and current non-empty → shared endpoint, skip duplicate

      // End point of this surviving sub-interval
      current.push(lerp(p0, p1, shi));

      // If there's a gap after this survivor, close the fragment
      if (svi < survivors.length - 1 || shi < 1) {
        fragments.push(current);
        current = [];
      }
    }
  }
  if (current.length > 0) fragments.push(current);

  // Drop single-point fragments (not useful for drawing)
  return fragments.filter(f => f.length >= 2);
}

// ── Selection helpers (bounds, hit-test, move) ───────────

// Axis-aligned bounding box of an object in world coordinates.
function getObjectBounds(obj) {
  if (obj.type === 'stroke') {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of obj.pts) {
      const r = p.w / 2;
      minX = Math.min(minX, p.x - r);
      minY = Math.min(minY, p.y - r);
      maxX = Math.max(maxX, p.x + r);
      maxY = Math.max(maxY, p.y + r);
    }
    return { minX, minY, maxX, maxY };
  } else if (obj.type === 'image') {
    return { minX: obj.x, minY: obj.y, maxX: obj.x + obj.w, maxY: obj.y + obj.h };
  } else if (obj.type === 'sticky') {
    return { minX: obj.x, minY: obj.y, maxX: obj.x + obj.width, maxY: obj.y + obj.height };
  } else if (obj.type === 'text') {
    canvasContext.save();
    canvasContext.font = obj.font;
    let maxX = obj.x;
    for (const line of obj.lines) {
      maxX = Math.max(maxX, obj.x + canvasContext.measureText(line).width);
    }
    canvasContext.restore();
    return { minX: obj.x, minY: obj.y, maxX, maxY: obj.y + obj.lines.length * obj.lineH };
  } else if (obj.type === 'circle') {
    const cx = (obj.x1 + obj.x2) / 2;
    const cy = (obj.y1 + obj.y2) / 2;
    const rx = Math.abs(obj.x2 - obj.x1) / 2;
    const ry = Math.abs(obj.y2 - obj.y1) / 2;
    return { minX: cx - rx, minY: cy - ry, maxX: cx + rx, maxY: cy + ry };
  } else {
    // arrow, line, rect — all use x1,y1,x2,y2
    return {
      minX: Math.min(obj.x1, obj.x2),
      minY: Math.min(obj.y1, obj.y2),
      maxX: Math.max(obj.x1, obj.x2),
      maxY: Math.max(obj.y1, obj.y2)
    };
  }
}

// Hit-test any object by checking if the point is inside its bounding box.
// For strokes, uses a more precise distance check to the nearest segment.
function hitTestAny(worldPoint) {
  for (let i = history.length - 1; i >= 0; i--) {
    const obj = history[i];
    if (obj.type === 'stroke') {
      const tolerance = Math.max(6, brushSize);
      for (const p of obj.pts) {
        const dx = worldPoint.x - p.x;
        const dy = worldPoint.y - p.y;
        if (Math.sqrt(dx * dx + dy * dy) <= p.w / 2 + tolerance) return i;
      }
    } else {
      const b = getObjectBounds(obj);
      const pad = 6;
      if (worldPoint.x >= b.minX - pad && worldPoint.x <= b.maxX + pad &&
          worldPoint.y >= b.minY - pad && worldPoint.y <= b.maxY + pad) {
        return i;
      }
    }
  }
  return -1;
}

// Move an object by (dx, dy) in world coordinates.
function translateObject(obj, dx, dy) {
  if (obj.type === 'stroke') {
    for (const p of obj.pts) { p.x += dx; p.y += dy; }
  } else if (obj.type === 'image' || obj.type === 'text' || obj.type === 'sticky') {
    obj.x += dx; obj.y += dy;
  } else {
    obj.x1 += dx; obj.y1 += dy; obj.x2 += dx; obj.y2 += dy;
  }
}

// Capture the position of an object so we can restore it on undo.
function snapshotPosition(obj) {
  if (obj.type === 'stroke') {
    return obj.pts.map(p => ({ x: p.x, y: p.y }));
  } else if (obj.type === 'image' || obj.type === 'text' || obj.type === 'sticky') {
    return { x: obj.x, y: obj.y };
  } else {
    return { x1: obj.x1, y1: obj.y1, x2: obj.x2, y2: obj.y2 };
  }
}

// Restore an object's position from a snapshot.
function restorePosition(obj, snap) {
  if (obj.type === 'stroke') {
    for (let i = 0; i < obj.pts.length; i++) {
      obj.pts[i].x = snap[i].x;
      obj.pts[i].y = snap[i].y;
    }
  } else if (obj.type === 'image' || obj.type === 'text' || obj.type === 'sticky') {
    obj.x = snap.x; obj.y = snap.y;
  } else {
    obj.x1 = snap.x1; obj.y1 = snap.y1; obj.x2 = snap.x2; obj.y2 = snap.y2;
  }
}

// Apply a text-content snapshot (lines, color, font, lineH) to a text object.
function applyTextSnapshot(obj, snap) {
  obj.lines = snap.lines.slice();
  obj.color = snap.color;
  obj.font = snap.font;
  obj.lineH = snap.lineH;
}

// ── Full redraw ───────────────────────────────────────────
// Coalesces redraw requests: multiple fullRedraw() calls within the same
// frame (e.g. mousemove handlers firing faster than the display refresh)
// collapse into a single paint. renderFrame() draws the scene plus any
// transient overlays (eraser hover cursor) that must not be persisted.
let eraserHoverPoint = null; // world-space point under the cursor when hovering with the eraser tool
let redrawQueued = false;

function renderFrame() {
  redrawQueued = false;
  const width = canvasWrap.offsetWidth;
  const height = canvasWrap.offsetHeight;
  canvasContext.clearRect(0, 0, width, height);
  canvasContext.fillStyle = isDark ? '#0e0e0e' : '#f5f3ef';
  canvasContext.fillRect(0, 0, width, height);
  canvasContext.save();
  canvasContext.translate(panX, panY);
  canvasContext.scale(viewScale, viewScale);

  for (let i = 0; i < history.length; i++) {
    // Skip the text object currently being edited — the textarea overlay shows it instead
    if (activeTextNode && activeTextNode.editIndex === i) continue;
    // Same for a sticky note: the editor overlay stands in for it
    if (stickyEditIndex === i) continue;
    drawObject(canvasContext, history[i]);
  }

  // In-progress stroke (not yet committed to history) so a redraw triggered
  // mid-stroke (resize, tool switch) doesn't visually drop the uncommitted part.
  if (currentStroke && !currentStroke.isErase) drawStroke(canvasContext, currentStroke);

  // Live shape preview
  if (shapeStart && shapeEnd) drawShapePreview(canvasContext);

  // Selection bounding box (select tool)
  if (tool === 'select' && selectedIndex !== -1 && selectedIndex < history.length) {
    const obj = history[selectedIndex];
    const b = getObjectBounds(obj);
    const pad = 6 / viewScale;
    canvasContext.strokeStyle = isDark ? '#c8a96e' : '#8a6a2a';
    canvasContext.lineWidth = 1.5 / viewScale;
    canvasContext.setLineDash([6 / viewScale, 4 / viewScale]);
    canvasContext.strokeRect(b.minX - pad, b.minY - pad, b.maxX - b.minX + pad * 2, b.maxY - b.minY + pad * 2);
    canvasContext.setLineDash([]);
    // Sticky notes are the one object with a size worth authoring by hand.
    if (obj.type === 'sticky') drawStickyHandles(canvasContext, obj);
  }

  canvasContext.restore();

  // Eraser hover cursor — drawn in screen space after the world transform is
  // restored, so it stays crisp regardless of zoom level.
  if (eraserHoverPoint) drawEraserCursor(eraserHoverPoint);

  document.getElementById('zoom-level').textContent = Math.round(viewScale * 100) + '%';
  scheduleSave();
}

function fullRedraw() {
  if (redrawQueued) return;
  redrawQueued = true;
  requestAnimationFrame(renderFrame);
}

// ── Arrow ─────────────────────────────────────────────────
function drawArrowShape(context, x1, y1, x2, y2, color, size) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (Math.sqrt(dx * dx + dy * dy) < 2) return;
  const angle = Math.atan2(dy, dx);
  const headLen = Math.max(14, size * 5);
  const lineWidth = Math.max(1.5, size * 0.75);
  const endX = x2 - Math.cos(angle) * (headLen * 0.45 + lineWidth / 2);
  const endY = y2 - Math.sin(angle) * (headLen * 0.45 + lineWidth / 2);
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = lineWidth;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.beginPath();
  context.moveTo(x1, y1);
  context.lineTo(endX, endY);
  context.stroke();
  context.beginPath();
  context.moveTo(x2, y2);
  context.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 7), y2 - headLen * Math.sin(angle - Math.PI / 7));
  context.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 7), y2 - headLen * Math.sin(angle + Math.PI / 7));
  context.closePath();
  context.fill();
}

// ── Shape preview (live drag) ─────────────────────────────
let shapeStart = null, shapeEnd = null;

function drawShapePreview(context) {
  context.save();
  const color = drawColor;
  const size = brushSize;
  const lineWidth = Math.max(1, size * 0.75);

  // Dashed preview style
  context.setLineDash([6 / viewScale, 4 / viewScale]);
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = lineWidth;
  context.lineCap = 'round';
  context.lineJoin = 'round';

  if (tool === 'arrow') {
    context.setLineDash([]);
    drawArrowShape(context, shapeStart.x, shapeStart.y, shapeEnd.x, shapeEnd.y, color, size);
  } else if (tool === 'line') {
    context.beginPath();
    context.moveTo(shapeStart.x, shapeStart.y);
    context.lineTo(shapeEnd.x, shapeEnd.y);
    context.stroke();
  } else if (tool === 'rect') {
    context.strokeRect(shapeStart.x, shapeStart.y, shapeEnd.x - shapeStart.x, shapeEnd.y - shapeStart.y);
  } else if (tool === 'circle') {
    const cx = (shapeStart.x + shapeEnd.x) / 2;
    const cy = (shapeStart.y + shapeEnd.y) / 2;
    const rx = Math.abs(shapeEnd.x - shapeStart.x) / 2;
    const ry = Math.abs(shapeEnd.y - shapeStart.y) / 2;
    context.beginPath();
    context.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    context.stroke();
  }
  context.restore();
}

function commitShape() {
  const obj = {
    color: drawColor,
    size: brushSize,
    x1: shapeStart.x,
    y1: shapeStart.y,
    x2: shapeEnd.x,
    y2: shapeEnd.y
  };
  if (tool === 'arrow') obj.type = 'arrow';
  else if (tool === 'line') obj.type = 'line';
  else if (tool === 'rect') obj.type = 'rect';
  else if (tool === 'circle') obj.type = 'circle';
  pushHistory(obj);
  shapeStart = null;
  shapeEnd = null;
  fullRedraw();
}

// ── Theme ─────────────────────────────────────────────────
function toggleTheme() {
  isDark = !isDark;
  document.documentElement.classList.toggle('light', !isDark);
  fullRedraw();
}

// ════════════════════════════════════════════════════════
// COLOUR PICKER
// ════════════════════════════════════════════════════════
// One popover shared by the toolbar palette and the sticky-note editor. The
// grid is generated rather than written out: twelve hues in five steps of
// lightness, plus a greyscale row, which covers far more ground than a
// hand-written list without a wall of hex codes to maintain.

const CP_HUES = [0, 20, 40, 60, 95, 135, 165, 190, 212, 250, 285, 320];
const CP_STEPS = [
  { s: 72, l: 86 },   // pastel — the pad colours live around here
  { s: 68, l: 72 },
  { s: 62, l: 58 },
  { s: 58, l: 44 },
  { s: 52, l: 30 }
];
const CP_GREYS = ['#ffffff', '#f0eee9', '#dcd9d2', '#c2beb6', '#a5a099', '#8a857d',
                  '#6e6a63', '#54514b', '#3d3a35', '#2a2723', '#1a1917', '#000000'];

// Colours the user picked themselves. Offered by both palettes and saved with
// the document, because a custom colour that vanishes on reload is a colour
// you have to mix again every session. Kept to a short queue in the order they
// were added: a fourth colour pushes the first one out.
let customColors = [];
const MAX_CUSTOM_COLORS = 3;

function hslToHex(h, s, l) {
  const sat = s / 100;
  const light = l / 100;
  const k = (n) => (n + h / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (n) => light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const hex = (n) => Math.round(255 * f(n)).toString(16).padStart(2, '0');
  return `#${hex(0)}${hex(8)}${hex(4)}`;
}

function normalizeHex(value) {
  const { r, g, b } = hexToRgb(value);
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

function rememberCustomColor(color) {
  const hex = normalizeHex(color);
  if (PALETTE_COLORS.includes(hex) || STICKY_COLORS.includes(hex)) return;
  // Already in the queue: leave it where it is rather than shuffling the row
  // around under the cursor.
  if (customColors.includes(hex)) return;

  customColors.push(hex);
  while (customColors.length > MAX_CUSTOM_COLORS) customColors.shift();   // oldest out
  renderPalette();
  renderStickySwatches();
  scheduleSave();
}

const colorPopover = document.getElementById('color-popover');
const colorGrid = document.getElementById('cp-grid');
const colorCustomInput = document.getElementById('cp-custom');
const colorHexLabel = document.getElementById('cp-hex');

let colorPickerPick = null;    // callback for the control that opened it
let colorPickerAnchor = null;

// Build the grid once — it never changes.
(function buildColorGrid() {
  const cells = [];
  for (const step of CP_STEPS) {
    for (const hue of CP_HUES) cells.push(hslToHex(hue, step.s, step.l));
  }
  cells.push.apply(cells, CP_GREYS);
  for (const color of cells) {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'cp-cell';
    cell.dataset.color = color;
    cell.style.background = color;
    cell.title = color;
    cell.setAttribute('aria-label', color);
    cell.addEventListener('click', () => choosePickerColor(color));
    colorGrid.appendChild(cell);
  }
})();

function choosePickerColor(color) {
  const hex = normalizeHex(color);
  if (colorPickerPick) colorPickerPick(hex);
  rememberCustomColor(hex);
  closeColorPicker();
}

// anchor: the element the popover should sit under. onPick: what to do with
// the chosen colour.
function openColorPicker(anchor, current, onPick) {
  colorPickerPick = onPick;
  colorPickerAnchor = anchor;
  const currentHex = current ? normalizeHex(current) : '';
  colorCustomInput.value = /^#[0-9a-f]{6}$/i.test(currentHex) ? currentHex : '#c8a96e';
  colorHexLabel.textContent = currentHex;
  Array.from(colorGrid.children).forEach((cell) => {
    cell.classList.toggle('on', cell.dataset.color === currentHex);
  });

  colorPopover.classList.remove('hidden');
  const box = colorPopover.getBoundingClientRect();
  const rect = anchor.getBoundingClientRect();
  const margin = 8;
  const left = Math.max(margin, Math.min(rect.left + rect.width / 2 - box.width / 2,
    window.innerWidth - box.width - margin));
  let top = rect.bottom + 8;
  if (top + box.height > window.innerHeight - margin) top = Math.max(margin, rect.top - box.height - 8);
  colorPopover.style.left = `${left}px`;
  colorPopover.style.top = `${top}px`;
}

function closeColorPicker() {
  colorPopover.classList.add('hidden');
  colorPickerPick = null;
  colorPickerAnchor = null;
}

function isColorPickerOpen() {
  return !colorPopover.classList.contains('hidden');
}

// Live preview while dragging the native picker; the value is kept on change.
colorCustomInput.addEventListener('input', () => {
  colorHexLabel.textContent = normalizeHex(colorCustomInput.value);
  if (colorPickerPick) colorPickerPick(normalizeHex(colorCustomInput.value));
});
colorCustomInput.addEventListener('change', () => choosePickerColor(colorCustomInput.value));

document.addEventListener('mousedown', (e) => {
  if (!isColorPickerOpen()) return;
  if (colorPopover.contains(e.target)) return;
  if (colorPickerAnchor && colorPickerAnchor.contains(e.target)) return;
  closeColorPicker();
}, true);

// Capture phase, so Escape closes the picker without also closing the sticky
// editor underneath it.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isColorPickerOpen()) {
    e.preventDefault();
    e.stopPropagation();
    closeColorPicker();
  }
}, true);

// ── Palette ───────────────────────────────────────────────
let drawColor = PALETTE_COLORS[0];
const colorPalette = document.getElementById('color-palette');

// Rebuilt whenever the custom colours change, so the trailing + button always
// stays last in the row.
function renderPalette() {
  colorPalette.querySelectorAll('.color-dot, .color-add').forEach((el) => el.remove());

  for (const color of PALETTE_COLORS.concat(customColors)) {
    const dot = document.createElement('div');
    dot.className = 'color-dot' + (color === drawColor ? ' on' : '');
    dot.style.background = color;
    dot.style.boxShadow = '0 0 0 1px #555';
    dot.dataset.color = color;
    dot.title = color;
    dot.onclick = () => setDrawColor(color);
    colorPalette.appendChild(dot);
  }

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'color-add';
  add.title = 'More colours';
  add.setAttribute('aria-label', 'More colours');
  add.textContent = '+';
  add.onclick = (e) => {
    e.stopPropagation();
    if (isColorPickerOpen()) { closeColorPicker(); return; }
    openColorPicker(add, drawColor, setDrawColor);
  };
  colorPalette.appendChild(add);
}

function setDrawColor(color) {
  drawColor = color;
  colorPalette.querySelectorAll('.color-dot').forEach((el) => {
    el.classList.toggle('on', el.dataset.color === color);
  });
  updateTextStyle();
}

renderPalette();

// ── Tool state ────────────────────────────────────────────
let tool = 'draw';
let brushSize = 3;
let spaceDown = false;
let middleMouseDown = false;
let middleMouseStart = null;
let isPanning = false;
let panStart = null;
let textBold = false, textItalic = false;
let activeTextNode = null;
let selectedIndex = -1;    // index in history of the selected object, -1 = none
let dragMoveInfo = null;   // { index, lastWorld, startSnap } — active move in select tool
let eraserUndoEntries = []; // accumulates undo entries during a live eraser drag
// Draw-tool stroke refinement, applied on release. The two modes are
// mutually exclusive: both rewrite the stroke, so running them together
// would just mean one re-fitting what the other already idealised.
let isSmartDrawEnabled = false;  // snap closed strokes to circle / rectangle / triangle
let isSmartDraw2Enabled = false; // rebuild every stroke from exact lines and arcs

const SHAPE_TOOLS = new Set(['arrow', 'line', 'rect', 'circle']);
const CURSORS = {
  select: 'default', draw: 'crosshair', eraser: 'cell', arrow: 'crosshair', line: 'crosshair',
  rect: 'crosshair', circle: 'crosshair', text: 'text', pan: 'grab'
};
const STATUSES = {
  select:  'Select · Drag to move or resize · Click a task box or link · Double-click to edit',
  draw:    'Draw · Scroll=zoom · Space/middle=pan',
  eraser:  'Eraser · Drag to erase',
  arrow:   'Arrow · Click & drag',
  line:    'Line · Click & drag',
  rect:    'Rectangle · Click & drag',
  circle:  'Circle / Ellipse · Click & drag',
  text:    'Text · Click to place · [N] new Markdown sticky note · Double-click to edit',
  pan:     'Pan · Drag to move canvas'
};

const TOOL_BUTTON_IDS = {
  select: 'tool-select', draw: 'tool-draw', eraser: 'tool-eraser', text: 'tool-text', pan: 'tool-pan',
  arrow: 'tool-arrow', line: 'tool-line', rect: 'tool-rect', circle: 'tool-circle'
};

function setTool(t) {
  commitText();
  eraserHoverPoint = null;
  stickyHoverTask = null;
  if (tool === 'select' && t !== 'select') {
    selectedIndex = -1;
    dragMoveInfo = null;
    stickyResize = null;
  }
  tool = t;
  Object.entries(TOOL_BUTTON_IDS).forEach(([key, id]) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('on', key === t);
  });
  canvas.style.cursor = CURSORS[t] || 'crosshair';
  statusBar.textContent = STATUSES[t] || '';
  syncSmartStrokeButtons();
  syncStickyButton();
  fullRedraw();
}

// ── Hover tooltip ─────────────────────────────────────────
// One bubble shared by every control carrying data-tip-title. Native title=
// tooltips take a second to appear, can't be themed, and can't hold a
// two-line explanation — and anything rendered inside #bottom-controls would
// be clipped by the overflow that makes its slide animations work.
const tooltip = document.getElementById('tooltip');
let tooltipTarget = null;

function hideTooltip() {
  if (!tooltip) return;
  tooltipTarget = null;
  tooltip.classList.remove('show');
  tooltip.setAttribute('aria-hidden', 'true');
}

function showTooltip(el) {
  if (!tooltip) return;
  tooltipTarget = el;

  const head = document.createElement('div');
  head.className = 'tip-head';
  const title = document.createElement('span');
  title.className = 'tip-title';
  title.textContent = el.dataset.tipTitle;
  head.appendChild(title);
  if (el.dataset.tipKey) {
    const key = document.createElement('span');
    key.className = 'tip-key';
    key.textContent = el.dataset.tipKey;
    head.appendChild(key);
  }
  const body = document.createElement('div');
  body.textContent = el.dataset.tipBody || '';
  tooltip.replaceChildren(head, body);
  tooltip.setAttribute('aria-hidden', 'false');

  // Fill first, then measure: the bubble wraps, so its height isn't known
  // until the text is in. Sit above the control, clamped to the viewport.
  const anchor = el.getBoundingClientRect();
  const box = tooltip.getBoundingClientRect();
  const margin = 8;
  const left = Math.max(margin, Math.min(
    anchor.left + anchor.width / 2 - box.width / 2,
    window.innerWidth - box.width - margin
  ));
  let top = anchor.top - box.height - 10;
  if (top < margin) top = anchor.bottom + 10; // no room above — flip below
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
  tooltip.classList.add('show');
}

document.querySelectorAll('[data-tip-title]').forEach((el) => {
  el.addEventListener('mouseenter', () => showTooltip(el));
  el.addEventListener('mouseleave', () => { if (tooltipTarget === el) hideTooltip(); });
  // The click itself is the feedback; keep the bubble out of the way.
  el.addEventListener('click', hideTooltip);
});

// ── Smart stroke toggles ──────────────────────────────────
// Both modes only apply to freehand drawing, so they are revealed for the
// Draw tool and hidden everywhere else. The flags are left alone when
// switching tools: coming back to Draw restores the mode you left it in.
const smartStrokeGroup = document.getElementById('bc-smart');
const smartStrokeButton = document.getElementById('btn-smart-stroke');
const smartStroke2Button = document.getElementById('btn-smart-stroke-2');

function syncSmartStrokeButtons() {
  const onDraw = tool === 'draw';
  // Collapsing the group (rather than display:none) is what lets the pair
  // slide in and out; see .bc-smart in styles.css.
  if (smartStrokeGroup) smartStrokeGroup.classList.toggle('collapsed', !onDraw);
  if (smartStrokeButton) smartStrokeButton.classList.toggle('is-active', isSmartDrawEnabled);
  if (smartStroke2Button) smartStroke2Button.classList.toggle('is-active', isSmartDraw2Enabled);
  // A tooltip left open over a button that is sliding away would hang in mid-air.
  if (!onDraw) hideTooltip();
}

// boot() is async (it awaits IndexedDB), so the initial visibility is
// resolved here instead — the default tool is Draw, which shows the buttons.
syncSmartStrokeButtons();

function announceSmartMode(message) {
  statusBar.textContent = message || STATUSES[tool] || '';
}

function toggleSmartStroke() {
  isSmartDrawEnabled = !isSmartDrawEnabled;
  if (isSmartDrawEnabled) isSmartDraw2Enabled = false;
  syncSmartStrokeButtons();
  announceSmartMode(isSmartDrawEnabled &&
    'Smart Stroke ON · Closed shapes snap to circle / rectangle / triangle');
}

function toggleSmartStroke2() {
  isSmartDraw2Enabled = !isSmartDraw2Enabled;
  if (isSmartDraw2Enabled) isSmartDrawEnabled = false;
  syncSmartStrokeButtons();
  announceSmartMode(isSmartDraw2Enabled &&
    'Smart Stroke 2 ON · Straight lines, true arcs, sharp corners');
}

document.getElementById('brush-size').addEventListener('input', (e) => {
  brushSize = +e.target.value;
});

// ── Stroke engine ─────────────────────────────────────────
let strokePoints = [];
let lastVelocity = 0;
let isDrawing = false;
let currentStroke = null;

function computeStrokeWidth(velocity, size) {
  if (tool === 'eraser') return size * 7;
  const minWidth = Math.max(0.5, size * 0.38);
  return size - (size - minWidth) * Math.min(velocity, 20) / 20;
}

function startStroke(worldPoint) {
  isDrawing = true;
  strokePoints = [{ x: worldPoint.x, y: worldPoint.y, w: computeStrokeWidth(0, brushSize), t: Date.now() }];
  lastVelocity = 0;
  currentStroke = {
    type: 'stroke',
    color: drawColor,
    size: brushSize,
    isErase: tool === 'eraser',
    pts: strokePoints
  };
  // Eraser: apply the first point immediately so erasing is visible from the start
  if (tool === 'eraser') {
    eraserUndoEntries = [];
    applyEraserPath([strokePoints[0]], eraserUndoEntries);
    eraserHoverPoint = strokePoints[0];
    fullRedraw();
  }
}

function drawEraserCursor(point) {
  const r = (point.w / 2) * viewScale;
  const sx = point.x * viewScale + panX;
  const sy = point.y * viewScale + panY;
  canvasContext.save();
  canvasContext.strokeStyle = isDark ? 'rgba(200,169,110,0.8)' : 'rgba(138,106,42,0.8)';
  canvasContext.lineWidth = 1.5;
  canvasContext.setLineDash([4, 3]);
  canvasContext.beginPath();
  canvasContext.arc(sx, sy, r, 0, Math.PI * 2);
  canvasContext.stroke();
  canvasContext.setLineDash([]);
  canvasContext.restore();
}

function continueStroke(worldPoint) {
  if (!isDrawing) return;
  const prev = strokePoints[strokePoints.length - 1];
  const dx = worldPoint.x - prev.x;
  const dy = worldPoint.y - prev.y;
  const velocity = Math.sqrt(dx * dx + dy * dy) / Math.max(1, Date.now() - prev.t) * 10;
  lastVelocity = lastVelocity * 0.5 + velocity * 0.5;
  strokePoints.push({ x: worldPoint.x, y: worldPoint.y, w: computeStrokeWidth(lastVelocity, brushSize), t: Date.now() });

  if (tool === 'eraser') {
    // Apply eraser incrementally: only the latest point so erasing is visible live
    applyEraserPath([strokePoints[strokePoints.length - 1]], eraserUndoEntries);
    eraserHoverPoint = strokePoints[strokePoints.length - 1];
    fullRedraw();
    return;
  }

  // Draw tool: fast direct screen-space path, no fullRedraw cost per segment
  const n = strokePoints.length;
  if (n < 3) return;
  const p0 = strokePoints[Math.max(0, n - 4)];
  const p1 = strokePoints[n - 3];
  const p2 = strokePoints[n - 2];
  const p3 = strokePoints[n - 1];
  const cp1x = p1.x + (p2.x - p0.x) / 6;
  const cp1y = p1.y + (p2.y - p0.y) / 6;
  const cp2x = p2.x - (p3.x - p1.x) / 6;
  const cp2y = p2.y - (p3.y - p1.y) / 6;

  const sx1 = p1.x * viewScale + panX;
  const sy1 = p1.y * viewScale + panY;
  const sx2 = p2.x * viewScale + panX;
  const sy2 = p2.y * viewScale + panY;
  const scp1x = cp1x * viewScale + panX;
  const scp1y = cp1y * viewScale + panY;
  const scp2x = cp2x * viewScale + panX;
  const scp2y = cp2y * viewScale + panY;

  canvasContext.strokeStyle = drawColor;
  canvasContext.lineWidth = p1.w * viewScale;
  canvasContext.lineCap = 'round';
  canvasContext.lineJoin = 'round';
  canvasContext.beginPath();
  canvasContext.moveTo(sx1, sy1);
  canvasContext.bezierCurveTo(scp1x, scp1y, scp2x, scp2y, sx2, sy2);
  canvasContext.stroke();
}

function endStroke(worldPoint) {
  if (!isDrawing) return;
  isDrawing = false;
  if (strokePoints.length <= 1) {
    const p = strokePoints[0] || worldPoint;
    if (!currentStroke.pts.length) {
      currentStroke.pts.push({ x: p.x, y: p.y, w: computeStrokeWidth(0, brushSize) });
    }
  }

  // Smart stroke: rewrite the raw points into a refined path *before* the
  // stroke is committed, so history, undo and the eraser only ever see the
  // finished geometry. It stays a plain 'stroke' object either way.
  if (!currentStroke.isErase && currentStroke.pts.length > 1) {
    if (isSmartDrawEnabled) {
      const shapeType = classifyStroke(currentStroke.pts);
      currentStroke.pts = refineStroke(currentStroke.pts, shapeType);
      statusBar.textContent = `Smart Stroke ON · detected: ${shapeType}`;
    } else if (isSmartDraw2Enabled) {
      currentStroke.pts = refinePrecision(currentStroke.pts);
    }
  }

  if (currentStroke.isErase) {
    // Eraser was applied incrementally during the drag; commit the accumulated undo entries
    if (eraserUndoEntries.length > 0) {
      undoStack.push({ type: 'erase', entries: eraserUndoEntries });
      redoStack = [];
      syncUndoRedo();
    }
    eraserUndoEntries = [];
  } else {
    pushHistory(currentStroke);
  }
  currentStroke = null;
  strokePoints = [];
  lastVelocity = 0;
  eraserHoverPoint = null;
  fullRedraw();
}

// ── Text ──────────────────────────────────────────────────
function getTextStyle() {
  const size = parseInt(document.getElementById('font-size').value) || 18;
  const family = document.getElementById('font-family').value;
  const bold = textBold ? 'bold ' : '';
  const italic = textItalic ? 'italic ' : '';
  return {
    size,
    family,
    css: `${italic}${bold}${size}px ${family}`,
    lineH: size * 1.4
  };
}

function updateTextStyle() {
  if (textInput.style.display !== 'block') return;
  const style = getTextStyle();
  textInput.style.font = style.css;
  textInput.style.color = drawColor;
  autoResizeTextarea();
}

function toggleBold() {
  textBold = !textBold;
  document.getElementById('bold-button').classList.toggle('on', textBold);
  updateTextStyle();
}

function toggleItalic() {
  textItalic = !textItalic;
  document.getElementById('italic-button').classList.toggle('on', textItalic);
  updateTextStyle();
}

let justPlacedText = false;

function placeText(screenX, screenY) {
  // Commit any existing text before placing new
  commitText();
  const rect = canvasWrap.getBoundingClientRect();
  const worldPoint = toWorld(screenX, screenY);
  const style = getTextStyle();
  textInput.style.left = (rect.left + screenX) + 'px';
  textInput.style.top = (rect.top + screenY) + 'px';
  textInput.style.font = style.css;
  textInput.style.color = drawColor;
  textInput.style.transform = `scale(${viewScale})`;
  textInput.style.transformOrigin = 'top left';
  textInput.value = '';
  textInput.style.width = '4px';
  textInput.style.height = style.size * 1.4 + 'px';
  textInput.style.display = 'block';
  textInput.focus();
  activeTextNode = { worldPoint };
  justPlacedText = true;
  requestAnimationFrame(() => { justPlacedText = false; });
}

// ── Edit existing text ───────────────────────────────────
function hitTestText(worldPoint) {
  for (let i = history.length - 1; i >= 0; i--) {
    const obj = history[i];
    if (obj.type !== 'text') continue;
    canvasContext.save();
    canvasContext.font = obj.font;
    let maxWidth = 0;
    for (const line of obj.lines) {
      maxWidth = Math.max(maxWidth, canvasContext.measureText(line).width);
    }
    canvasContext.restore();
    const height = obj.lines.length * obj.lineH;
    const padding = 6;
    if (worldPoint.x >= obj.x - padding && worldPoint.x <= obj.x + maxWidth + padding &&
        worldPoint.y >= obj.y - padding && worldPoint.y <= obj.y + height + padding) {
      return i;
    }
  }
  return -1;
}

function isTrivialAction(obj) {
  if (!obj) return false;
  if (obj.type === 'stroke') return obj.pts.length <= 2;
  if (obj.type === 'line' || obj.type === 'rect' || obj.type === 'circle' || obj.type === 'arrow') {
    return Math.abs(obj.x2 - obj.x1) < 4 && Math.abs(obj.y2 - obj.y1) < 4;
  }
  return false;
}

function editText(index) {
  commitText();
  const obj = history[index];
  if (!obj || obj.type !== 'text') return;
  const screenX = obj.x * viewScale + panX;
  const screenY = obj.y * viewScale + panY;
  const rect = canvasWrap.getBoundingClientRect();
  textInput.style.left = (rect.left + screenX) + 'px';
  textInput.style.top = (rect.top + screenY) + 'px';
  textInput.style.font = obj.font;
  textInput.style.color = obj.color;
  textInput.style.transform = `scale(${viewScale})`;
  textInput.style.transformOrigin = 'top left';
  textInput.value = obj.lines.join('\n');
  textInput.style.display = 'block';
  textInput.focus();
  textInput.setSelectionRange(textInput.value.length, textInput.value.length);

  // Sync toolbar style controls with the text being edited
  const sizeMatch = obj.font.match(/(\d+)px/);
  if (sizeMatch) document.getElementById('font-size').value = sizeMatch[1];
  textBold = /bold/i.test(obj.font);
  document.getElementById('bold-button').classList.toggle('on', textBold);
  textItalic = /italic/i.test(obj.font);
  document.getElementById('italic-button').classList.toggle('on', textItalic);
  const familyMatch = obj.font.match(/\d+px\s+(.+)/);
  if (familyMatch) {
    const fontFamilySelect = document.getElementById('font-family');
    for (const opt of fontFamilySelect.options) {
      if (opt.value === familyMatch[1]) {
        fontFamilySelect.value = familyMatch[1];
        break;
      }
    }
  }
  drawColor = obj.color;
  activeTextNode = { worldPoint: { x: obj.x, y: obj.y }, editIndex: index };
  autoResizeTextarea();
  fullRedraw();   // hide the original text now that the textarea overlay shows it
  justPlacedText = true;
  requestAnimationFrame(() => { justPlacedText = false; });
}

function autoResizeTextarea() {
  textInput.style.width = '4px';
  textInput.style.width = textInput.scrollWidth + 'px';
  textInput.style.height = '0';
  textInput.style.height = textInput.scrollHeight + 'px';
}

textInput.addEventListener('input', autoResizeTextarea);
textInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') commitText();
});

function commitText() {
  if (!activeTextNode || textInput.style.display === 'none') return;
  const value = textInput.value;
  const style = getTextStyle();
  const editIndex = activeTextNode.editIndex;
  const worldPoint = activeTextNode.worldPoint;
  // Clear activeTextNode BEFORE fullRedraw so the committed text is drawn again
  activeTextNode = null;
  if (value.trim()) {
    if (editIndex !== undefined) {
      // Update existing text object in place
      const obj = history[editIndex];
      // Snapshot the old state so the edit is undoable
      const oldSnap = {
        lines: obj.lines.slice(),
        color: obj.color,
        font: obj.font,
        lineH: obj.lineH
      };
      obj.lines = value.split('\n');
      obj.color = drawColor;
      obj.font = style.css;
      obj.lineH = style.lineH;
      const newSnap = {
        lines: obj.lines.slice(),
        color: obj.color,
        font: obj.font,
        lineH: obj.lineH
      };
      undoStack.push({ type: 'editText', obj, from: oldSnap, to: newSnap });
      redoStack = [];
      syncUndoRedo();
      fullRedraw();
    } else {
      pushHistory({
        type: 'text',
        color: drawColor,
        font: style.css,
        lineH: style.lineH,
        x: worldPoint.x,
        y: worldPoint.y,
        lines: value.split('\n')
      });
      fullRedraw();
    }
  } else if (editIndex !== undefined) {
    // Editing produced empty text — remove the original
    const obj = history[editIndex];
    history.splice(editIndex, 1);
    undoStack.push({ type: 'remove', obj });
    redoStack = [];
    syncUndoRedo();
    fullRedraw();
  }
  textInput.style.display = 'none';
  textInput.value = '';
}

// ════════════════════════════════════════════════════════
// MARKDOWN STICKY NOTES
// ════════════════════════════════════════════════════════
// A sticky is a coloured pad carrying Markdown, laid out and drawn straight
// onto the canvas — no DOM node, so it pans, zooms, moves, erases and exports
// exactly like every other scene object.
//
//   { type: 'sticky', x, y, width, height, rawText, bgColor, color, font,
//     maxWidth?, minHeight? }
//
// rawText is the single source of truth; the block structure is re-derived by
// markdown.js on every layout, so an edit can never leave a stale copy behind.
// width/height are cached on the object because hit-testing and the selection
// box need them without a canvas measurement pass.
//
// maxWidth / minHeight are only set once the user drags a resize handle. Until
// then a note sizes itself to its text. After that the note wraps to the width
// it was given and never shrinks below the height it was given — but it still
// grows to fit text that no longer fits, so an edit can never clip itself.

const STICKY_PAD = 18;          // inner padding around the text block
const STICKY_FOLD = 22;         // size of the dog-eared bottom-right corner
const STICKY_MIN_WIDTH = 170;
const STICKY_MAX_WIDTH = 460;   // auto-sizing stops here; dragging can go wider
const STICKY_RESIZE_MAX_WIDTH = 1400;
const STICKY_MIN_HEIGHT = 86;
const STICKY_LIST_INDENT = 17;  // per nesting level
const STICKY_QUOTE_INDENT = 15;
const STICKY_MONO = "'Fira Code','Courier New',monospace";

// ── Colour helpers ───────────────────────────────────────
function hexToRgb(hex) {
  const m = String(hex).trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return { r: 245, g: 223, b: 143 };
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

// Blend a colour toward black (amount < 0) or white (amount > 0).
function shadeColor(hex, amount) {
  const { r, g, b } = hexToRgb(hex);
  const target = amount < 0 ? 0 : 255;
  const t = Math.abs(amount);
  const mix = (c) => Math.round(c + (target - c) * t);
  return `rgb(${mix(r)},${mix(g)},${mix(b)})`;
}

function withAlpha(hex, alpha) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

// Ink that stays readable on a given pad colour. The pads are pastels, so
// this almost always lands on the dark ink — but a user-restored note from a
// darker colour still gets legible text.
function stickyInk(bgColor) {
  const { r, g, b } = hexToRgb(bgColor);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.55 ? '#2b2723' : '#f4f1ea';
}

// Links need to read as links against the pad without shouting.
function stickyLinkColor(bgColor) {
  return stickyInk(bgColor) === '#2b2723' ? '#17518f' : '#9ecbff';
}

// ── Layout ───────────────────────────────────────────────
// Split obj.font ("18px 'Inter',sans-serif") back into its parts so the
// renderer can build bold / italic / heading variants of the same face.
function stickyFontParts(obj) {
  const match = /(\d+(?:\.\d+)?)px\s+(.+)$/.exec(obj.font || '');
  if (!match) return { size: 16, family: "'Courier New',monospace" };
  return { size: parseFloat(match[1]), family: match[2] };
}

// Per-block typography. Everything is derived from the note's base size so a
// note set in 30px keeps its proportions.
function stickyBlockStyle(block, base) {
  const style = {
    size: base,
    bold: false,
    italic: false,
    indent: 0,
    lineHeight: base * 1.45,
    spaceBefore: 0,
    muted: false
  };
  if (block.kind === 'heading') {
    const scale = [1.55, 1.28, 1.1][block.level - 1] || 1.1;
    style.size = base * scale;
    style.bold = true;
    style.lineHeight = style.size * 1.32;
    style.spaceBefore = base * 0.55;
  } else if (block.kind === 'bullet' || block.kind === 'ordered' || block.kind === 'task') {
    style.indent = STICKY_LIST_INDENT * (block.indent + 1);
  } else if (block.kind === 'quote') {
    style.italic = true;
    style.muted = true;
    style.indent = STICKY_QUOTE_INDENT;
  } else if (block.kind === 'rule') {
    style.lineHeight = base * 1.1;
  } else if (block.kind === 'blank') {
    style.lineHeight = base * 0.62;
  }
  return style;
}

// CSS font string for one inline chunk drawn in a given block style.
function stickyChunkFont(chunk, style, family) {
  const italic = (chunk.italic || style.italic) ? 'italic ' : '';
  const bold = (chunk.bold || style.bold) ? 'bold ' : '';
  const size = chunk.code ? style.size * 0.92 : style.size;
  return `${italic}${bold}${size}px ${chunk.code ? STICKY_MONO : family}`;
}

// Turn a note's Markdown into positioned rows plus the box size it needs.
// Rows are relative to the note's top-left corner, so moving a note never
// invalidates its layout.
//
//   { width, height, rows: [ { kind: 'line', y, x, pieces, marker, markerX, style }
//                          | { kind: 'rule', y } ] }
function layoutSticky(obj) {
  const { size: base, family } = stickyFontParts(obj);
  const blocks = parseMarkdownBlocks(obj.rawText || '');
  // A note the user has resized wraps to the width they gave it; one they
  // haven't sizes itself, up to the auto cap.
  const authoredWidth = obj.maxWidth
    ? Math.max(STICKY_MIN_WIDTH, Math.min(STICKY_RESIZE_MAX_WIDTH, obj.maxWidth))
    : 0;
  const maxContent = (authoredWidth || STICKY_MAX_WIDTH) - STICKY_PAD * 2;
  const context = canvasContext;
  const rows = [];
  let y = 0;
  let contentWidth = 0;
  let taskCount = 0;
  let taskDone = 0;

  context.save();
  blocks.forEach((block, blockIndex) => {
    const style = stickyBlockStyle(block, base);
    if (blockIndex > 0) y += style.spaceBefore;

    if (block.kind === 'blank') { y += style.lineHeight; return; }
    if (block.kind === 'rule') {
      rows.push({ kind: 'rule', y: y + style.lineHeight / 2 });
      y += style.lineHeight;
      contentWidth = Math.max(contentWidth, 60);
      return;
    }

    // The marker sits in the left gutter and the text hangs beside it, so a
    // wrapped bullet lines up under its own first line rather than the bullet.
    // A task reserves the same gutter for its checkbox.
    let markerWidth = 0;
    if (block.marker) {
      context.font = `${style.size}px ${family}`;
      markerWidth = context.measureText(block.marker + ' ').width;
    } else if (block.kind === 'task') {
      markerWidth = style.size * 1.32;
    }
    const textX = style.indent + markerWidth;
    const available = Math.max(40, maxContent - textX);

    // Break every chunk into words + the whitespace between them, keeping the
    // owning chunk so each word is measured in its own style.
    const words = [];
    for (const chunk of block.chunks) {
      for (const part of chunk.text.split(/(\s+)/)) {
        if (part) words.push({ text: part, chunk, isSpace: /^\s+$/.test(part) });
      }
    }

    // A ticked-off task is dimmed and struck through, so a list reads as
    // progress at a glance rather than as a wall of equal lines.
    const done = block.kind === 'task' && block.checked;
    if (block.kind === 'task') {
      taskCount++;
      if (block.checked) taskDone++;
    }

    let pieces = [];
    let lineWidth = 0;
    let emitted = false;
    const flushRow = () => {
      rows.push({
        kind: 'line',
        y,
        x: textX,
        pieces,
        marker: emitted ? null : (block.marker || null),
        // The source line travels with the box so a click can rewrite it.
        checkbox: (emitted || block.kind !== 'task') ? null
          : { checked: !!block.checked, line: block.line },
        markerX: style.indent,
        quote: block.kind === 'quote',
        muted: style.muted || done,
        strike: done,
        width: lineWidth,
        style
      });
      contentWidth = Math.max(contentWidth, textX + lineWidth);
      y += style.lineHeight;
      emitted = true;
      pieces = [];
      lineWidth = 0;
    };

    for (const word of words) {
      const font = stickyChunkFont(word.chunk, style, family);
      context.font = font;
      const width = context.measureText(word.text).width;

      // A token wider than the whole column (a URL, a hash) can never fit on
      // a row of its own, so it is broken between characters instead of being
      // left to run off the pad.
      if (!word.isSpace && width > available) {
        let rest = word.text;
        while (rest) {
          let fit = 1;
          while (fit < rest.length &&
                 lineWidth + context.measureText(rest.slice(0, fit + 1)).width <= available) fit++;
          const slice = rest.slice(0, fit);
          const sliceWidth = context.measureText(slice).width;
          if (pieces.length && lineWidth + sliceWidth > available) { flushRow(); continue; }
          pieces.push({ text: slice, x: lineWidth, width: sliceWidth, font, code: word.chunk.code, link: word.chunk.link });
          lineWidth += sliceWidth;
          rest = rest.slice(fit);
          if (rest) flushRow();
        }
        continue;
      }

      if (!word.isSpace && pieces.length && lineWidth + width > available) flushRow();
      if (!pieces.length && word.isSpace) continue;   // no leading space after a wrap
      pieces.push({ text: word.text, x: lineWidth, width, font, code: word.chunk.code, link: word.chunk.link });
      lineWidth += width;
    }
    if (pieces.length || !emitted) flushRow();
  });

  // A checklist gets a progress meter of its own. One lonely task doesn't
  // need a bar to explain itself, so it starts at two.
  if (taskCount >= 2) {
    y += base * 0.5;
    rows.push({ kind: 'progress', y, done: taskDone, total: taskCount, size: base });
    y += base * 0.85;
    contentWidth = Math.max(contentWidth, 150);
  }
  context.restore();

  const width = authoredWidth ||
    Math.max(STICKY_MIN_WIDTH, Math.min(STICKY_MAX_WIDTH, Math.ceil(contentWidth) + STICKY_PAD * 2));
  // The height the text actually needs — the floor a resize can never go below.
  const contentHeight = Math.max(STICKY_MIN_HEIGHT, Math.ceil(y) + STICKY_PAD * 2 + STICKY_FOLD * 0.25);
  const height = Math.max(contentHeight, obj.minHeight || 0);
  return { width, height, contentHeight, rows };
}

// Layout is pure given (rawText, font), so it is cached on the object and
// recomputed only when either changes. The cache is stripped before saving.
function getStickyLayout(obj) {
  const key = `${obj.font}|${obj.maxWidth || 0}|${obj.minHeight || 0}|${obj.rawText}`;
  if (!obj._layout || obj._layoutKey !== key) {
    obj._layout = layoutSticky(obj);
    obj._layoutKey = key;
  }
  return obj._layout;
}

// Recompute the cached box size after the text, font or colour changed.
function applyStickyMetrics(obj) {
  obj._layout = null;
  const layout = getStickyLayout(obj);
  obj.width = layout.width;
  obj.height = layout.height;
}

// Unlike text objects, which are measured again on every paint, a sticky
// keeps the box it was measured into. The toolbar fonts arrive from the
// network some time after the first paint, so a note laid out against the
// fallback face has to be re-measured once the real one lands — otherwise it
// wears a pad that no longer fits its own text.
function refreshStickyLayouts() {
  let found = false;
  for (const obj of history) {
    if (obj.type !== 'sticky') continue;
    applyStickyMetrics(obj);
    found = true;
  }
  if (found) fullRedraw();
}

if (document.fonts && document.fonts.addEventListener) {
  document.fonts.addEventListener('loadingdone', refreshStickyLayouts);
}

// ── Rendering ────────────────────────────────────────────
// The pad outline: a rectangle with the bottom-right corner cut away, so the
// fold triangle drawn over the cut reads as a lifted corner.
function stickyBodyPath(context, obj) {
  const { x, y, width: w, height: h } = obj;
  const fold = Math.min(STICKY_FOLD, w * 0.35, h * 0.35);
  context.beginPath();
  context.moveTo(x, y);
  context.lineTo(x + w, y);
  context.lineTo(x + w, y + h - fold);
  context.lineTo(x + w - fold, y + h);
  context.lineTo(x, y + h);
  context.closePath();
  return fold;
}

function drawSticky(context, obj) {
  const layout = getStickyLayout(obj);
  const ink = obj.color || stickyInk(obj.bgColor);
  const linkColor = stickyLinkColor(obj.bgColor);
  const family = stickyFontParts(obj).family;

  // Pad + drop shadow. The shadow is cleared before any text is drawn,
  // otherwise every glyph would get its own halo.
  context.save();
  context.shadowColor = 'rgba(0,0,0,0.28)';
  context.shadowBlur = 14;
  context.shadowOffsetY = 5;
  const fold = stickyBodyPath(context, obj);
  context.fillStyle = obj.bgColor;
  context.fill();
  context.restore();

  context.save();
  stickyBodyPath(context, obj);
  context.fillStyle = obj.bgColor;
  context.fill();
  context.strokeStyle = shadeColor(obj.bgColor, -0.12);
  context.lineWidth = 1;
  context.stroke();

  // The folded corner: a triangle in a darker shade of the pad.
  context.beginPath();
  context.moveTo(obj.x + obj.width - fold, obj.y + obj.height - fold);
  context.lineTo(obj.x + obj.width, obj.y + obj.height - fold);
  context.lineTo(obj.x + obj.width - fold, obj.y + obj.height);
  context.closePath();
  context.fillStyle = shadeColor(obj.bgColor, -0.16);
  context.fill();
  context.strokeStyle = shadeColor(obj.bgColor, -0.24);
  context.stroke();

  // Text. Everything below is clipped to the pad so a note that was resized
  // by a font change can never bleed onto the drawing around it.
  stickyBodyPath(context, obj);
  context.clip();
  context.textBaseline = 'top';

  const originX = obj.x + STICKY_PAD;
  const originY = obj.y + STICKY_PAD;
  for (const row of layout.rows) {
    if (row.kind === 'progress') {
      drawStickyProgress(context, originX, originY + row.y,
        obj.width - STICKY_PAD * 2, row, ink, family);
      continue;
    }
    if (row.kind === 'rule') {
      context.strokeStyle = withAlpha(ink, 0.22);
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(originX, originY + row.y);
      context.lineTo(obj.x + obj.width - STICKY_PAD, originY + row.y);
      context.stroke();
      continue;
    }

    const rowInk = row.muted ? withAlpha(ink, 0.62) : ink;

    // Blockquote bar, drawn once per wrapped row so it runs the full quote.
    if (row.quote) {
      context.fillStyle = withAlpha(ink, 0.28);
      context.fillRect(originX, originY + row.y, 2.5, row.style.lineHeight);
    }

    if (row.marker) {
      context.font = `${row.style.size}px ${family}`;
      context.fillStyle = withAlpha(ink, 0.7);
      context.fillText(row.marker, originX + row.markerX, originY + row.y);
    }

    if (row.checkbox) {
      // Hover is a live-cursor affordance, so it belongs on screen and not in
      // an export: only the on-screen context ever gets it.
      const hovered = context === canvasContext && stickyHoverTask &&
        stickyHoverTask.obj === obj && stickyHoverTask.line === row.checkbox.line;
      drawStickyCheckbox(context, originX + row.markerX, originY + row.y,
        row.style.size, row.checkbox.checked, ink, obj.bgColor, hovered);
    }

    for (const piece of row.pieces) {
      const px = originX + row.x + piece.x;
      const py = originY + row.y;
      if (piece.code) {
        // Subtle pill behind inline code, in the pad's own darker shade.
        context.fillStyle = withAlpha(ink, 0.09);
        context.fillRect(px - 2, py - 1, piece.width + 4, row.style.lineHeight * 0.92);
      }
      context.font = piece.font;
      if (piece.link && !row.muted) context.fillStyle = linkColor;
      else if (piece.code) context.fillStyle = withAlpha(ink, 0.85);
      else context.fillStyle = rowInk;
      context.fillText(piece.text, px, py);

      // Links are underlined as well as coloured: colour alone is not an
      // affordance for anyone who cannot separate these two hues.
      if (piece.link) {
        context.fillRect(px, py + row.style.size * 1.16, piece.width, Math.max(1, row.style.size / 16));
      }
    }

    // Strike a completed task through, across the whole row.
    if (row.strike && row.width > 0) {
      context.fillStyle = withAlpha(ink, 0.55);
      context.fillRect(originX + row.x, originY + row.y + row.style.size * 0.62,
        row.width, Math.max(1, row.style.size / 14));
    }
  }
  context.restore();
}

// A checkbox in the list gutter: a rounded square, ticked when done, and
// lifted on hover so it reads as something you can press.
function drawStickyCheckbox(context, x, y, size, checked, ink, bgColor, hovered) {
  const box = size * 0.82;
  const top = y + size * 0.22;
  const radius = box * 0.24;

  const boxPath = () => {
    context.beginPath();
    if (context.roundRect) context.roundRect(x, top, box, box, radius);
    else context.rect(x, top, box, box);   // older engines: square corners are fine
  };

  // Hover halo, drawn behind the box.
  if (hovered) {
    const pad = box * 0.34;
    context.beginPath();
    if (context.roundRect) {
      context.roundRect(x - pad, top - pad, box + pad * 2, box + pad * 2, radius + pad * 0.7);
    } else {
      context.rect(x - pad, top - pad, box + pad * 2, box + pad * 2);
    }
    context.fillStyle = withAlpha(ink, 0.12);
    context.fill();
  }

  boxPath();
  if (checked) {
    context.fillStyle = withAlpha(ink, hovered ? 0.86 : 0.76);
    context.fill();
  } else {
    context.fillStyle = withAlpha(ink, hovered ? 0.1 : 0.04);
    context.fill();
    context.strokeStyle = withAlpha(ink, hovered ? 0.75 : 0.45);
    context.lineWidth = Math.max(1, size / (hovered ? 11 : 14));
    context.stroke();
  }

  if (checked) {
    context.strokeStyle = bgColor;
    context.lineWidth = Math.max(1.4, size / 8);
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.beginPath();
    context.moveTo(x + box * 0.24, top + box * 0.52);
    context.lineTo(x + box * 0.44, top + box * 0.72);
    context.lineTo(x + box * 0.78, top + box * 0.28);
    context.stroke();
  }
}

// The checklist meter: a track, a fill, and a plain "3 / 5" to its right.
function drawStickyProgress(context, x, y, width, row, ink, family) {
  const size = row.size;
  const label = `${row.done} / ${row.total}`;
  context.font = `${size * 0.72}px ${family}`;
  const labelWidth = context.measureText(label).width;
  const trackWidth = Math.max(40, width - labelWidth - size * 0.6);
  const height = Math.max(3, size * 0.26);
  const radius = height / 2;
  const ratio = row.total ? row.done / row.total : 0;

  const track = (w) => {
    context.beginPath();
    if (context.roundRect) context.roundRect(x, y, w, height, radius);
    else context.rect(x, y, w, height);
    context.fill();
  };

  context.fillStyle = withAlpha(ink, 0.14);
  track(trackWidth);
  if (ratio > 0) {
    context.fillStyle = withAlpha(ink, ratio === 1 ? 0.78 : 0.5);
    track(Math.max(height, trackWidth * ratio));
  }

  context.fillStyle = withAlpha(ink, 0.62);
  context.textBaseline = 'middle';
  context.fillText(label, x + trackWidth + size * 0.6, y + height / 2);
  context.textBaseline = 'top';
}

// ── Hit-testing ──────────────────────────────────────────
// Topmost sticky under a point, or -1. Used by the double-click handler.
function hitTestSticky(worldPoint) {
  for (let i = history.length - 1; i >= 0; i--) {
    const obj = history[i];
    if (obj.type !== 'sticky') continue;
    if (worldPoint.x >= obj.x && worldPoint.x <= obj.x + obj.width &&
        worldPoint.y >= obj.y && worldPoint.y <= obj.y + obj.height) {
      return i;
    }
  }
  return -1;
}

// The link under a point, or null. A note is opaque: a point inside one never
// falls through to a link on a note below it.
function stickyLinkAt(worldPoint) {
  for (let i = history.length - 1; i >= 0; i--) {
    const obj = history[i];
    if (obj.type !== 'sticky') continue;
    if (worldPoint.x < obj.x || worldPoint.x > obj.x + obj.width ||
        worldPoint.y < obj.y || worldPoint.y > obj.y + obj.height) continue;

    const localX = worldPoint.x - (obj.x + STICKY_PAD);
    const localY = worldPoint.y - (obj.y + STICKY_PAD);
    for (const row of getStickyLayout(obj).rows) {
      if (row.kind !== 'line') continue;
      if (localY < row.y || localY > row.y + row.style.lineHeight) continue;
      for (const piece of row.pieces) {
        if (!piece.link) continue;
        const px = row.x + piece.x;
        if (localX >= px && localX <= px + piece.width) return piece.link;
      }
    }
    return null;
  }
  return null;
}

// ── Clickable task boxes ─────────────────────────────────
// A checkbox on the canvas is a real control: clicking it rewrites the `[ ]`
// on its own source line and nothing else, so the note's text stays the one
// source of truth and the change undoes like any other edit.
let stickyHoverTask = null;   // { obj, line } under the cursor, for the hover state

// The task box under a point, or null.
function stickyTaskAt(worldPoint) {
  for (let i = history.length - 1; i >= 0; i--) {
    const obj = history[i];
    if (obj.type !== 'sticky') continue;
    if (worldPoint.x < obj.x || worldPoint.x > obj.x + obj.width ||
        worldPoint.y < obj.y || worldPoint.y > obj.y + obj.height) continue;

    const localX = worldPoint.x - (obj.x + STICKY_PAD);
    const localY = worldPoint.y - (obj.y + STICKY_PAD);
    for (const row of getStickyLayout(obj).rows) {
      if (row.kind !== 'line' || !row.checkbox) continue;
      const size = row.style.size;
      const box = size * 0.82;
      const slack = box * 0.35;   // a comfortable target, not a pixel hunt
      const left = row.markerX - slack;
      const top = row.y + size * 0.22 - slack;
      if (localX >= left && localX <= left + box + slack * 2 &&
          localY >= top && localY <= top + box + slack * 2) {
        return { obj, line: row.checkbox.line, checked: row.checkbox.checked };
      }
    }
    return null;   // inside this note, but not on a box
  }
  return null;
}

// Flip `- [ ]` to `- [x]` (and back) on one line of a note's source.
function toggleStickyTask(obj, lineIndex) {
  const lines = String(obj.rawText || '').split('\n');
  const match = /^(\s*[-*+]\s+\[)([ xX])(\].*)$/.exec(lines[lineIndex] || '');
  if (!match) return false;

  const from = stickySnapshot(obj);
  lines[lineIndex] = match[1] + (match[2] === ' ' ? 'x' : ' ') + match[3];
  obj.rawText = lines.join('\n');
  applyStickyMetrics(obj);
  undoStack.push({ type: 'editSticky', obj, from, to: stickySnapshot(obj) });
  redoStack = [];
  syncUndoRedo();
  return true;
}

// Only schemes a canvas note has any business opening.
function openStickyLink(url) {
  if (!/^(https?:|mailto:)/i.test(url)) {
    flashStatus('Only http, https and mailto links can be opened');
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
  flashStatus('Opened ' + url);
}

// ── Resize handles ───────────────────────────────────────
// Eight handles on the selection box. Width is authored by the drag; height
// follows the text unless the drag asks for more room than the text needs.
const STICKY_HANDLES = [
  { id: 'nw', fx: 0,  fy: 0,  cursor: 'nwse-resize' },
  { id: 'n',  fx: .5, fy: 0,  cursor: 'ns-resize' },
  { id: 'ne', fx: 1,  fy: 0,  cursor: 'nesw-resize' },
  { id: 'e',  fx: 1,  fy: .5, cursor: 'ew-resize' },
  { id: 'se', fx: 1,  fy: 1,  cursor: 'nwse-resize' },
  { id: 's',  fx: .5, fy: 1,  cursor: 'ns-resize' },
  { id: 'sw', fx: 0,  fy: 1,  cursor: 'nesw-resize' },
  { id: 'w',  fx: 0,  fy: .5, cursor: 'ew-resize' }
];

let stickyResize = null;   // { obj, handle, start, startWorld, from, changed }

function stickyHandleAt(obj, worldPoint, screenTolerance) {
  const tolerance = (screenTolerance || 8) / viewScale;   // constant in screen pixels at any zoom
  for (const handle of STICKY_HANDLES) {
    const hx = obj.x + obj.width * handle.fx;
    const hy = obj.y + obj.height * handle.fy;
    if (Math.abs(worldPoint.x - hx) <= tolerance && Math.abs(worldPoint.y - hy) <= tolerance) {
      return handle;
    }
  }
  return null;
}

function drawStickyHandles(context, obj) {
  const size = 7 / viewScale;
  context.fillStyle = isDark ? '#161616' : '#ffffff';
  context.strokeStyle = isDark ? '#c8a96e' : '#8a6a2a';
  context.lineWidth = 1.5 / viewScale;
  for (const handle of STICKY_HANDLES) {
    const hx = obj.x + obj.width * handle.fx - size / 2;
    const hy = obj.y + obj.height * handle.fy - size / 2;
    context.fillRect(hx, hy, size, size);
    context.strokeRect(hx, hy, size, size);
  }
}

function beginStickyResize(obj, handle, worldPoint) {
  stickyResize = {
    obj,
    handle,
    start: { x: obj.x, y: obj.y, width: obj.width, height: obj.height },
    startWorld: { x: worldPoint.x, y: worldPoint.y },
    from: stickySnapshot(obj),
    changed: false
  };
  canvas.style.cursor = handle.cursor;
}

function updateStickyResize(worldPoint) {
  const { obj, handle, start, startWorld } = stickyResize;
  const dx = worldPoint.x - startWorld.x;
  const dy = worldPoint.y - startWorld.y;
  const west = handle.id.indexOf('w') !== -1;
  const east = handle.id.indexOf('e') !== -1;
  const north = handle.id.indexOf('n') !== -1;
  const south = handle.id.indexOf('s') !== -1;

  if (east || west) {
    const wanted = east ? start.width + dx : start.width - dx;
    obj.maxWidth = Math.max(STICKY_MIN_WIDTH, Math.min(STICKY_RESIZE_MAX_WIDTH, wanted));
  }
  if (north || south) {
    obj.minHeight = Math.max(STICKY_MIN_HEIGHT, south ? start.height + dy : start.height - dy);
  }

  // Re-wrap, then pin the edges the user is not dragging. The height that
  // comes back may be larger than asked for — the text sets the floor.
  applyStickyMetrics(obj);
  obj.x = west ? start.x + (start.width - obj.width) : start.x;
  obj.y = north ? start.y + (start.height - obj.height) : start.y;
  stickyResize.changed = true;
}

function endStickyResize() {
  if (!stickyResize) return;
  if (stickyResize.changed) {
    undoStack.push({
      type: 'editSticky',
      obj: stickyResize.obj,
      from: stickyResize.from,
      to: stickySnapshot(stickyResize.obj)
    });
    redoStack = [];
    syncUndoRedo();
  }
  stickyResize = null;
  canvas.style.cursor = CURSORS[tool];
  fullRedraw();
}

// ── Undo snapshots ───────────────────────────────────────
// One shape covers both edits and resizes: a resize moves the note when the
// drag is on a top or left handle, so position belongs in here too.
function stickySnapshot(obj) {
  return {
    x: obj.x,
    y: obj.y,
    rawText: obj.rawText,
    bgColor: obj.bgColor,
    color: obj.color,
    font: obj.font,
    width: obj.width,
    height: obj.height,
    maxWidth: obj.maxWidth,
    minHeight: obj.minHeight
  };
}

function applyStickySnapshot(obj, snap) {
  obj.x = snap.x;
  obj.y = snap.y;
  obj.rawText = snap.rawText;
  obj.bgColor = snap.bgColor;
  obj.color = snap.color;
  obj.font = snap.font;
  obj.width = snap.width;
  obj.height = snap.height;
  obj.maxWidth = snap.maxWidth;
  obj.minHeight = snap.minHeight;
  obj._layout = null;
}

// ── Editor overlay ───────────────────────────────────────
const stickyOverlay = document.getElementById('sticky-overlay');
const stickyEditor = document.getElementById('sticky-editor');
const stickyTextarea = document.getElementById('sticky-text');
const stickyHighlight = document.getElementById('sticky-highlight');
const stickyField = document.getElementById('sticky-field');
const stickySwatches = document.getElementById('sticky-swatches');
const stickyFontFamilySelect = document.getElementById('sticky-font-family');
const stickyFontSizeInput = document.getElementById('sticky-font-size');
const stickyGroup = document.getElementById('bc-sticky');

const STICKY_TEXTAREA_MAX_HEIGHT = 340;
const STICKY_PLACEHOLDER = '# Heading\n- a point worth keeping\n- [ ] a thing to do\n- [x] a thing done\n\n**bold**, *italic*, `code`, [a link](https://example.com)';

let stickyEditIndex = -1;     // history index being edited, -1 = new note
let stickyOrigin = null;      // world top-left for a new note; null = viewport centre
let stickyColor = STICKY_COLORS[0];
let stickyFont = null;        // base CSS font captured when the editor opened

// The button only makes sense with the Text tool, so it slides in and out with
// it exactly like the smart-stroke pair does for Draw.
function syncStickyButton() {
  if (stickyGroup) stickyGroup.classList.toggle('collapsed', tool !== 'text');
}

// The markup ships collapsed (Draw is the default tool); this keeps the two
// in step if that default ever changes.
syncStickyButton();

// Paint the editor chrome in the selected pad colour so the note you are
// typing looks like the note you are about to get.
function applyStickyEditorColor() {
  const ink = stickyInk(stickyColor);
  stickyEditor.style.setProperty('--sticky-bg', stickyColor);
  stickyEditor.style.setProperty('--sticky-ink', ink);
  stickyEditor.style.setProperty('--sticky-mark', withAlpha(ink, 0.42));
  stickyEditor.style.setProperty('--sticky-accent', shadeColor(stickyColor, -0.55));
  stickyEditor.style.setProperty('--sticky-edge', shadeColor(stickyColor, -0.14));
  stickyEditor.style.setProperty('--sticky-code', withAlpha(ink, 0.1));
  stickyEditor.style.setProperty('--sticky-link', stickyLinkColor(stickyColor));
  Array.from(stickySwatches.children).forEach((el) => {
    el.classList.toggle('on', el.dataset.color === stickyColor);
  });
}

function setStickyColor(color) {
  stickyColor = color;
  applyStickyEditorColor();
}

// ── Note font ────────────────────────────────────────────
// The editor is set in the face the note will use, so the choice is visible
// while typing. Its size is clamped to what a modal can hold — the note itself
// is drawn at the real value, however large.
const STICKY_PREVIEW_MIN = 11;
const STICKY_PREVIEW_MAX = 26;

function isMonospaceFamily(family) {
  return /monospace/i.test(family);
}

// Pull the font out of the editor controls and into stickyFont.
// normalize=true writes the clamped size back to the input (on change, not on
// every keystroke — clamping mid-typing fights the user).
function updateStickyFont(normalize) {
  // An out-of-range number is clamped; a blank or unparseable one falls back
  // to the default rather than being clamped up to the minimum.
  const parsed = parseInt(stickyFontSizeInput.value, 10);
  const size = Number.isFinite(parsed) ? Math.max(8, Math.min(120, parsed)) : 18;
  if (normalize) stickyFontSizeInput.value = size;
  stickyFont = `${size}px ${stickyFontFamilySelect.value}`;
  applyStickyEditorFont();
  renderStickyHighlight();
  autoResizeStickyTextarea();
}

// Point the editor controls at the font the note already carries.
function syncStickyFontControls() {
  const { size, family } = stickyFontParts({ font: stickyFont });
  const known = Array.from(stickyFontFamilySelect.options).some((opt) => opt.value === family);
  stickyFontFamilySelect.value = known ? family : stickyFontFamilySelect.options[0].value;
  stickyFontSizeInput.value = Math.round(size);
  stickyFont = `${Math.round(size)}px ${stickyFontFamilySelect.value}`;
  applyStickyEditorFont();
}

function applyStickyEditorFont() {
  const { size, family } = stickyFontParts({ font: stickyFont });
  const preview = Math.max(STICKY_PREVIEW_MIN, Math.min(STICKY_PREVIEW_MAX, size));
  stickyField.style.setProperty('--sticky-font', family);
  stickyField.style.setProperty('--sticky-font-size', preview + 'px');
  // Real bold and italic in the backdrop are only safe where the face
  // guarantees a constant advance width. In a proportional face emphasis is
  // shown in colour instead: colour cannot move a character, so it cannot
  // move the caret away from the glyphs it belongs to.
  stickyField.classList.toggle('mono', isMonospaceFamily(family));
}

// The pad colours, any colour the user has mixed since, and a + for the rest.
function renderStickySwatches() {
  stickySwatches.replaceChildren();

  for (const color of STICKY_COLORS.concat(customColors)) {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'sticky-swatch' + (color === stickyColor ? ' on' : '');
    swatch.dataset.color = color;
    swatch.style.background = color;
    swatch.title = color;
    swatch.setAttribute('aria-label', 'Pad colour ' + color);
    swatch.addEventListener('click', () => setStickyColor(color));
    stickySwatches.appendChild(swatch);
  }

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'sticky-swatch sticky-swatch-add';
  add.title = 'More colours';
  add.setAttribute('aria-label', 'More pad colours');
  add.textContent = '+';
  add.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isColorPickerOpen()) { closeColorPicker(); return; }
    openColorPicker(add, stickyColor, setStickyColor);
  });
  stickySwatches.appendChild(add);
}

renderStickySwatches();

// ── Editor syntax highlighting ───────────────────────────
// A backdrop div renders the same characters as the textarea, styled. The
// textarea keeps its own glyphs transparent and only shows the caret, so the
// two never disagree — which works because both are set in a monospace face
// whose bold and italic keep the regular advance width. Markers are dimmed
// rather than hidden, so every character still occupies its own cell and the
// caret lands exactly where the backdrop says it should.
function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function mark(text) {
  return `<span class="md-mark">${text}</span>`;
}

function highlightMarkdownLine(rawLine) {
  let line = escapeHtml(rawLine);

  // Block markers first, anchored to the line start, before any span exists.
  if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(rawLine)) return `<span class="md-rule">${line}</span>`;
  line = line.replace(/^(\s*)(#{1,6}\s+)(.*)$/, (m, pad, hashes, rest) =>
    `${pad}${mark(hashes)}<span class="md-heading">${rest}</span>`);
  line = line.replace(/^(\s*)(&gt;\s?)/, (m, pad, quote) => `${pad}${mark(quote)}`);
  // A task box is dimmed like any other marker, but a ticked one is tinted so
  // the done lines are findable while scanning the source.
  line = line.replace(/^(\s*)([-*+]\s)(\[[ xX]\]\s?)/, (m, pad, bullet, box) =>
    `${pad}${mark(bullet)}<span class="${/[xX]/.test(box) ? 'md-done' : 'md-mark'}">${box}</span>`);
  line = line.replace(/^(\s*)([-*+]\s)/, (m, pad, bullet) => `${pad}${mark(bullet)}`);
  line = line.replace(/^(\s*)(\d{1,9}[.)]\s)/, (m, pad, number) => `${pad}${mark(number)}`);

  // Links before emphasis, so a label can still carry **bold**; the target is
  // dimmed like a marker because it is addressing, not prose.
  line = line.replace(/\[([^\]\n]*)\]\(([^()\s]+)\)/g, (m, label, url) =>
    `${mark('[')}<span class="md-link">${label}</span>${mark('](')}` +
    `<span class="md-url">${url}</span>${mark(')')}`);
  // Bare URLs only outside the markup just inserted — hence the lookbehind.
  line = line.replace(/(?<![>\w"'=/])(https?:\/\/[^\s<>()[\]]+)/g, (m, url) =>
    `<span class="md-link">${url}</span>`);

  // Inline markers: the marker characters stay visible but dimmed, so the
  // column count of the line is unchanged.
  line = line.replace(/`([^`]+?)`/g, (m, body) => `${mark('`')}<code>${body}</code>${mark('`')}`);
  line = line.replace(/\*\*\*(\S(?:.*?\S)??)\*\*\*/g, (m, body) => `${mark('***')}<b><i>${body}</i></b>${mark('***')}`);
  line = line.replace(/\*\*(\S(?:.*?\S)??)\*\*/g, (m, body) => `${mark('**')}<b>${body}</b>${mark('**')}`);
  line = line.replace(/\*(\S(?:.*?\S)??)\*/g, (m, body) => `${mark('*')}<i>${body}</i>${mark('*')}`);
  return line;
}

function renderStickyHighlight() {
  const value = stickyTextarea.value;
  if (!value) {
    stickyHighlight.innerHTML = `<span class="md-placeholder">${escapeHtml(STICKY_PLACEHOLDER)}</span>`;
    return;
  }
  // The trailing newline keeps the backdrop as tall as the textarea when the
  // text ends on a line break.
  stickyHighlight.innerHTML = value.split('\n').map(highlightMarkdownLine).join('\n') + '\n';
}

function autoResizeStickyTextarea() {
  stickyTextarea.style.height = 'auto';
  const height = Math.min(STICKY_TEXTAREA_MAX_HEIGHT, Math.max(150, stickyTextarea.scrollHeight));
  stickyTextarea.style.height = height + 'px';
  stickyHighlight.style.height = height + 'px';
}

stickyTextarea.addEventListener('input', () => {
  renderStickyHighlight();
  autoResizeStickyTextarea();
});

// Keep the backdrop aligned once the text outgrows the box.
stickyTextarea.addEventListener('scroll', () => {
  stickyHighlight.scrollTop = stickyTextarea.scrollTop;
  stickyHighlight.scrollLeft = stickyTextarea.scrollLeft;
});

// On the overlay rather than the textarea, so the shortcuts still work while
// the font controls have focus.
stickyOverlay.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); closeStickyEditor(); }
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commitSticky(); }
});

// Clicking the dimmed backdrop discards, like Cancel — the pad itself keeps
// the click, so a stray click inside the editor never loses the text.
stickyOverlay.addEventListener('mousedown', (e) => {
  if (e.target === stickyOverlay) closeStickyEditor();
});

// ── Open / close / commit ────────────────────────────────
// index >= 0 edits that note; -1 creates a new one. origin is the world
// top-left for a new note (a file drop); omit it to centre in the viewport.
function openStickyEditor(index, origin) {
  commitText();
  hideTooltip();
  closeExportMenu();

  stickyOrigin = origin || null;
  if (index >= 0 && history[index] && history[index].type === 'sticky') {
    const obj = history[index];
    stickyEditIndex = index;
    stickyColor = obj.bgColor;
    stickyFont = obj.font;
    stickyTextarea.value = obj.rawText;
  } else {
    const style = getTextStyle();
    stickyEditIndex = -1;
    stickyFont = `${style.size}px ${style.family}`;
    stickyTextarea.value = '';
  }

  applyStickyEditorColor();
  syncStickyFontControls();
  renderStickyHighlight();
  stickyOverlay.classList.remove('hidden');
  autoResizeStickyTextarea();
  stickyTextarea.focus();
  stickyTextarea.setSelectionRange(stickyTextarea.value.length, stickyTextarea.value.length);
  fullRedraw();   // hide the note being edited while the overlay stands in for it
}

function closeStickyEditor() {
  stickyOverlay.classList.add('hidden');
  stickyEditIndex = -1;
  stickyOrigin = null;
  stickyTextarea.value = '';
  fullRedraw();
}

// Build a sticky object from raw Markdown and place it on the canvas.
// origin is the world top-left; omit it to centre the note in the viewport.
function createSticky(rawText, origin, color) {
  const style = getTextStyle();
  const bgColor = color || stickyColor;
  const obj = {
    type: 'sticky',
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    rawText,
    bgColor,
    color: stickyInk(bgColor),
    font: stickyFont || `${style.size}px ${style.family}`
  };
  applyStickyMetrics(obj);
  if (origin) {
    obj.x = origin.x;
    obj.y = origin.y;
  } else {
    obj.x = (canvasWrap.offsetWidth / 2 - panX) / viewScale - obj.width / 2;
    obj.y = (canvasWrap.offsetHeight / 2 - panY) / viewScale - obj.height / 2;
  }
  pushHistory(obj);
  return obj;
}

function commitSticky() {
  const rawText = stickyTextarea.value;
  const editIndex = stickyEditIndex;
  const origin = stickyOrigin;

  if (!rawText.trim()) {
    // An emptied note is a deleted note; a new empty one was never a note.
    if (editIndex >= 0 && history[editIndex]) {
      const obj = history[editIndex];
      history.splice(editIndex, 1);
      undoStack.push({ type: 'remove', obj });
      redoStack = [];
      syncUndoRedo();
    }
    closeStickyEditor();
    return;
  }

  let committed;
  if (editIndex >= 0 && history[editIndex] && history[editIndex].type === 'sticky') {
    const obj = history[editIndex];
    const from = stickySnapshot(obj);
    obj.rawText = rawText;
    obj.bgColor = stickyColor;
    obj.color = stickyInk(stickyColor);
    obj.font = stickyFont;
    applyStickyMetrics(obj);
    undoStack.push({ type: 'editSticky', obj, from, to: stickySnapshot(obj) });
    redoStack = [];
    syncUndoRedo();
    committed = obj;
  } else {
    committed = createSticky(rawText, origin);
  }

  closeStickyEditor();

  // Hand the finished note straight to the Select tool, already selected, so
  // its resize handles are under the cursor: sizing the pad is what you want
  // to do next, and it saves hunting for the note you just wrote.
  setTool('select');
  selectedIndex = history.indexOf(committed);
  fullRedraw();
}

// ── Drag & drop a Markdown / text file ───────────────────
// Dropping a file anywhere on the page would otherwise navigate away from the
// canvas, so every drag event is cancelled — a .md or .txt lands as a note,
// anything else is turned down with a message.
const STICKY_DROP_LIMIT = 100000;   // characters; a runaway file can't hang the layout

function isTextFile(file) {
  return /\.(md|markdown|mdown|txt|text)$/i.test(file.name) ||
         file.type === 'text/plain' || file.type === 'text/markdown';
}

function flashStatus(message) {
  statusBar.textContent = message;
  setTimeout(() => { statusBar.textContent = STATUSES[tool] || ''; }, 2600);
}

function setDropActive(active) {
  document.body.classList.toggle('file-drag', active);
}

['dragenter', 'dragover'].forEach((type) => {
  window.addEventListener(type, (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDropActive(true);
  });
});

window.addEventListener('dragleave', (e) => {
  // Only the drag actually leaving the window clears the highlight; moving
  // between elements fires dragleave constantly.
  if (e.relatedTarget === null) setDropActive(false);
});

window.addEventListener('drop', (e) => {
  if (!e.dataTransfer) return;
  e.preventDefault();
  setDropActive(false);

  const file = Array.from(e.dataTransfer.files || []).find(isTextFile);
  if (!file) {
    if (e.dataTransfer.files && e.dataTransfer.files.length) {
      flashStatus('Only .md and .txt files can be dropped — paste images with Ctrl+V');
    }
    return;
  }

  const rect = canvasWrap.getBoundingClientRect();
  const origin = toWorld(e.clientX - rect.left, e.clientY - rect.top);

  const reader = new FileReader();
  reader.onload = () => {
    let text = String(reader.result || '');
    const truncated = text.length > STICKY_DROP_LIMIT;
    if (truncated) text = text.slice(0, STICKY_DROP_LIMIT);
    if (!text.trim()) { flashStatus('That file is empty'); return; }
    createSticky(text, origin);
    fullRedraw();
    flashStatus(truncated
      ? `${file.name} added (truncated to ${STICKY_DROP_LIMIT.toLocaleString()} characters)`
      : `${file.name} added as a sticky note ✓`);
  };
  reader.onerror = () => flashStatus('Could not read that file');
  reader.readAsText(file);
});

// ── Paste image ───────────────────────────────────────────
document.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (!item.type.startsWith('image/')) continue;
    const url = URL.createObjectURL(item.getAsFile());
    const img = new Image();
    img.onload = () => {
      const cx = (canvasWrap.offsetWidth / 2 - panX) / viewScale;
      const cy = (canvasWrap.offsetHeight / 2 - panY) / viewScale;
      const scale = Math.min(img.width, 3000) / img.width;
      const w = img.width * scale;
      const h = img.height * scale;
      pushHistory({ type: 'image', img, x: cx - w / 2, y: cy - h / 2, w, h });
      URL.revokeObjectURL(url);
      fullRedraw();
      statusBar.textContent = 'Image pasted ✓';
      setTimeout(() => { statusBar.textContent = STATUSES[tool] || ''; }, 2000);
    };
    img.src = url;
    break;
  }
});

// ── Pointer events ────────────────────────────────────────
function getPointerCoords(e) {
  const rect = canvasWrap.getBoundingClientRect();
  return { sx: e.clientX - rect.left, sy: e.clientY - rect.top };
}

canvas.addEventListener('mousedown', (e) => {
  e.preventDefault();
  const { sx, sy } = getPointerCoords(e);
  const worldPoint = toWorld(sx, sy);

  if (e.button === 1 || (e.button === 0 && spaceDown)) {
    middleMouseDown = true;
    middleMouseStart = { ox: panX - e.clientX, oy: panY - e.clientY };
    canvas.style.cursor = 'grabbing';
    return;
  }
  if (e.button !== 0) return;

  if (textInput.style.display === 'block' && tool !== 'text') commitText();

  if (tool === 'select') {
    // A handle on the already-selected note wins over anything under it.
    const selected = selectedIndex !== -1 ? history[selectedIndex] : null;
    if (selected && selected.type === 'sticky') {
      const handle = stickyHandleAt(selected, worldPoint);
      if (handle) {
        beginStickyResize(selected, handle, worldPoint);
        return;
      }
    }
    const hit = hitTestAny(worldPoint);
    if (hit !== -1) {
      selectedIndex = hit;
      const obj = history[hit];
      dragMoveInfo = {
        index: hit,
        lastWorld: { x: worldPoint.x, y: worldPoint.y },
        startSnap: snapshotPosition(obj),
        moved: false
      };
      canvas.style.cursor = 'grabbing';
    } else {
      selectedIndex = -1;
    }
    fullRedraw();
  } else if (tool === 'pan') {
    isPanning = true;
    panStart = { ox: panX - e.clientX, oy: panY - e.clientY };
    canvas.style.cursor = 'grabbing';
  } else if (tool === 'draw' || tool === 'eraser') {
    startStroke(worldPoint);
  } else if (SHAPE_TOOLS.has(tool)) {
    shapeStart = worldPoint;
    shapeEnd = worldPoint;
  } else if (tool === 'text') {
    placeText(sx, sy);
  }
});

canvas.addEventListener('mousemove', (e) => {
  const { sx, sy } = getPointerCoords(e);
  const worldPoint = toWorld(sx, sy);
  if (middleMouseDown) {
    panX = e.clientX + middleMouseStart.ox;
    panY = e.clientY + middleMouseStart.oy;
    fullRedraw();
    return;
  }
  if (isPanning) {
    panX = e.clientX + panStart.ox;
    panY = e.clientY + panStart.oy;
    fullRedraw();
    return;
  }
  if (stickyResize) {
    updateStickyResize(worldPoint);
    fullRedraw();
    return;
  }
  if (dragMoveInfo) {
    const dx = worldPoint.x - dragMoveInfo.lastWorld.x;
    const dy = worldPoint.y - dragMoveInfo.lastWorld.y;
    if (dx !== 0 || dy !== 0) dragMoveInfo.moved = true;
    translateObject(history[dragMoveInfo.index], dx, dy);
    dragMoveInfo.lastWorld = { x: worldPoint.x, y: worldPoint.y };
    fullRedraw();
    return;
  }
  // Hover feedback with the select tool: resize handles take priority over
  // task boxes and links, which take priority over the plain arrow.
  if (tool === 'select') {
    const selected = selectedIndex !== -1 ? history[selectedIndex] : null;
    const handle = selected && selected.type === 'sticky' ? stickyHandleAt(selected, worldPoint) : null;
    const task = handle ? null : stickyTaskAt(worldPoint);
    canvas.style.cursor = handle ? handle.cursor
      : ((task || stickyLinkAt(worldPoint)) ? 'pointer' : CURSORS[tool]);

    // Repaint only when the hovered box actually changes.
    const wasHovering = stickyHoverTask;
    if (!task) stickyHoverTask = null;
    else if (!wasHovering || wasHovering.obj !== task.obj || wasHovering.line !== task.line) {
      stickyHoverTask = { obj: task.obj, line: task.line };
    }
    if ((wasHovering ? wasHovering.obj : null) !== (stickyHoverTask ? stickyHoverTask.obj : null) ||
        (wasHovering ? wasHovering.line : -1) !== (stickyHoverTask ? stickyHoverTask.line : -1)) {
      fullRedraw();
    }
  } else if (stickyHoverTask) {
    stickyHoverTask = null;
    fullRedraw();
  }
  if ((tool === 'draw' || tool === 'eraser') && isDrawing) continueStroke(worldPoint);
  if (tool === 'eraser' && !isDrawing) {
    // Track the hover point so renderFrame() draws the eraser cursor
    eraserHoverPoint = { x: worldPoint.x, y: worldPoint.y, w: computeStrokeWidth(0, brushSize) };
    fullRedraw();
  }
  if (SHAPE_TOOLS.has(tool) && shapeStart) {
    shapeEnd = worldPoint;
    fullRedraw();
  }
});

canvas.addEventListener('mouseup', (e) => {
  if (e.button === 1 || middleMouseDown) {
    middleMouseDown = false;
    canvas.style.cursor = CURSORS[tool];
    return;
  }
  if (e.button !== 0) return;
  const { sx, sy } = getPointerCoords(e);
  const worldPoint = toWorld(sx, sy);
  if (stickyResize) {
    endStickyResize();
  } else if (isPanning) {
    isPanning = false;
    canvas.style.cursor = CURSORS[tool];
  } else if (dragMoveInfo) {
    if (dragMoveInfo.moved) {
      const obj = history[dragMoveInfo.index];
      const endSnap = snapshotPosition(obj);
      undoStack.push({ type: 'move', obj, from: dragMoveInfo.startSnap, to: endSnap });
      redoStack = [];
      syncUndoRedo();
    } else {
      // A click that never moved: a task box takes it, otherwise a link.
      const task = stickyTaskAt(worldPoint);
      if (task) {
        if (toggleStickyTask(task.obj, task.line)) fullRedraw();
      } else {
        const url = stickyLinkAt(worldPoint);
        if (url) openStickyLink(url);
      }
    }
    dragMoveInfo = null;
    canvas.style.cursor = CURSORS[tool];
  } else if (tool === 'draw' || tool === 'eraser') {
    endStroke(worldPoint);
  } else if (SHAPE_TOOLS.has(tool) && shapeStart) {
    shapeEnd = worldPoint;
    commitShape();
  }
});

canvas.addEventListener('mouseleave', (e) => {
  const { sx, sy } = getPointerCoords(e);
  const worldPoint = toWorld(sx, sy);
  // Commit a resize that runs off the edge of the canvas
  if (stickyResize) endStickyResize();
  if (stickyHoverTask) { stickyHoverTask = null; fullRedraw(); }
  if ((tool === 'draw' || tool === 'eraser') && isDrawing) endStroke(worldPoint);
  // Clear eraser hover preview
  if (tool === 'eraser' && !isDrawing) { eraserHoverPoint = null; fullRedraw(); }
  if (SHAPE_TOOLS.has(tool) && shapeStart) {
    shapeStart = null;
    shapeEnd = null;
    fullRedraw();
  }
  // If a move-drag is in progress, commit it on mouseleave
  if (dragMoveInfo) {
    if (dragMoveInfo.moved) {
      const obj = history[dragMoveInfo.index];
      const endSnap = snapshotPosition(obj);
      undoStack.push({ type: 'move', obj, from: dragMoveInfo.startSnap, to: endSnap });
      redoStack = [];
      syncUndoRedo();
    }
    dragMoveInfo = null;
    canvas.style.cursor = CURSORS[tool];
  }
  middleMouseDown = false;
});

canvasWrap.addEventListener('mousedown', (e) => {
  if (e.target !== textInput && activeTextNode && !justPlacedText) commitText();
});

// ── Double-click to edit text / sticky notes ───────────
canvas.addEventListener('dblclick', (e) => {
  e.preventDefault();
  const { sx, sy } = getPointerCoords(e);
  const worldPoint = toWorld(sx, sy);

  // Whichever of the two sits higher in the stack wins the double-click.
  const stickyIndex = hitTestSticky(worldPoint);
  const textIndex = hitTestText(worldPoint);
  const index = Math.max(stickyIndex, textIndex);
  if (index === -1) return;

  // Remove trivial click artifacts (dots, zero-size shapes) from the preceding clicks
  let removed = 0;
  while (removed < 2 && history.length > 0) {
    if (isTrivialAction(history[history.length - 1])) {
      const obj = history.pop();
      undoStack.push({ type: 'remove', obj });
      removed++;
    } else break;
  }
  if (removed > 0) { redoStack = []; syncUndoRedo(); }

  shapeStart = null;
  shapeEnd = null;
  if (index === stickyIndex) openStickyEditor(index);
  else editText(index);
});

// ── Scroll zoom ───────────────────────────────────────────
canvasWrap.addEventListener('wheel', (e) => {
  e.preventDefault();
  const { sx, sy } = getPointerCoords(e);
  const factor = e.deltaY < 0 ? 1.07 : 1 / 1.07;
  const newScale = Math.max(0.04, Math.min(10, viewScale * factor));
  panX = sx - (sx - panX) * (newScale / viewScale);
  panY = sy - (sy - panY) * (newScale / viewScale);
  viewScale = newScale;
  fullRedraw();
}, { passive: false });

// ── Keyboard ──────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  // Ignore keystrokes while any text field is focused (text overlay, canvas
  // name, font size) so typing there doesn't switch tools or nudge objects.
  const target = e.target;
  if (target === textInput || target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' ||
      target.isContentEditable) {
    return;
  }

  // Undo / Redo
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'z') { e.preventDefault(); undo(); bcFlashButton('undo-button'); return; }
  if ((e.ctrlKey || e.metaKey) && e.key === 'y') { e.preventDefault(); redo(); bcFlashButton('redo-button'); return; }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'Z') { e.preventDefault(); redo(); bcFlashButton('redo-button'); return; }

  if (e.ctrlKey || e.metaKey) return; // don't steal other ctrl shortcuts

  if (e.code === 'Space') {
    e.preventDefault();
    spaceDown = true;
    if (!isPanning && !middleMouseDown) canvas.style.cursor = 'grab';
  }
  if (e.key === 'v') setTool('select');
  if (e.key === 'd') setTool('draw');
  if (e.key === 'e') setTool('eraser');
  if (e.key === 'a') setTool('arrow');
  if (e.key === 'l') setTool('line');
  if (e.key === 'r') setTool('rect');
  if (e.key === 'c') setTool('circle');
  if (e.key === 't') setTool('text');
  if (e.key === 'p') setTool('pan');

  // Sticky notes are Text-tool only, mirroring their button in the bottom bar.
  if (e.key === 'n' && tool === 'text') {
    e.preventDefault();
    bcFlashButton('btn-sticky-note');
    openStickyEditor(-1);
  }

  // Smart stroke modes are Draw-tool only; the shortcuts are inert elsewhere.
  if (e.key === 's' && tool === 'draw') {
    toggleSmartStroke();
    bcFlashButton('btn-smart-stroke');
  }
  if (e.key === 'S' && tool === 'draw') {
    toggleSmartStroke2();
    bcFlashButton('btn-smart-stroke-2');
  }

  // Select tool: Delete / Backspace removes the selected object
  if ((e.key === 'Delete' || e.key === 'Backspace') && tool === 'select' && selectedIndex !== -1) {
    e.preventDefault();
    const obj = history[selectedIndex];
    history.splice(selectedIndex, 1);
    undoStack.push({ type: 'remove', obj });
    redoStack = [];
    selectedIndex = -1;
    syncUndoRedo();
    fullRedraw();
  }

  // Select tool: Arrow keys nudge the selected object (1px, or 10px with Shift)
  if (tool === 'select' && selectedIndex !== -1 &&
      (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    let dx = 0, dy = 0;
    if (e.key === 'ArrowLeft') dx = -step;
    if (e.key === 'ArrowRight') dx = step;
    if (e.key === 'ArrowUp') dy = -step;
    if (e.key === 'ArrowDown') dy = step;
    const obj = history[selectedIndex];
    const fromSnap = snapshotPosition(obj);
    translateObject(obj, dx, dy);
    const toSnap = snapshotPosition(obj);
    undoStack.push({ type: 'move', obj, from: fromSnap, to: toSnap });
    redoStack = [];
    syncUndoRedo();
    fullRedraw();
  }
});

document.addEventListener('keyup', (e) => {
  if (e.code === 'Space') {
    spaceDown = false;
    middleMouseDown = false;
    canvas.style.cursor = CURSORS[tool];
  }
});

// ── Zoom buttons ──────────────────────────────────────────
function adjustZoom(delta) {
  const cx = canvasWrap.offsetWidth / 2;
  const cy = canvasWrap.offsetHeight / 2;
  const newScale = Math.max(0.04, Math.min(10, viewScale + delta));
  panX = cx - (cx - panX) * (newScale / viewScale);
  panY = cy - (cy - panY) * (newScale / viewScale);
  viewScale = newScale;
  fullRedraw();
}

// ── Bottom controls: proximity-aware collapsible bar ──────
//
// The secondary group (undo/redo/theme) collapses during active drawing
// and expands when the mouse approaches the bottom-right corner or when
// a keyboard shortcut (Ctrl+Z / Ctrl+Y) is used. This keeps the canvas
// clean during creative work while keeping all controls one gesture away.
const bcSecondary = document.getElementById('bc-secondary');
const bottomControls = document.getElementById('bottom-controls');
let bcExpanded = true;
let bcCollapseTimer = null;
const BC_PROXIMITY_RIGHT = 260;  // px from right screen edge
const BC_PROXIMITY_BOTTOM = 110; // px from bottom screen edge
const BC_COLLAPSE_DELAY = 400;   // ms grace period before collapsing

function bcSetExpanded(expanded) {
  if (expanded === bcExpanded) return;
  bcExpanded = expanded;
  bcSecondary.classList.toggle('collapsed', !expanded);
  if (!expanded) hideTooltip(); // don't leave a bubble pointing at a hidden button
}

// Returns true if the user is actively interacting with the canvas
// (drawing, panning, dragging an object, or mid-shape).
function bcIsInteracting() {
  return isDrawing || isPanning || dragMoveInfo !== null || shapeStart !== null;
}

// Called on every mousemove anywhere in the document.
function bcCheckProximity(clientX, clientY) {
  // During active canvas interaction, force-collapse and bail.
  // The user can't click buttons mid-stroke anyway.
  if (bcIsInteracting()) {
    if (bcCollapseTimer) { clearTimeout(bcCollapseTimer); bcCollapseTimer = null; }
    bcSetExpanded(false);
    return;
  }

  // Check if mouse is inside the proximity zone (bottom-right corner)
  const winW = window.innerWidth;
  const winH = window.innerHeight;
  const inZone = (winW - clientX) < BC_PROXIMITY_RIGHT &&
                 (winH - clientY) < BC_PROXIMITY_BOTTOM;

  // Also check if hovering directly over the bar itself
  const rect = bottomControls.getBoundingClientRect();
  const onBar = clientX >= rect.left && clientX <= rect.right &&
                clientY >= rect.top && clientY <= rect.bottom;

  if (inZone || onBar) {
    // Cancel any pending collapse and expand immediately
    if (bcCollapseTimer) { clearTimeout(bcCollapseTimer); bcCollapseTimer = null; }
    bcSetExpanded(true);
  } else {
    // Schedule a delayed collapse (prevents flicker on quick pass-throughs)
    if (!bcCollapseTimer) {
      bcCollapseTimer = setTimeout(() => {
        bcCollapseTimer = null;
        bcSetExpanded(false);
      }, BC_COLLAPSE_DELAY);
    }
  }
}

// Flash a button with a glowing ring — used when undo/redo is triggered
// via keyboard so the user sees which action fired.
function bcFlashButton(buttonId) {
  // Force-expand so the button is visible during the flash
  if (bcCollapseTimer) { clearTimeout(bcCollapseTimer); bcCollapseTimer = null; }
  bcSetExpanded(true);

  const btn = document.getElementById(buttonId);
  if (!btn) return;
  // Restart the animation by toggling the class
  btn.classList.remove('keyflash');
  void btn.offsetWidth; // force reflow to restart animation
  btn.classList.add('keyflash');
  setTimeout(() => btn.classList.remove('keyflash'), 700);

  // Auto-collapse after the flash if the mouse isn't in the zone
  bcCollapseTimer = setTimeout(() => {
    bcCollapseTimer = null;
    bcSetExpanded(false);
  }, 1800);
}

// Track mouse position globally for proximity detection
document.addEventListener('mousemove', (e) => {
  bcCheckProximity(e.clientX, e.clientY);
}, { passive: true });

// Force-collapse the moment a canvas interaction begins
canvas.addEventListener('pointerdown', () => {
  if (bcCollapseTimer) { clearTimeout(bcCollapseTimer); bcCollapseTimer = null; }
  bcSetExpanded(false);
  hideTooltip();
}, { capture: true, passive: true });

// ── Reset ─────────────────────────────────────────────────
function resetCanvas() {
  if (!confirm('Clear everything?')) return;
  commitText();
  history = [];
  undoStack = [];
  redoStack = [];
  selectedIndex = -1;
  dragMoveInfo = null;
  stickyResize = null;
  shapeStart = null;
  shapeEnd = null;
  eraserUndoEntries = [];
  syncUndoRedo();
  viewScale = 1;
  initCanvasView();
}

// ── Export dropdown ───────────────────────────────────────
const exportDropdown = document.querySelector('.export-dropdown');
const exportMenu = document.getElementById('export-menu');

function toggleExportMenu(e) {
  e.stopPropagation();
  const willOpen = !exportDropdown.classList.contains('open');
  if (willOpen) {
    // Position the menu below the button using fixed coordinates so it
    // escapes the toolbar's overflow clipping and overlays the canvas.
    const rect = document.getElementById('export-toggle').getBoundingClientRect();
    exportMenu.style.left = (rect.right - 150) + 'px';   // right-align to button
    exportMenu.style.top = (rect.bottom + 4) + 'px';      // 4px gap below button
  }
  exportDropdown.classList.toggle('open', willOpen);
}

function closeExportMenu() {
  exportDropdown.classList.remove('open');
}

// Close the menu when clicking anywhere outside of it
document.addEventListener('click', (e) => {
  if (!exportDropdown.contains(e.target)) closeExportMenu();
});

// Close on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeExportMenu();
});

// ── Info card ─────────────────────────────────────────────
const infoCard = document.getElementById('info-card');
const infoName = document.getElementById('info-name');
const infoStarted = document.getElementById('info-started');
const infoToggle = document.getElementById('info-toggle');

let canvasName = '';
let canvasStartTime = new Date();

function formatDateTime(date) {
  return date.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

function toggleInfoCard(e) {
  e.stopPropagation();
  const willOpen = !infoCard.classList.contains('open');
  infoCard.classList.toggle('open', willOpen);
  infoToggle.classList.toggle('on', willOpen);
  if (willOpen) {
    infoName.value = canvasName;
    infoStarted.textContent = formatDateTime(canvasStartTime);
    setTimeout(() => infoName.focus(), 0);
  }
}

function closeInfoCard() {
  infoCard.classList.remove('open');
  infoToggle.classList.remove('on');
}

// Save the name and close when focus leaves the name field
infoName.addEventListener('blur', () => {
  canvasName = infoName.value.trim();
  scheduleSave();
  closeInfoCard();
});

// Enter also saves and closes
infoName.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); infoName.blur(); }
  if (e.key === 'Escape') { e.preventDefault(); infoName.value = canvasName; infoName.blur(); }
});

// Close the info card when clicking anywhere outside of it
document.addEventListener('click', (e) => {
  if (infoCard.classList.contains('open') &&
      !infoCard.contains(e.target) &&
      !infoToggle.contains(e.target)) {
    canvasName = infoName.value.trim();
    scheduleSave();
    closeInfoCard();
  }
});

// Close on Escape (only when name field isn't focused — that has its own handler)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.activeElement !== infoName) closeInfoCard();
});

// ── Export PNG ────────────────────────────────────────────
// ── Shared render-to-canvas helper ───────────────────────

// Build a filename in the format: mm-dd-yyyy-hh-mm-<name>.png
// If the user hasn't named the canvas, pick a random word + 3-digit number.
function buildExportFilename() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${now.getFullYear()}-${pad(now.getHours())}-${pad(now.getMinutes())}`;
  let name = canvasName.trim();
  if (!name) {
    const word = FALLBACK_WORDS[Math.floor(Math.random() * FALLBACK_WORDS.length)];
    const num = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
    name = `${word}-${num}`;
  }
  // Sanitize: keep alphanumerics and dashes only
  name = name.replace(/[^a-zA-Z0-9-]/g, '').replace(/-+/g, '-');
  if (!name) name = 'untitled';
  return `${stamp}-${name}.png`;
}

function renderToCanvas(scale) {
  commitText();
  const exportWidth = canvasWrap.offsetWidth * scale;
  const exportHeight = canvasWrap.offsetHeight * scale;
  const exportCanvas = document.createElement('canvas');
  exportCanvas.width = exportWidth;
  exportCanvas.height = exportHeight;
  const exportContext = exportCanvas.getContext('2d');
  exportContext.fillStyle = isDark ? '#0e0e0e' : '#f5f3ef';
  exportContext.fillRect(0, 0, exportWidth, exportHeight);
  exportContext.save();
  exportContext.translate(panX * scale, panY * scale);
  exportContext.scale(viewScale * scale, viewScale * scale);
  for (const obj of history) drawObject(exportContext, obj);
  exportContext.restore();
  return exportCanvas;
}

function exportPNG() {
  closeExportMenu();
  const exportCanvas = renderToCanvas(2);
  const a = document.createElement('a');
  a.download = buildExportFilename();
  a.href = exportCanvas.toDataURL('image/png');
  a.click();
}

function exportPDF() {
  closeExportMenu();
  // Use the canvas as an image embedded in a PDF via a data URI.
  // We use the browser's print dialog pointed at a minimal HTML page
  // that contains the canvas image sized to fill the page — no library needed.
  const exportCanvas = renderToCanvas(2);
  const imgData = exportCanvas.toDataURL('image/png');
  const width = canvasWrap.offsetWidth;
  const height = canvasWrap.offsetHeight;
  const isLandscape = width >= height;
  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>coredraft</title>
<style>
  @page { size: ${isLandscape ? 'A4 landscape' : 'A4 portrait'}; margin: 0; }
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { width:100%; height:100%; background:${isDark ? '#0e0e0e' : '#f5f3ef'}; }
  img { width:100%; height:100%; object-fit:contain; display:block; }
</style>
</head>
<body>
<img src="${imgData}">
<script>
  window.onload = function() {
    setTimeout(function(){ window.print(); window.close(); }, 400);
  };
<\/script>
</body>
</html>`;
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const win = window.open(url, '_blank', 'width=900,height=700');
  if (!win) {
    alert('Please allow popups to export PDF.');
    URL.revokeObjectURL(url);
    return;
  }
  win.onbeforeunload = () => URL.revokeObjectURL(url);
}

// ── Touch ─────────────────────────────────────────────────
let lastTouchDistance = null;

canvas.addEventListener('touchstart', (e) => {
  e.preventDefault();
  if (e.touches.length === 2) {
    lastTouchDistance = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
    return;
  }
  const touch = e.touches[0];
  const { sx, sy } = getPointerCoords(touch);
  const worldPoint = toWorld(sx, sy);

  if (tool === 'select') {
    // Fingers are blunter than a mouse, so the handles get a wider target.
    const selected = selectedIndex !== -1 ? history[selectedIndex] : null;
    if (selected && selected.type === 'sticky') {
      const handle = stickyHandleAt(selected, worldPoint, 18);
      if (handle) {
        beginStickyResize(selected, handle, worldPoint);
        return;
      }
    }
    const hit = hitTestAny(worldPoint);
    if (hit !== -1) {
      selectedIndex = hit;
      const obj = history[hit];
      dragMoveInfo = {
        index: hit,
        lastWorld: { x: worldPoint.x, y: worldPoint.y },
        startSnap: snapshotPosition(obj),
        moved: false
      };
    } else {
      selectedIndex = -1;
    }
    fullRedraw();
  } else if (tool === 'draw' || tool === 'eraser') {
    startStroke(worldPoint);
  } else if (SHAPE_TOOLS.has(tool)) {
    shapeStart = worldPoint;
    shapeEnd = worldPoint;
  }
}, { passive: false });

canvas.addEventListener('touchmove', (e) => {
  e.preventDefault();
  if (e.touches.length === 2) {
    const distance = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
    if (lastTouchDistance) {
      const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const my = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      const newScale = Math.max(0.04, Math.min(10, viewScale * distance / lastTouchDistance));
      panX = mx - (mx - panX) * (newScale / viewScale);
      panY = my - (my - panY) * (newScale / viewScale);
      viewScale = newScale;
      fullRedraw();
    }
    lastTouchDistance = distance;
    return;
  }
  const touch = e.touches[0];
  const { sx, sy } = getPointerCoords(touch);
  const worldPoint = toWorld(sx, sy);
  if (stickyResize) {
    updateStickyResize(worldPoint);
    fullRedraw();
    return;
  }
  if (dragMoveInfo) {
    const dx = worldPoint.x - dragMoveInfo.lastWorld.x;
    const dy = worldPoint.y - dragMoveInfo.lastWorld.y;
    if (dx !== 0 || dy !== 0) dragMoveInfo.moved = true;
    translateObject(history[dragMoveInfo.index], dx, dy);
    dragMoveInfo.lastWorld = { x: worldPoint.x, y: worldPoint.y };
    fullRedraw();
    return;
  }
  if (tool === 'draw' || tool === 'eraser') continueStroke(worldPoint);
  else if (SHAPE_TOOLS.has(tool) && shapeStart) { shapeEnd = worldPoint; fullRedraw(); }
}, { passive: false });

canvas.addEventListener('touchend', (e) => {
  lastTouchDistance = null;
  if (!e.changedTouches.length) return;
  const touch = e.changedTouches[0];
  const { sx, sy } = getPointerCoords(touch);
  const worldPoint = toWorld(sx, sy);
  if (stickyResize) {
    endStickyResize();
  } else if (dragMoveInfo) {
    if (dragMoveInfo.moved) {
      const obj = history[dragMoveInfo.index];
      const endSnap = snapshotPosition(obj);
      undoStack.push({ type: 'move', obj, from: dragMoveInfo.startSnap, to: endSnap });
      redoStack = [];
      syncUndoRedo();
    } else {
      const task = stickyTaskAt(worldPoint);
      if (task) {
        if (toggleStickyTask(task.obj, task.line)) fullRedraw();
      } else {
        const url = stickyLinkAt(worldPoint);
        if (url) openStickyLink(url);
      }
    }
    dragMoveInfo = null;
  } else if (tool === 'draw' || tool === 'eraser') {
    endStroke(worldPoint);
  } else if (SHAPE_TOOLS.has(tool) && shapeStart) {
    shapeEnd = worldPoint;
    commitShape();
  }
});

// ════════════════════════════════════════════════════════
// PERSISTENCE (IndexedDB auto-save)
// ════════════════════════════════════════════════════════
// The entire canvas state — every object, the viewport, theme, and
// metadata — is serialized to IndexedDB so the user's latest draft is
// always recovered after a refresh, tab close, or browser crash.
//
// Images are stored as data URLs (base64 PNG) alongside their geometry.
// On load they are decoded back into HTMLImageElement objects before the
// next redraw, so the rest of the app treats them identically to pasted images.

const DB_NAME = 'coredraft';
const DB_VERSION = 1;
const STORE_NAME = 'state';
const SAVE_KEY = 'current';
const SAVE_DELAY_MS = 800;   // debounce: coalesce rapid edits into one write

let saveTimer = null;

// Open (and upgrade if needed) the IndexedDB database.
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);   // key-value store; we use put(value, key)
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Render an HTMLImageElement to a PNG data URL. If the image hasn't
// finished loading (or is cross-origin-tainted), fall back to its src.
function imageToDataURL(img) {
  try {
    const tmp = document.createElement('canvas');
    tmp.width = img.naturalWidth || img.width;
    tmp.height = img.naturalHeight || img.height;
    tmp.getContext('2d').drawImage(img, 0, 0);
    return tmp.toDataURL('image/png');
  } catch (e) {
    return img.src || '';
  }
}

// Decode a data URL back into an HTMLImageElement.
function loadImageFromDataURL(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(new Image());   // resolve empty on failure; drawObject guards null
    img.src = dataUrl;
  });
}

// Convert a single history object into a JSON-safe representation.
// Only images need special handling (HTMLImageElement -> data URL).
function serializeObject(obj) {
  if (obj.type === 'image' && obj.img) {
    const copy = Object.assign({}, obj);
    copy.dataUrl = imageToDataURL(obj.img);
    delete copy.img;
    return copy;
  }
  if (obj.type === 'sticky') {
    // The cached layout is derived from rawText + font; storing it would only
    // bloat the record and risk restoring a stale one.
    const copy = Object.assign({}, obj);
    delete copy._layout;
    delete copy._layoutKey;
    return copy;
  }
  return obj;
}

// Convert a serialized object back into its live form.
// Images are decoded asynchronously; the object is returned immediately
// and its img property is populated once decoding completes.
function deserializeObject(obj) {
  if (obj.type === 'image' && obj.dataUrl) {
    const dataUrl = obj.dataUrl;
    const copy = Object.assign({}, obj);
    delete copy.dataUrl;
    copy.img = null;
    loadImageFromDataURL(dataUrl).then((img) => {
      copy.img = img;
      fullRedraw();
    });
    return copy;
  }
  return obj;
}

// Serialize the full document state into a JSON-safe object.
function serializeState() {
  return {
    version: DB_VERSION,
    savedAt: Date.now(),
    objects: history.map(serializeObject),
    view: { panX, panY, viewScale },
    theme: { isDark },
    palette: { custom: customColors.slice() },
    meta: { canvasName, startTime: canvasStartTime.getTime() }
  };
}

// Restore the full document state from a saved object.
function deserializeState(state) {
  history = state.objects.map(deserializeObject);
  undoStack = [];
  redoStack = [];
  selectedIndex = -1;
  stickyEditIndex = -1;
  dragMoveInfo = null;
  stickyResize = null;
  shapeStart = null;
  shapeEnd = null;

  if (state.view) {
    panX = state.view.panX;
    panY = state.view.panY;
    viewScale = state.view.viewScale;
  }
  if (state.theme && typeof state.theme.isDark === 'boolean') {
    isDark = state.theme.isDark;
    document.documentElement.classList.toggle('light', !isDark);
  }
  if (state.palette && Array.isArray(state.palette.custom)) {
    // A document saved when the cap was higher keeps its most recent few.
    customColors = state.palette.custom.slice(-MAX_CUSTOM_COLORS);
    renderPalette();
    renderStickySwatches();
  }
  if (state.meta) {
    canvasName = state.meta.canvasName || '';
    canvasStartTime = state.meta.startTime ? new Date(state.meta.startTime) : new Date();
  }
}

// Save the current state to IndexedDB (debounced).
// No-ops silently if IndexedDB is unavailable (private mode, old browser, etc.).
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow().catch(() => { /* storage unavailable — ignore */ });
  }, SAVE_DELAY_MS);
}

function saveNow() {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(serializeState(), SAVE_KEY);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  }));
}

// Load the saved state from IndexedDB. Returns the state object or null.
function loadState() {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(SAVE_KEY);
    req.onsuccess = () => { db.close(); resolve(req.result || null); };
    req.onerror = () => { db.close(); reject(req.error); };
  }));
}

// Flush any pending debounced save immediately (used on tab close / hide).
function flushSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    return saveNow().catch(() => {});
  }
  return Promise.resolve();
}

// ── Boot ──────────────────────────────────────────────────
(async function boot() {
  let restored = false;
  try {
    const state = await loadState();
    if (state && state.objects) {
      deserializeState(state);
      restored = true;
    }
  } catch (e) {
    // IndexedDB unavailable — start fresh
  }

  resizeCanvas();
  if (!restored) {
    // No saved draft: centre the default viewport
    viewScale = 1;
    panX = canvasWrap.offsetWidth / 2;
    panY = canvasWrap.offsetHeight / 2;
  }
  syncUndoRedo();
  fullRedraw();

  // Restored notes were measured in an earlier session, possibly before its
  // web fonts had loaded; re-measure them once this session's fonts are in.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(refreshStickyLayouts).catch(() => {});
  }

  // Persist on tab close / page hide so the latest state is always saved
  window.addEventListener('beforeunload', flushSave);
  window.addEventListener('pagehide', flushSave);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSave();
  });
})();
