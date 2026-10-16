import * as THREE from 'three';
import {
  detectCrossings,
  loadCustomTracks,
  rightAnglePoints,
  sampleLoop,
  sanitizeTrack,
  saveCustomTracks,
  settleCrossings,
  TRACK_LIST,
  type CrossingSetting,
  type CrossingType,
  type SettledCrossing,
  type Theme,
  type TrackDef,
} from './tracks';

/**
 * The track editor: a closed spline through control points, drawn to scale with the road width. Crossings are found
 * from the shape and each can be a level junction, a ramp (jump) or a bridge (a flyover with an underpass).
 */

const ROAD_WIDTH = 18;
const MIN_RADIUS = 16; // tighter than this and the walls on the inside of a bend overlap
const MIN_SEPARATION = 40; // two parts of the road closer than this (and not crossing) have overlapping walls
const MIN_POINTS = 4;
const PICK_RADIUS = 12; // px

interface Doc {
  id: string;
  name: string;
  theme: Theme;
  laps: number;
  hills: number;
  points: [number, number][];
  crossings: CrossingSetting[];
}

interface Analysis {
  loop: ReturnType<typeof sampleLoop>;
  curve: THREE.CatmullRomCurve3;
  crossings: SettledCrossing[];
  minRadius: number;
  tight: { x: number; z: number; r: number }[];
  close: { x: number; z: number; d: number }[];
  startBend: number; // degrees of heading change around the start line
  warnings: string[];
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('canvas');
const ctx = canvas.getContext('2d')!;

// --- Document ---------------------------------------------------------------------------------------------------

function ovalPoints(): [number, number][] {
  return Array.from({ length: 10 }, (_, i) => {
    const a = (i / 10) * Math.PI * 2;
    return [Math.cos(a) * 170, Math.sin(a) * 100] as [number, number];
  });
}

function figureEightPoints(): [number, number][] {
  return Array.from({ length: 16 }, (_, i) => {
    const t = (i / 16) * Math.PI * 2 - 0.5;
    return [Math.sin(t) * 150, Math.sin(t) * Math.cos(t) * 150] as [number, number];
  });
}

/** Cut a dense loop down to a handful of control points that still follow its shape (the ones that matter least go first). */
function simplify(points: [number, number][], target: number): [number, number][] {
  const pts = points.map((p) => [...p] as [number, number]);
  while (pts.length > target) {
    let best = -1;
    let bestDev = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i + pts.length - 1) % pts.length];
      const b = pts[i];
      const c = pts[(i + 1) % pts.length];
      const dx = c[0] - a[0], dz = c[1] - a[1];
      const len = Math.hypot(dx, dz) || 1;
      const dev = Math.abs((b[0] - a[0]) * dz - (b[1] - a[1]) * dx) / len;
      if (dev < bestDev) {
        bestDev = dev;
        best = i;
      }
    }
    pts.splice(best, 1);
  }
  return pts;
}

const PRESETS: { label: string; make: () => Pick<Doc, 'points' | 'theme' | 'hills' | 'crossings' | 'laps'> }[] = [
  { label: 'Oval', make: () => ({ points: ovalPoints(), theme: 'grass', hills: 0.8, crossings: [], laps: 3 }) },
  {
    // Straights along two axes and nothing but 90 degree bends (all lefts and rights), the notches giving it variety.
    label: 'Right angles only (all 90° turns)',
    make: () => ({ points: rightAnglePoints(), theme: 'snow', hills: 0.5, crossings: [], laps: 3 }),
  },
  {
    label: 'Figure eight (with a crossing)',
    make: () => ({ points: figureEightPoints(), theme: 'grass', hills: 0.8, crossings: [{ x: 0, z: 0, type: 'bridge', over: 'first' }], laps: 3 }),
  },
  ...TRACK_LIST.map((t) => ({
    label: `Copy of ${t.name}`,
    make: () => ({
      points: simplify(t.points, 34),
      theme: t.theme,
      hills: t.hills,
      crossings: t.jump ? ([{ x: 0, z: 0, type: 'ramp', over: 'first' }] as CrossingSetting[]) : [],
      laps: t.laps,
    }),
  })),
];

