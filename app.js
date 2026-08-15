/* ============================================================
   coredraft — application logic
   ============================================================ */

const devicePixelRatio = window.devicePixelRatio || 1;
const PALETTE_COLORS = ['#e8e0c8', '#c8a96e', '#e87c5a', '#5ab0e8', '#7de87a', '#c87de8', '#e8e85a', '#e85a8b', '#5ae8d4', '#444444'];
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
  } else if (action.type === 'erase') {
    undoErase(action.entries);
    redoStack.push(action);
  }
  selectedIndex = -1;
  dragMoveInfo = null;
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
  } else if (action.type === 'erase') {
    redoErase(action.entries);
    undoStack.push(action);
  }
  selectedIndex = -1;
  dragMoveInfo = null;
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

// Check if an image object intersects the eraser circle.
function imageIntersectsEraser(obj, ex, ey, er) {
  return ex + er >= obj.x && ex - er <= obj.x + obj.w &&
         ey + er >= obj.y && ey - er <= obj.y + obj.h;
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
    } else if (obj.type === 'image') {
      let touched = false;
      for (const ep of eraserPath) {
        if (imageIntersectsEraser(obj, ep.x, ep.y, ep.w / 2)) { touched = true; break; }
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
  } else if (obj.type === 'image' || obj.type === 'text') {
    obj.x += dx; obj.y += dy;
  } else {
    obj.x1 += dx; obj.y1 += dy; obj.x2 += dx; obj.y2 += dy;
  }
}

// Capture the position of an object so we can restore it on undo.
function snapshotPosition(obj) {
  if (obj.type === 'stroke') {
    return obj.pts.map(p => ({ x: p.x, y: p.y }));
  } else if (obj.type === 'image' || obj.type === 'text') {
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
  } else if (obj.type === 'image' || obj.type === 'text') {
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

// ── Palette ───────────────────────────────────────────────
let drawColor = PALETTE_COLORS[0];
const colorPalette = document.getElementById('color-palette');
PALETTE_COLORS.forEach((color, i) => {
  const dot = document.createElement('div');
  dot.className = 'color-dot' + (i === 0 ? ' on' : '');
  dot.style.background = color;
  dot.style.boxShadow = '0 0 0 1px #555';
  dot.onclick = () => {
    document.querySelectorAll('.color-dot').forEach((el) => el.classList.remove('on'));
    dot.classList.add('on');
    drawColor = color;
    updateTextStyle();
  };
  colorPalette.appendChild(dot);
});

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

const SHAPE_TOOLS = new Set(['arrow', 'line', 'rect', 'circle']);
const CURSORS = {
  select: 'default', draw: 'crosshair', eraser: 'cell', arrow: 'crosshair', line: 'crosshair',
  rect: 'crosshair', circle: 'crosshair', text: 'text', pan: 'grab'
};
const STATUSES = {
  select:  'Select · Click object to select · Drag to move · Double-click text to edit',
  draw:    'Draw · Scroll=zoom · Space/middle=pan',
  eraser:  'Eraser · Drag to erase',
  arrow:   'Arrow · Click & drag',
  line:    'Line · Click & drag',
  rect:    'Rectangle · Click & drag',
  circle:  'Circle / Ellipse · Click & drag',
  text:    'Text · Click to place · Double-click text to edit',
  pan:     'Pan · Drag to move canvas'
};

const TOOL_BUTTON_IDS = {
  select: 'tool-select', draw: 'tool-draw', eraser: 'tool-eraser', text: 'tool-text', pan: 'tool-pan',
  arrow: 'tool-arrow', line: 'tool-line', rect: 'tool-rect', circle: 'tool-circle'
};

function setTool(t) {
  commitText();
  eraserHoverPoint = null;
  if (tool === 'select' && t !== 'select') {
    selectedIndex = -1;
    dragMoveInfo = null;
  }
  tool = t;
  Object.entries(TOOL_BUTTON_IDS).forEach(([key, id]) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('on', key === t);
  });
  canvas.style.cursor = CURSORS[t] || 'crosshair';
  statusBar.textContent = STATUSES[t] || '';
  fullRedraw();
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
  if (dragMoveInfo) {
    const dx = worldPoint.x - dragMoveInfo.lastWorld.x;
    const dy = worldPoint.y - dragMoveInfo.lastWorld.y;
    if (dx !== 0 || dy !== 0) dragMoveInfo.moved = true;
    translateObject(history[dragMoveInfo.index], dx, dy);
    dragMoveInfo.lastWorld = { x: worldPoint.x, y: worldPoint.y };
    fullRedraw();
    return;
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
  if (isPanning) {
    isPanning = false;
    canvas.style.cursor = CURSORS[tool];
  } else if (dragMoveInfo) {
    if (dragMoveInfo.moved) {
      const obj = history[dragMoveInfo.index];
      const endSnap = snapshotPosition(obj);
      undoStack.push({ type: 'move', obj, from: dragMoveInfo.startSnap, to: endSnap });
      redoStack = [];
      syncUndoRedo();
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

// ── Double-click to edit text ──────────────────────────
canvas.addEventListener('dblclick', (e) => {
  e.preventDefault();
  const { sx, sy } = getPointerCoords(e);
  const worldPoint = toWorld(sx, sy);

  const index = hitTestText(worldPoint);
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
  editText(index);
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
  if (dragMoveInfo) {
    if (dragMoveInfo.moved) {
      const obj = history[dragMoveInfo.index];
      const endSnap = snapshotPosition(obj);
      undoStack.push({ type: 'move', obj, from: dragMoveInfo.startSnap, to: endSnap });
      redoStack = [];
      syncUndoRedo();
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
    meta: { canvasName, startTime: canvasStartTime.getTime() }
  };
}

// Restore the full document state from a saved object.
function deserializeState(state) {
  history = state.objects.map(deserializeObject);
  undoStack = [];
  redoStack = [];
  selectedIndex = -1;
  dragMoveInfo = null;
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

  // Persist on tab close / page hide so the latest state is always saved
  window.addEventListener('beforeunload', flushSave);
  window.addEventListener('pagehide', flushSave);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSave();
  });
})();
