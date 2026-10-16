import * as THREE from 'three';

/** How the world around a circuit looks. Gameplay is the same on all of them. */
export type Theme = 'grass' | 'snow' | 'mountain';

export interface ThemeStyle {
  background: number; // sky/ground colour at the horizon
  ground: { base: [number, number, number]; noise: number; fleck: string[]; blade: string[] | null };
  shoulder: number; // vertex colour multiplied with the ground texture beside the road (white = texture as is)
  embankment: number; // colour of the bank that drops from a raised road to the ground
  trees: { count: number; pineShare: number; hue: number; saturation: number; lightness: number };
}

export const THEMES: Record<Theme, ThemeStyle> = {
  grass: {
    background: 0x3d6a37,
    ground: { base: [70, 118, 50], noise: 30, fleck: ['rgba(40,85,32,0.55)', 'rgba(110,165,70,0.5)', 'rgba(150,170,80,0.45)'], blade: ['grass'] },
    shoulder: 0xffffff,
    embankment: 0xd6b48a,
    trees: { count: 420, pineShare: 0.65, hue: 0.3, saturation: 0.45, lightness: 0.22 },
  },
  snow: {
    background: 0xdfe8f2,
    ground: { base: [226, 234, 244], noise: 14, fleck: ['rgba(255,255,255,0.7)', 'rgba(170,190,215,0.45)', 'rgba(200,215,235,0.5)'], blade: null },
    shoulder: 0xffffff,
    embankment: 0xc2cfdd,
    trees: { count: 380, pineShare: 0.9, hue: 0.5, saturation: 0.12, lightness: 0.6 },
  },
  mountain: {
    background: 0x5d5f55,
    ground: { base: [112, 106, 96], noise: 34, fleck: ['rgba(60,56,50,0.55)', 'rgba(150,142,128,0.5)', 'rgba(90,100,70,0.35)'], blade: null },
    shoulder: 0xffffff,
    embankment: 0x9a8a74,
    trees: { count: 220, pineShare: 0.85, hue: 0.33, saturation: 0.3, lightness: 0.16 },
  },
};

/**
 * A circuit: a closed loop of control points (x, z in metres) that a smooth curve is drawn through, plus how it looks.
 * The first point is the start/finish line and sits in the middle of a straight (the grid is behind it). Only a loop
 * that crosses itself, like the figure-eight, can have the jump (the pit opens where the other strand passes under).
 */
export interface TrackDef {
  id: string;
  name: string;
  description: string;
  theme: Theme;
  laps: number;
  /** Closed loop of control points [x, z]. */
  points: [number, number][];
  /** Rolling hills: 1 is gentle, more is a hillier road. */
  hills: number;
  /** The jump over the crossing (figure-eight only). */
  jump: boolean;
}

/** The classic figure-eight, a Gerono lemniscate whose crossing is where the jump goes. */
function figureEight(): [number, number][] {
  const a = 105;
  const start = -0.5;
  const count = 32;
  return Array.from({ length: count }, (_, k) => {
    const t = start + (2 * Math.PI * k) / count;
    return [a * Math.sin(t), a * Math.sin(t) * Math.cos(t)] as [number, number];
  });
}


/** A corner of a circuit drawn as straight lines: the vertex (x, z) and the radius of the bend rounded off it. */
export type Corner = [x: number, z: number, radius: number];

/**
 * Turn a closed polygon of corners into control points along a path of straights joined by circular arcs, so every
 * bend has exactly the radius asked for (a hairpin is two tight 90 degree corners close together). Each straight must
 * be long enough for the two arcs at its ends.
 */