function newDoc(): Doc {
  return { id: `custom-${Date.now().toString(36)}`, name: 'My circuit', ...PRESETS[0].make() };
}

let doc: Doc = newDoc();
let undoStack: string[] = [];
let redoStack: string[] = [];
let saved = JSON.stringify(doc);

const snapshot = () => JSON.stringify(doc);
function pushUndo(): void {
  undoStack.push(snapshot());
  if (undoStack.length > 100) undoStack.shift();
  redoStack = [];
}
function restore(json: string): void {
  doc = JSON.parse(json);
  selected = -1;
  changed(false);
}

// --- Analysis ---------------------------------------------------------------------------------------------------

function analyse(d: Doc): Analysis {
  const loop = sampleLoop(d.points);
  const curve = new THREE.CatmullRomCurve3(
    d.points.map(([x, z]) => new THREE.Vector3(x, 0, z)),
    true,
    'centripetal',
  );
  const n = loop.positions.length;
  const step = loop.length / n;
  const found = detectCrossings(loop.positions, loop.tangents);
  const crossings = settleCrossings(found, d.crossings, n);

  // Bends: the tightest radius, and where it is too tight.
  let minRadius = Infinity;
  const tight: Analysis['tight'] = [];
  let lastTight = -100;
  for (let i = 0; i < n; i++) {
    const a = loop.tangents[i];
    const b = loop.tangents[(i + 1) % n];
    const ang = Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.z * b.z)));
    const r = ang > 1e-6 ? step / ang : Infinity;
    minRadius = Math.min(minRadius, r);
    if (r < MIN_RADIUS && i - lastTight > 8) {
      tight.push({ x: loop.positions[i].x, z: loop.positions[i].z, r });
      lastTight = i;
    }
  }

  // Parts of the road that come close without crossing (their walls would overlap).
  const crossNear = (i: number) => crossings.some((c) => circ(i, c.a, n) < 30 || circ(i, c.b, n) < 30);
  const skip = Math.round(90 / step);
  const close: Analysis['close'] = [];
  for (let i = 0; i < n; i += 3) {
    if (crossNear(i)) continue;
    for (let j = i + skip; j < n; j += 3) {
      if (circ(i, j, n) < skip || crossNear(j)) continue;
      const d2 = Math.hypot(loop.positions[i].x - loop.positions[j].x, loop.positions[i].z - loop.positions[j].z);
      if (d2 < MIN_SEPARATION && !close.some((c) => Math.hypot(c.x - loop.positions[i].x, c.z - loop.positions[i].z) < 25)) {
        close.push({ x: loop.positions[i].x, z: loop.positions[i].z, d: d2 });
      }
    }
  }

  // Start line: the grid sits on the ~45 m before it, so it should be straight there.
  let startBend = 0;
  const behind = Math.round(48 / step);
  const t0 = loop.tangents[0];
  for (let k = -behind; k <= Math.round(15 / step); k++) {
    const t = loop.tangents[(k + n) % n];
    startBend = Math.max(startBend, Math.acos(Math.max(-1, Math.min(1, t0.x * t.x + t0.z * t.z))) * (180 / Math.PI));
  }

  const warnings: string[] = [];
  if (tight.length) warnings.push(`${tight.length} bend${tight.length > 1 ? 's' : ''} too tight (under ${MIN_RADIUS} m): the walls would overlap. Pull those points apart.`);
  if (close.length) warnings.push(`${close.length} place${close.length > 1 ? 's' : ''} where the road runs closer than ${MIN_SEPARATION} m to itself without crossing. Move them apart.`);
  if (startBend > 18) warnings.push(`The start line is not on a straight (${startBend.toFixed(0)}° of bend around it). Use "Set start line" on a straighter stretch.`);
  if (loop.length < 450) warnings.push('Very short circuit (under 450 m).');
  if (loop.length > 2600) warnings.push('Very long circuit (over 2,600 m).');
  for (const [k, c] of crossings.entries()) {
    if (c.note) warnings.push(`Crossing ${k + 1}: ${c.note}, so it is a level crossing.`);
    if (c.type !== 'level' && c.angle < 0.5) warnings.push(`Crossing ${k + 1}: the roads cross at a shallow angle (${(c.angle * 57.3).toFixed(0)}°); a ${c.type} needs a long span.`);
  }
  return { loop, curve, crossings, minRadius, tight, close, startBend, warnings };
}

