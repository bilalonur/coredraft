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
let future = [];    // objects popped by undo, available for redo

function pushHistory(obj) {
  history.push(obj);
  future = [];        // a new action clears the redo stack
  syncUndoRedo();
}

function undo() {
  if (!history.length) return;
  future.push(history.pop());
  syncUndoRedo();
  fullRedraw();
}

function redo() {
  if (!future.length) return;
  history.push(future.pop());
  syncUndoRedo();
  fullRedraw();
}

function syncUndoRedo() {
  const undoButton = document.getElementById('undo-button');
  const redoButton = document.getElementById('redo-button');
  undoButton.disabled = history.length === 0;
  redoButton.disabled = future.length === 0;
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
    context.drawImage(obj.img, obj.x, obj.y, obj.w, obj.h);
  }
  context.restore();
}

function drawStroke(context, obj) {
  const pts = obj.pts;
  if (!pts || pts.length === 0) return;

  // Eraser paints the background color — never destination-out.
  // destination-out punches transparent holes that show white in exports
  // and through the canvas element. Painting bg color is always correct.
  const color = obj.isErase ? (isDark ? '#0e0e0e' : '#f5f3ef') : obj.color;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.strokeStyle = color;

  if (pts.length === 1) {
    context.beginPath();
    context.arc(pts[0].x, pts[0].y, pts[0].w / 2, 0, Math.PI * 2);
    context.fillStyle = color;
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

// ── Image hit-test ───────────────────────────────────────
function hitTestImage(worldPoint) {
  for (let i = history.length - 1; i >= 0; i--) {
    const obj = history[i];
    if (obj.type !== 'image') continue;
    if (worldPoint.x >= obj.x && worldPoint.x <= obj.x + obj.w &&
        worldPoint.y >= obj.y && worldPoint.y <= obj.y + obj.h) {
      return i;
    }
  }
  return -1;
}

// ── Full redraw ───────────────────────────────────────────
function fullRedraw() {
  const width = canvasWrap.offsetWidth;
  const height = canvasWrap.offsetHeight;
  canvasContext.clearRect(0, 0, width, height);
  canvasContext.fillStyle = isDark ? '#0e0e0e' : '#f5f3ef';
  canvasContext.fillRect(0, 0, width, height);
  canvasContext.save();
  canvasContext.translate(panX, panY);
  canvasContext.scale(viewScale, viewScale);

  for (const obj of history) drawObject(canvasContext, obj);

  // Live shape preview
  if (shapeStart && shapeEnd) drawShapePreview(canvasContext);

  // Highlight image being dragged
  if (draggedImage) {
    const obj = draggedImage.obj;
    canvasContext.strokeStyle = isDark ? '#c8a96e' : '#8a6a2a';
    canvasContext.lineWidth = 2 / viewScale;
    canvasContext.setLineDash([6 / viewScale, 4 / viewScale]);
    canvasContext.strokeRect(obj.x, obj.y, obj.w, obj.h);
    canvasContext.setLineDash([]);
  }

  canvasContext.restore();
  document.getElementById('zoom-level').textContent = Math.round(viewScale * 100) + '%';
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
let draggedImage = null;   // { obj, ox, oy } — image being dragged

const SHAPE_TOOLS = new Set(['arrow', 'line', 'rect', 'circle']);
const CURSORS = {
  draw: 'crosshair', eraser: 'cell', arrow: 'crosshair', line: 'crosshair',
  rect: 'crosshair', circle: 'crosshair', text: 'text', pan: 'grab'
};
const STATUSES = {
  draw:   'Draw · Scroll=zoom · Space/middle=pan',
  eraser: 'Eraser · Drag to erase',
  arrow:  'Arrow · Click & drag',
  line:   'Line · Click & drag',
  rect:   'Rectangle · Click & drag',
  circle: 'Circle / Ellipse · Click & drag',
  text:   'Text · Click to place · Double-click text to edit',
  pan:    'Pan · Drag to move · Double-click image to relocate'
};

const TOOL_BUTTON_IDS = {
  draw: 'tool-draw', eraser: 'tool-eraser', text: 'tool-text', pan: 'tool-pan',
  arrow: 'tool-arrow', line: 'tool-line', rect: 'tool-rect', circle: 'tool-circle'
};

function setTool(t) {
  commitText();
  tool = t;
  Object.entries(TOOL_BUTTON_IDS).forEach(([key, id]) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('on', key === t);
  });
  canvas.style.cursor = CURSORS[t] || 'crosshair';
  statusBar.textContent = STATUSES[t] || '';
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
    // Paint bg color directly on screen canvas — fast, no fullRedraw needed,
    // and never punches a transparent hole.
    const bgColor = isDark ? '#0e0e0e' : '#f5f3ef';
    const n = strokePoints.length;
    if (n < 2) return;
    const p0 = strokePoints[Math.max(0, n - 4)];
    const p1 = strokePoints[n - 3] || strokePoints[0];
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
    canvasContext.strokeStyle = bgColor;
    canvasContext.lineWidth = p2.w * viewScale;
    canvasContext.lineCap = 'round';
    canvasContext.lineJoin = 'round';
    canvasContext.beginPath();
    canvasContext.moveTo(sx1, sy1);
    canvasContext.bezierCurveTo(scp1x, scp1y, scp2x, scp2y, sx2, sy2);
    canvasContext.stroke();
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
  pushHistory(currentStroke);
  currentStroke = null;
  strokePoints = [];
  lastVelocity = 0;
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
  if (value.trim()) {
    if (activeTextNode.editIndex !== undefined) {
      // Update existing text object in place
      const obj = history[activeTextNode.editIndex];
      obj.lines = value.split('\n');
      obj.color = drawColor;
      obj.font = style.css;
      obj.lineH = style.lineH;
      future = [];
      syncUndoRedo();
      fullRedraw();
    } else {
      pushHistory({
        type: 'text',
        color: drawColor,
        font: style.css,
        lineH: style.lineH,
        x: activeTextNode.worldPoint.x,
        y: activeTextNode.worldPoint.y,
        lines: value.split('\n')
      });
      fullRedraw();
    }
  } else if (activeTextNode.editIndex !== undefined) {
    // Editing produced empty text — remove the original
    history.splice(activeTextNode.editIndex, 1);
    future = [];
    syncUndoRedo();
    fullRedraw();
  }
  textInput.style.display = 'none';
  textInput.value = '';
  activeTextNode = null;
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

  // If an image was picked up via double-click, clicking drops it in place
  if (draggedImage) {
    if (draggedImage.moved) { future = []; syncUndoRedo(); }
    draggedImage = null;
    canvas.style.cursor = CURSORS[tool];
    fullRedraw();
    statusBar.textContent = STATUSES[tool] || '';
    return;
  }

  if (tool === 'pan') {
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
  if (draggedImage) {
    draggedImage.obj.x = worldPoint.x - draggedImage.ox;
    draggedImage.obj.y = worldPoint.y - draggedImage.oy;
    draggedImage.moved = true;
    fullRedraw();
    return;
  }
  if ((tool === 'draw' || tool === 'eraser') && isDrawing) continueStroke(worldPoint);
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
  if (SHAPE_TOOLS.has(tool) && shapeStart) {
    shapeStart = null;
    shapeEnd = null;
    fullRedraw();
  }
  middleMouseDown = false;
});

canvasWrap.addEventListener('mousedown', (e) => {
  if (e.target !== textInput && activeTextNode && !justPlacedText) commitText();
});

// ── Double-click to edit text / relocate image ─────────
canvas.addEventListener('dblclick', (e) => {
  e.preventDefault();
  const { sx, sy } = getPointerCoords(e);
  const worldPoint = toWorld(sx, sy);

  // In pan mode, double-click an image to pick it up for relocation
  if (tool === 'pan') {
    const imageIndex = hitTestImage(worldPoint);
    if (imageIndex !== -1) {
      const obj = history[imageIndex];
      draggedImage = { obj, ox: worldPoint.x - obj.x, oy: worldPoint.y - obj.y, moved: false };
      canvas.style.cursor = 'grabbing';
      statusBar.textContent = 'Image picked up · Move mouse to position · Click to drop';
      fullRedraw();
      return;
    }
  }

  const index = hitTestText(worldPoint);
  if (index === -1) return;

  // Remove trivial click artifacts (dots, zero-size shapes) from the preceding clicks
  let removed = 0;
  while (removed < 2 && history.length > 0) {
    if (isTrivialAction(history[history.length - 1])) {
      future.push(history.pop());
      removed++;
    } else break;
  }
  if (removed > 0) syncUndoRedo();

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
  if (e.target === textInput) return;

  // Undo / Redo
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'z') { e.preventDefault(); undo(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key === 'y') { e.preventDefault(); redo(); return; }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'Z') { e.preventDefault(); redo(); return; }

  if (e.ctrlKey || e.metaKey) return; // don't steal other ctrl shortcuts

  if (e.code === 'Space') {
    e.preventDefault();
    spaceDown = true;
    if (!isPanning && !middleMouseDown) canvas.style.cursor = 'grab';
  }
  if (e.key === 'd') setTool('draw');
  if (e.key === 'e') setTool('eraser');
  if (e.key === 'a') setTool('arrow');
  if (e.key === 'l') setTool('line');
  if (e.key === 'r') setTool('rect');
  if (e.key === 'c') setTool('circle');
  if (e.key === 't') setTool('text');
  if (e.key === 'p') setTool('pan');
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

// ── Reset ─────────────────────────────────────────────────
function resetCanvas() {
  if (!confirm('Clear everything?')) return;
  commitText();
  history = [];
  future = [];
  shapeStart = null;
  shapeEnd = null;
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
const canvasStartTime = new Date();

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
let lastTapTime = 0;

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
  const now = Date.now();

  // Drop image if one is being relocated
  if (draggedImage) {
    if (draggedImage.moved) { future = []; syncUndoRedo(); }
    draggedImage = null;
    fullRedraw();
    return;
  }

  // Double-tap on image in pan mode → pick up for relocation
  if (tool === 'pan' && now - lastTapTime < 350) {
    const imageIndex = hitTestImage(worldPoint);
    if (imageIndex !== -1) {
      const obj = history[imageIndex];
      draggedImage = { obj, ox: worldPoint.x - obj.x, oy: worldPoint.y - obj.y, moved: false };
      fullRedraw();
      return;
    }
  }

  lastTapTime = now;
  if (tool === 'draw' || tool === 'eraser') startStroke(worldPoint);
  else if (SHAPE_TOOLS.has(tool)) { shapeStart = worldPoint; shapeEnd = worldPoint; }
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
  if (draggedImage) {
    draggedImage.obj.x = worldPoint.x - draggedImage.ox;
    draggedImage.obj.y = worldPoint.y - draggedImage.oy;
    draggedImage.moved = true;
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
  if (tool === 'draw' || tool === 'eraser') endStroke(worldPoint);
  else if (SHAPE_TOOLS.has(tool) && shapeStart) { shapeEnd = worldPoint; commitShape(); }
});

// ── Boot ──────────────────────────────────────────────────
initCanvasView();