export function roundedLoop(input: Corner[]): [number, number][] {
  const n = input.length;
  const corners: Corner[] = input.map(([x, z, r]) => [x, z, r]);
  // Bends that would overrun a short straight are tightened just enough to fit it.
  const turnAt = (i: number) => {
    const p = corners[(i + n - 1) % n];
    const c = corners[i];
    const q = corners[(i + 1) % n];
    const ax = c[0] - p[0], az = c[1] - p[1], bx = q[0] - c[0], bz = q[1] - c[1];
    return Math.acos(Math.max(-1, Math.min(1, (ax * bx + az * bz) / (Math.hypot(ax, az) * Math.hypot(bx, bz)))));
  };
  for (let pass = 0; pass < 6; pass++) {
    for (let i = 0; i < n; i++) {
      const next = (i + 1) % n;
      const length = Math.hypot(corners[next][0] - corners[i][0], corners[next][1] - corners[i][1]) - 6;
      const reach = corners[i][2] * Math.tan(turnAt(i) / 2) + corners[next][2] * Math.tan(turnAt(next) / 2);
      if (reach > length) {
        const k = length / reach;
        corners[i][2] *= k;
        corners[next][2] *= k;
      }
    }
  }
  const out: [number, number][] = [];
  const dir = (a: Corner, b: Corner) => {
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    return { x: dx / len, z: dz / len, len };
  };
  const exits: { x: number; z: number }[] = [];
  const entries: { x: number; z: number }[] = [];
  const arcs: [number, number][][] = [];
  for (let i = 0; i < n; i++) {
    const prev = corners[(i + n - 1) % n];
    const cur = corners[i];
    const next = corners[(i + 1) % n];
    const d1 = dir(prev, cur);
    const d2 = dir(cur, next);
    const turn = Math.acos(Math.max(-1, Math.min(1, d1.x * d2.x + d1.z * d2.z)));
    const cross = d1.x * d2.z - d1.z * d2.x;
    const side = cross >= 0 ? 1 : -1; // which way it bends
    const tangent = cur[2] * Math.tan(turn / 2);
    const entry = { x: cur[0] - d1.x * tangent, z: cur[1] - d1.z * tangent };
    const exit = { x: cur[0] + d2.x * tangent, z: cur[1] + d2.z * tangent };
    entries.push(entry);
    exits.push(exit);
    // The arc's centre is a radius away from the entry point, towards the inside of the bend.
    const cx = entry.x + -d1.z * side * cur[2];
    const cz = entry.z + d1.x * side * cur[2];
    const a0 = Math.atan2(entry.z - cz, entry.x - cx);
    const steps = Math.max(3, Math.ceil((turn * cur[2]) / 5));
    const points: [number, number][] = [];
    for (let k = 0; k <= steps; k++) {
      const a = a0 + side * turn * (k / steps);
      points.push([cx + Math.cos(a) * cur[2], cz + Math.sin(a) * cur[2]]);
    }
    arcs.push(points);
  }
  for (let i = 0; i < n; i++) {
    out.push(...arcs[i]);
    // The straight to the next corner, with a point every 25 m or so to keep the curve straight.
    const from = exits[i];
    const to = entries[(i + 1) % n];
    const len = Math.hypot(to.x - from.x, to.z - from.z);
    const parts = Math.floor(len / 25);
    for (let k = 1; k <= parts; k++) out.push([from.x + ((to.x - from.x) * k) / (parts + 1), from.z + ((to.z - from.z) * k) / (parts + 1)]);
  }
  return out;
}

/** Shrink or grow a drawn circuit, keeping its bends as tight as drawn (but never under 19 m, which the road needs). */
function layout(corners: Corner[], scale: number): [number, number][] {
  return startOnFlattest(roundedLoop(corners.map(([x, z, r]) => [x * scale, z * scale, Math.max(19, r * (0.5 + 0.5 * scale))] as Corner)));
}