const circ = (i: number, j: number, n: number) => {
  const d = Math.abs(i - j);
  return Math.min(d, n - d);
};

let analysis = analyse(doc);

/** Keep the crossing settings in step with the crossings the shape now has (same place = same setting). */
function syncCrossings(): void {
  const next: CrossingSetting[] = [];
  for (const c of analysis.crossings) {
    let old: CrossingSetting | undefined;
    let best = 40;
    for (const s of doc.crossings) {
      const d = Math.hypot(s.x - c.x, s.z - c.z);
      if (d < best) {
        best = d;
        old = s;
      }
    }
    const overHeading = c.over === 'first' ? c.headingA : c.headingB;
    next.push({ x: c.x, z: c.z, type: old?.type ?? 'level', over: c.over, overHeading });
  }
  doc.crossings = next;
}

// --- View -------------------------------------------------------------------------------------------------------

const view = { x: 0, z: 0, scale: 2.2 };
let selected = -1;
let hover = -1;
let highlightCrossing = -1;
type Tool = 'move' | 'add' | 'delete' | 'start';
let tool: Tool = 'move';
let spaceDown = false;
let drag: { kind: 'point'; index: number } | { kind: 'pan'; sx: number; sy: number; vx: number; vz: number } | null = null;

const toScreen = (x: number, z: number): [number, number] => [(x - view.x) * view.scale + canvas.clientWidth / 2, (z - view.z) * view.scale + canvas.clientHeight / 2];
const toWorld = (px: number, py: number): [number, number] => [(px - canvas.clientWidth / 2) / view.scale + view.x, (py - canvas.clientHeight / 2) / view.scale + view.z];

function fit(): void {
  const xs = analysis.loop.positions.map((p) => p.x);
  const zs = analysis.loop.positions.map((p) => p.z);
  const w = Math.max(...xs) - Math.min(...xs) + 120;
  const h = Math.max(...zs) - Math.min(...zs) + 120;
  view.x = (Math.max(...xs) + Math.min(...xs)) / 2;
  view.z = (Math.max(...zs) + Math.min(...zs)) / 2;
  view.scale = Math.max(0.3, Math.min(canvas.clientWidth / w, canvas.clientHeight / h));
}

function resize(): void {
  const dpr = devicePixelRatio || 1;
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
  draw();
}
addEventListener('resize', resize);

let drawQueued = false;
function draw(): void {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => {
    drawQueued = false;
    render();
  });
}

const CROSSING_COLOUR: Record<CrossingType, string> = { level: '#ffd23a', ramp: '#ff6a4a', bridge: '#5fb0ff' };

function render(): void {
  const dpr = devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  ctx.fillStyle = '#121812';
  ctx.fillRect(0, 0, W, H);

  // Grid every 50 m, stronger every 250 m.
  const [x0, z0] = toWorld(0, 0);
  const [x1, z1] = toWorld(W, H);
  ctx.lineWidth = 1;
  for (let gx = Math.floor(x0 / 50) * 50; gx <= x1; gx += 50) {
    const [sx] = toScreen(gx, 0);
    ctx.strokeStyle = gx % 250 === 0 ? '#2a352c' : '#1b231d';
    ctx.beginPath();
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, H);
    ctx.stroke();
  }
  for (let gz = Math.floor(z0 / 50) * 50; gz <= z1; gz += 50) {
    const [, sy] = toScreen(0, gz);
    ctx.strokeStyle = gz % 250 === 0 ? '#2a352c' : '#1b231d';
    ctx.beginPath();
    ctx.moveTo(0, sy);
    ctx.lineTo(W, sy);
    ctx.stroke();
  }

  const pos = analysis.loop.positions;
  const n = pos.length;
  const path = (from: number, to: number) => {
    ctx.beginPath();
    for (let k = from; k <= to; k++) {
      const p = pos[((k % n) + n) % n];
      const [sx, sy] = toScreen(p.x, p.z);
      if (k === from) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    }
  };
  ctx.lineJoin = 'round';
  ctx.lineCap = 'butt';

  // The road to scale: walls (outline), tarmac, centre dashes.
  path(0, n);
  ctx.closePath();
  ctx.strokeStyle = '#4b5550';
  ctx.lineWidth = Math.max(3, (ROAD_WIDTH + 6) * view.scale);
  ctx.stroke();
  ctx.strokeStyle = '#3b3f46';
  ctx.lineWidth = Math.max(2, ROAD_WIDTH * view.scale);
  ctx.stroke();
  ctx.strokeStyle = '#6c727c';
  ctx.lineWidth = 1;
  ctx.setLineDash([8, 10]);
  ctx.stroke();
  ctx.setLineDash([]);

  // Crossing spans: the over strand on top in the crossing's colour.
  analysis.crossings.forEach((c, k) => {
    const over = c.over === 'first' ? c.a : c.b;
    const span = c.type === 'level' ? 0 : Math.round(c.type === 'bridge' ? 70 : 20);
    if (span) {
      path(over - span, over + span);
      ctx.strokeStyle = c.type === 'bridge' ? '#5d7a99' : '#8b4a3a';
      ctx.lineWidth = Math.max(2, ROAD_WIDTH * view.scale);
      ctx.stroke();
      ctx.strokeStyle = CROSSING_COLOUR[c.type];
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    const [sx, sy] = toScreen(c.x, c.z);
    ctx.beginPath();
    ctx.arc(sx, sy, k === highlightCrossing ? 13 : 9, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(10,14,12,0.7)';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = CROSSING_COLOUR[c.type];
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = '700 11px Orbitron, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(String(k + 1), sx, sy + 4);
  });

  // Problems.
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#ff4a4a';
  for (const t of analysis.tight) {
    const [sx, sy] = toScreen(t.x, t.z);
    ctx.beginPath();
    ctx.arc(sx, sy, 14, 0, Math.PI * 2);
    ctx.stroke();
  }
  for (const c of analysis.close) {
    const [sx, sy] = toScreen(c.x, c.z);
    ctx.strokeRect(sx - 12, sy - 12, 24, 24);
  }

  // Start/finish line and the direction of travel.
  {
    const p = pos[0];
    const t = analysis.loop.tangents[0];
    const [sx, sy] = toScreen(p.x, p.z);
    const half = (ROAD_WIDTH / 2) * view.scale;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(sx - t.z * half, sy + t.x * half);
    ctx.lineTo(sx + t.z * half, sy - t.x * half);
    ctx.stroke();
    ctx.fillStyle = '#7be07b';
    const ax = sx + t.x * 26;
    const ay = sy + t.z * 26;
    ctx.beginPath();
    ctx.moveTo(ax + t.x * 12, ay + t.z * 12);
    ctx.lineTo(ax - t.z * 8, ay + t.x * 8);
    ctx.lineTo(ax + t.z * 8, ay - t.x * 8);
    ctx.closePath();
    ctx.fill();
  }

  // Control points.
  doc.points.forEach(([x, z], i) => {
    const [sx, sy] = toScreen(x, z);
    ctx.beginPath();
    ctx.arc(sx, sy, i === selected || i === hover ? 8 : 6, 0, Math.PI * 2);
    ctx.fillStyle = i === selected ? '#ff9a2e' : i === 0 ? '#7be07b' : '#e8ece6';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#0a0d0b';
    ctx.stroke();
  });
}

// --- Editing ----------------------------------------------------------------------------------------------------

/** Called after the shape or settings change: re-analyse, tidy the crossing list and refresh the panel. */
function changed(recordUndo = true): void {
  analysis = analyse(doc);
  syncCrossings();
  analysis = analyse(doc);
  if (recordUndo) redoStack = redoStack.length ? [] : redoStack;
  refreshPanel();
  draw();
}

function edit(fn: () => void): void {
  pushUndo();
  fn();
  changed();
}

function pickPoint(px: number, py: number): number {
  let best = -1;
  let bestD = PICK_RADIUS;
  doc.points.forEach(([x, z], i) => {
    const [sx, sy] = toScreen(x, z);
    const d = Math.hypot(sx - px, sy - py);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

/** The control segment and world position of the point on the road nearest to the screen position, if it is close. */
function nearestOnRoad(px: number, py: number): { segment: number; x: number; z: number } | null {
  const N = doc.points.length;
  let best: { segment: number; x: number; z: number } | null = null;
  let bestD = 40;
  const perSegment = 24;
  for (let k = 0; k < N; k++) {
    for (let s = 0; s < perSegment; s++) {
      const t = (k + s / perSegment) / N;
      const p = analysis.curve.getPoint(t);
      const [sx, sy] = toScreen(p.x, p.z);
      const d = Math.hypot(sx - px, sy - py);
      if (d < bestD) {
        bestD = d;
        best = { segment: k, x: p.x, z: p.z };
      }
    }
  }
  return best;
}

canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  const rect = canvas.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  if (e.button === 1 || e.button === 2 || spaceDown) {
    drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vz: view.z };
    return;
  }
  const hit = pickPoint(px, py);
  if (tool === 'move') {
    selected = hit;
    if (hit >= 0) {
      pushUndo();
      drag = { kind: 'point', index: hit };
    }
  } else if (tool === 'add') {
    if (hit >= 0) {
      selected = hit;
    } else {
      const near = nearestOnRoad(px, py);
      if (near) {
        edit(() => {
          doc.points.splice(near.segment + 1, 0, [Math.round(near.x * 10) / 10, Math.round(near.z * 10) / 10]);
          if (near.segment + 1 <= 0) return;
        });
        selected = near.segment + 1;
      }
    }
  } else if (tool === 'delete') {
    if (hit >= 0 && doc.points.length > MIN_POINTS) {
      edit(() => doc.points.splice(hit, 1));
      selected = -1;
    }
  } else if (tool === 'start') {
    if (hit > 0) {
      edit(() => {
        doc.points = [...doc.points.slice(hit), ...doc.points.slice(0, hit)];
      });
      selected = 0;
    }
  }
  refreshPanel();
  draw();
});

canvas.addEventListener('pointermove', (e) => {
  const rect = canvas.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  if (drag?.kind === 'pan') {
    view.x = drag.vx - (e.clientX - drag.sx) / view.scale;
    view.z = drag.vz - (e.clientY - drag.sy) / view.scale;
    draw();
    return;
  }
  if (drag?.kind === 'point') {
    const [wx, wz] = toWorld(px, py);
    doc.points[drag.index] = [Math.round(wx * 10) / 10, Math.round(wz * 10) / 10];
    analysis = analyse(doc);
    draw();
    return;
  }
  const h = pickPoint(px, py);
  if (h !== hover) {
    hover = h;
    draw();
  }
});

canvas.addEventListener('pointerup', () => {
  if (drag?.kind === 'point') changed();
  drag = null;
});

canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const [wx, wz] = toWorld(px, py);
    view.scale = Math.max(0.25, Math.min(8, view.scale * Math.exp(-e.deltaY * 0.0015)));
    // Keep the point under the cursor where it was.
    view.x = wx - (px - canvas.clientWidth / 2) / view.scale;
    view.z = wz - (py - canvas.clientHeight / 2) / view.scale;
    draw();
  },
  { passive: false },
);