/** Rotate a closed loop of points so that the first one is on the straightest part of the curve through them. */
function startOnFlattest(points: [number, number][]): [number, number][] {
  const curve = new THREE.CatmullRomCurve3(
    points.map(([x, z]) => new THREE.Vector3(x, 0, z)),
    true,
    'centripetal',
  );
  const n = 800;
  const tangents = Array.from({ length: n }, (_, i) => curve.getTangentAt(i / n));
  const bend = tangents.map((t, i) => {
    const u = tangents[(i + 1) % n];
    return Math.acos(Math.max(-1, Math.min(1, t.x * u.x + t.z * u.z)));
  });
  // The worst bend within about 45 samples before and 25 after each point: the start grid sits just before the line.
  const window = Math.round((n * 70) / curve.getLength() * 1.07);
  let best = 0;
  let bestWorst = Infinity;
  for (let i = 0; i < n; i++) {
    let worst = 0;
    for (let k = -window; k <= window / 2; k++) worst = Math.max(worst, bend[(i + k + n) % n]);
    if (worst < bestWorst) {
      bestWorst = worst;
      best = i;
    }
  }
  const spot = curve.getPointAt(best / n);
  let first = 0;
  let nearest = Infinity;
  points.forEach(([x, z], k) => {
    const d = Math.hypot(x - spot.x, z - spot.z);
    if (d < nearest) {
      nearest = d;
      first = k;
    }
  });
  return [...points.slice(first), ...points.slice(0, first)];
}


/*
 * The three circuits, drawn as corners [x, z, bend radius] in driving order (x to the right, z down the screen).
 * Each starts and finishes on its longest straight.
 */
// A grassy park circuit: a fast sweeper, a double-apex, a right-hand chicane, a long back straight, a wide hairpin,
// an S-bend and a tight left-hander before the straight.
const PARKLAND: Corner[] = [
  [230, 130, 70], [230, -20, 45], [130, -90, 30], [150, -170, 40], [20, -170, 28], [-30, -90, 24], [-130, -95, 22],
  [-130, -20, 22], [-60, -20, 26], [10, 50, 30], [-190, 70, 26], [-190, 130, 28],
];
// Big sweepers and a fast kink, then a switchback on the far side and a hairpin before the long return.
const FROSTBITE: Corner[] = [
  [240, 150, 90], [240, 40, 60], [150, -40, 40], [220, -130, 34], [60, -170, 45], [-150, -150, 40], [-210, -60, 30],
  [-130, -10, 24], [-170, 60, 28], [-175, 150, 40],
];
// A mountain road: a run of linked bends, an S, a tight hairpin pair in the middle and a long run back down.
const GRANITE: Corner[] = [
  [120, 110, 40], [190, 40, 30], [150, -30, 26], [210, -80, 26], [190, -160, 24], [100, -190, 24], [60, -120, 22],
  [-20, -100, 22], [-80, -170, 24], [-180, -140, 24], [-210, -40, 24], [-150, 10, 22], [-200, 70, 24], [-170, 110, 30],
];

export const TRACK_LIST: TrackDef[] = [
  {
    id: 'figure8',
    name: 'Figure Eight',
    description: 'Two strands cross at right angles. Jump the pit where they meet.',
    theme: 'grass',
    laps: 3,
    points: figureEight(),
    hills: 1,
    jump: true,
  },
  {
    id: 'parkland',
    name: 'Parkland',
    description: 'A grassy park circuit: fast sweepers, a chicane, a wide hairpin and an S-bend.',
    theme: 'grass',
    laps: 3,
    hills: 0.8,
    jump: false,
    points: layout(PARKLAND, 0.8),
  },
  {
    id: 'frostbite',
    name: 'Frostbite Run',
    description: 'Wide snowy sweepers, a fast kink, a switchback and a hairpin before the long return.',
    theme: 'snow',
    laps: 3,
    hills: 0.6,
    jump: false,
    points: layout(FROSTBITE, 0.8),
  },
  {
    id: 'granite',
    name: 'Granite Pass',
    description: 'A steep, twisting mountain road: linked bends, a hairpin pair and big elevation changes.',
    theme: 'mountain',
    laps: 3,
    hills: 1.8,
    jump: false,
    points: layout(GRANITE, 0.8),
  },
];

/** The circuit for the nth race of a career (0-based). */
export function trackForRace(raceNumber: number): TrackDef {
  return TRACK_LIST[raceNumber % TRACK_LIST.length];
}

/** Rough length of the circuit in metres. */
export function trackLength(def: TrackDef): number {
  const curve = new THREE.CatmullRomCurve3(
    def.points.map(([x, z]) => new THREE.Vector3(x, 0, z)),
    true,
    'centripetal',
  );
  return curve.getLength();
}