addEventListener('keydown', (e) => {
  const typing = (e.target as HTMLElement | null)?.tagName === 'INPUT' || (e.target as HTMLElement | null)?.tagName === 'SELECT';
  if (e.code === 'Space' && !typing) {
    spaceDown = true;
    e.preventDefault();
  }
  if (typing) return;
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
    e.preventDefault();
    undo();
  } else if ((e.ctrlKey || e.metaKey) && (e.code === 'KeyY' || (e.shiftKey && e.code === 'KeyZ'))) {
    e.preventDefault();
    redo();
  } else if (e.code === 'KeyM') setTool('move');
  else if (e.code === 'KeyA') setTool('add');
  else if (e.code === 'KeyD') setTool('delete');
  else if (e.code === 'KeyS') setTool('start');
  else if ((e.code === 'Delete' || e.code === 'Backspace') && selected >= 0 && doc.points.length > MIN_POINTS) {
    edit(() => doc.points.splice(selected, 1));
    selected = -1;
    refreshPanel();
  } else if (e.code === 'Escape') {
    selected = -1;
    draw();
  } else if (selected >= 0 && e.code.startsWith('Arrow')) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 2;
    const dx = e.code === 'ArrowLeft' ? -step : e.code === 'ArrowRight' ? step : 0;
    const dz = e.code === 'ArrowUp' ? -step : e.code === 'ArrowDown' ? step : 0;
    edit(() => {
      doc.points[selected] = [doc.points[selected][0] + dx, doc.points[selected][1] + dz];
    });
  }
});
addEventListener('keyup', (e) => {
  if (e.code === 'Space') spaceDown = false;
});

function undo(): void {
  const last = undoStack.pop();
  if (last === undefined) return;
  redoStack.push(snapshot());
  restore(last);
}
function redo(): void {
  const next = redoStack.pop();
  if (next === undefined) return;
  undoStack.push(snapshot());
  restore(next);
}

function setTool(t: Tool): void {
  tool = t;
  for (const id of ['move', 'add', 'delete', 'start']) $(`tool-${id}`).classList.toggle('on', id === t);
  canvas.style.cursor = t === 'move' ? 'default' : 'crosshair';
}

// --- Shape tools ------------------------------------------------------------------------------------------------

/** Turn the crossing settings' remembered "over" directions along with a transformation of the circuit. */
function transformHeadings(fn: (h: number) => number): void {
  doc.crossings = doc.crossings.map((c) => (c.overHeading === undefined ? c : { ...c, overHeading: fn(c.overHeading) }));
}

function transformAll(f: (x: number, z: number) => [number, number], headings: (h: number) => number): void {
  edit(() => {
    doc.points = doc.points.map(([x, z]) => f(x, z));
    doc.crossings = doc.crossings.map((c) => {
      const [x, z] = f(c.x, c.z);
      return { ...c, x, z };
    });
    transformHeadings(headings);
  });
}

$('mirrorx').onclick = () => transformAll((x, z) => [-x, z], (h) => Math.PI - h);
$('mirrorz').onclick = () => transformAll((x, z) => [x, -z], (h) => -h);
$('rotate').onclick = () => transformAll((x, z) => [-z, x], (h) => h + Math.PI / 2);
$('shrink').onclick = () => transformAll((x, z) => [x * 0.9, z * 0.9], (h) => h);
$('grow').onclick = () => transformAll((x, z) => [x * 1.1, z * 1.1], (h) => h);
$('centre').onclick = () => {
  const xs = doc.points.map((p) => p[0]);
  const zs = doc.points.map((p) => p[1]);
  const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
  const cz = (Math.max(...zs) + Math.min(...zs)) / 2;
  transformAll((x, z) => [x - cx, z - cz], (h) => h);
  fit();
  draw();
};
$('reverse').onclick = () =>
  edit(() => {
    // Keep the start where it is and run the loop the other way.
    doc.points = [doc.points[0], ...doc.points.slice(1).reverse()];
    transformHeadings((h) => h + Math.PI);
  });
$('smooth').onclick = () =>
  edit(() => {
    const p = doc.points;
    const n = p.length;
    doc.points = p.map(([x, z], i) => {
      const a = p[(i + n - 1) % n];
      const b = p[(i + 1) % n];
      return [Math.round((x * 0.5 + (a[0] + b[0]) * 0.25) * 10) / 10, Math.round((z * 0.5 + (a[1] + b[1]) * 0.25) * 10) / 10] as [number, number];
    });
  });
$('undo').onclick = undo;
$('redo').onclick = redo;
for (const t of ['move', 'add', 'delete', 'start'] as Tool[]) $(`tool-${t}`).onclick = () => setTool(t);

// --- Panel ------------------------------------------------------------------------------------------------------

const presetSelect = $<HTMLSelectElement>('preset');
PRESETS.forEach((p, i) => presetSelect.append(new Option(p.label, String(i))));
$('usePreset').onclick = () => {
  if (snapshot() !== saved && !confirm('Replace the current shape? Unsaved changes will be lost (you can still undo).')) return;
  edit(() => Object.assign(doc, PRESETS[Number(presetSelect.value)].make()));
  selected = -1;
  fit();
  draw();
};

$<HTMLInputElement>('name').oninput = (e) => {
  doc.name = (e.target as HTMLInputElement).value;
};
$<HTMLSelectElement>('theme').onchange = (e) => {
  edit(() => (doc.theme = (e.target as HTMLSelectElement).value as Theme));
};
$<HTMLInputElement>('laps').onchange = (e) => {
  edit(() => (doc.laps = Math.max(1, Math.min(10, Math.round(Number((e.target as HTMLInputElement).value) || 3)))));
};
$<HTMLInputElement>('hills').oninput = (e) => {
  doc.hills = Number((e.target as HTMLInputElement).value);
  $('hillsValue').textContent = doc.hills.toFixed(1);
};

function refreshPanel(): void {
  $<HTMLInputElement>('name').value = doc.name;
  $<HTMLSelectElement>('theme').value = doc.theme;
  $<HTMLInputElement>('laps').value = String(doc.laps);
  $<HTMLInputElement>('hills').value = String(doc.hills);
  $('hillsValue').textContent = doc.hills.toFixed(1);
  ($('undo') as HTMLButtonElement).disabled = undoStack.length === 0;
  ($('redo') as HTMLButtonElement).disabled = redoStack.length === 0;

  // Crossings.
  const list = $('crossings');
  list.replaceChildren();
  if (!analysis.crossings.length) {
    const none = document.createElement('div');
    none.className = 'hint';
    none.textContent = 'The road does not cross itself. Bend it across itself to make a crossing.';
    list.append(none);
  }
  analysis.crossings.forEach((c, k) => {
    const row = document.createElement('div');
    row.className = 'crossing' + (k === highlightCrossing ? ' active' : '');
    const head = document.createElement('div');
    head.className = 'head';
    head.innerHTML = `<b>Crossing ${k + 1}</b><span>${(c.angle * 57.3).toFixed(0)}° · ${Math.round(c.x)}, ${Math.round(c.z)}</span>`;
    const setting = doc.crossings.find((s) => Math.hypot(s.x - c.x, s.z - c.z) < 1) ?? doc.crossings[k];
    const type = document.createElement('select');
    type.innerHTML = '<option value="level">Same level (flat junction)</option><option value="ramp">Ramp: jump over the other road</option><option value="bridge">Bridge / underpass</option>';
    type.value = setting?.type ?? 'level';
    type.onchange = () => {
      edit(() => {
        if (setting) setting.type = type.value as CrossingType;
      });
    };
    row.append(head, type);
    if ((setting?.type ?? 'level') !== 'level') {
      const swap = document.createElement('button');
      swap.style.marginTop = '6px';
      swap.style.width = '100%';
      swap.textContent = `On top: the ${c.over === 'first' ? 'first' : 'second'} road (click to swap)`;
      swap.onclick = () =>
        edit(() => {
          if (setting) setting.overHeading = c.over === 'first' ? c.headingB : c.headingA;
        });
      row.append(swap);
    }
    if (c.note) {
      const note = document.createElement('div');
      note.className = 'note';
      note.textContent = `Became level: ${c.note}.`;
      row.append(note);
    }
    row.onmouseenter = () => {
      highlightCrossing = k;
      draw();
    };
    row.onmouseleave = () => {
      highlightCrossing = -1;
      draw();
    };
    list.append(row);
  });

  // Checks and numbers.
  const checks = $('checks');
  checks.replaceChildren();
  if (!analysis.warnings.length) {
    const ok = document.createElement('div');
    ok.className = 'ok';
    ok.textContent = 'No problems found.';
    checks.append(ok);
  }
  for (const w of analysis.warnings) {
    const el = document.createElement('div');
    el.className = 'warn';
    el.textContent = '⚠ ' + w;
    checks.append(el);
  }
  $('info').textContent =
    `${Math.round(analysis.loop.length)} m · ${doc.points.length} points · tightest bend ${Number.isFinite(analysis.minRadius) ? Math.round(analysis.minRadius) : '–'} m · ` +
    `${analysis.crossings.length} crossing${analysis.crossings.length === 1 ? '' : 's'}`;
  refreshMine();
}

// --- Files ------------------------------------------------------------------------------------------------------

const mine = $<HTMLSelectElement>('mine');
function refreshMine(): void {
  const tracks = loadCustomTracks();
  const current = mine.value;
  mine.replaceChildren(new Option(tracks.length ? '— choose —' : '(none saved yet)', ''));
  for (const t of tracks) mine.append(new Option(t.name + (t.id === doc.id ? '  ✓' : ''), t.id));
  mine.value = tracks.some((t) => t.id === current) ? current : '';
}

let toastTimer = 0;
function toast(text: string): void {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('show'), 2400);
}

function toTrackDef(d: Doc): TrackDef | null {
  return sanitizeTrack({ ...d, crossings: d.crossings });
}

function save(): TrackDef | null {
  const def = toTrackDef(doc);
  if (!def) {
    toast('This shape cannot be saved (too few points?).');
    return null;
  }
  const list = loadCustomTracks().filter((t) => t.id !== doc.id);
  list.push(def);
  if (!saveCustomTracks(list)) {
    toast('Could not save: browser storage is blocked.');
    return null;
  }
  doc.id = def.id;
  doc.name = def.name;
  saved = snapshot();
  refreshMine();
  toast(`Saved "${def.name}". It is in Training.`);
  return def;
}

$('save').onclick = () => void save();
$('drive').onclick = () => {
  const def = save();
  if (def) location.href = `index.html?play=${encodeURIComponent(def.id)}`;
};
$('new').onclick = () => {
  if (snapshot() !== saved && !confirm('Start a new circuit? Unsaved changes will be lost.')) return;
  doc = newDoc();
  undoStack = [];
  redoStack = [];
  saved = snapshot();
  selected = -1;
  changed(false);
  fit();
  draw();
};
$('load').onclick = () => {
  const t = loadCustomTracks().find((x) => x.id === mine.value);
  if (!t) return;
  if (snapshot() !== saved && !confirm('Open another circuit? Unsaved changes will be lost.')) return;
  doc = { id: t.id, name: t.name, theme: t.theme, laps: t.laps, hills: t.hills, points: t.points, crossings: t.crossings ?? [] };
  undoStack = [];
  redoStack = [];
  saved = snapshot();
  selected = -1;
  changed(false);
  fit();
  draw();
};
$('delete').onclick = () => {
  const t = loadCustomTracks().find((x) => x.id === mine.value);
  if (!t || !confirm(`Delete "${t.name}"?`)) return;
  saveCustomTracks(loadCustomTracks().filter((x) => x.id !== t.id));
  refreshMine();
  toast('Deleted.');
};
$('export').onclick = () => {
  const def = toTrackDef(doc);
  if (!def) return;
  const blob = new Blob([JSON.stringify({ ...def, description: undefined }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${def.name.replace(/[^\w-]+/g, '_') || 'track'}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
};
const file = $<HTMLInputElement>('file');
$('import').onclick = () => file.click();
file.onchange = async () => {
  const f = file.files?.[0];
  file.value = '';
  if (!f) return;
  try {
    const raw = JSON.parse(await f.text());
    const t = sanitizeTrack(Array.isArray(raw) ? raw[0] : raw);
    if (!t) throw new Error('bad track');
    // A fresh id, so importing never overwrites a circuit of the same id.
    pushUndo();
    doc = { id: `custom-${Date.now().toString(36)}`, name: t.name, theme: t.theme, laps: t.laps, hills: t.hills, points: t.points, crossings: t.crossings ?? [] };
    selected = -1;
    changed();
    fit();
    draw();
    toast(`Imported "${t.name}". Save it to keep it.`);
  } catch {
    toast('That file is not a usable track.');
  }
};

addEventListener('beforeunload', (e) => {
  if (snapshot() !== saved) e.preventDefault();
});

// --- Start ------------------------------------------------------------------------------------------------------

// The canvas text needs the pixel font loaded before it is drawn.
void document.fonts.load('700 11px Orbitron').then(() => draw());
setTool('move');
changed(false);
requestAnimationFrame(() => {
  resize();
  fit();
  draw();
});
