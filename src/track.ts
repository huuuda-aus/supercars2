import * as THREE from 'three';

export interface TrackSample {
  p: THREE.Vector3;
  tangent: THREE.Vector3; // unit, xz plane
}

export interface TrackQuery {
  index: number;
  height: number;
  lateral: number; // signed distance from centerline (sign only matters for side, abs() for off-track)
  gap: boolean; // true over the pit: no road here, the ground is `pitFloor`
  slope: number; // road gradient (rise per metre) along the direction of increasing sample index
}

import { detectCrossings, SAMPLE_SPACING, settleCrossings, THEMES, type SettledCrossing, type TrackDef } from './tracks';

/** A crossing with its type settled and the strands told apart. */
export interface ResolvedCrossing extends SettledCrossing {
  /** Sample index of the strand that goes over (ramp, bridge) and of the one underneath; for a level crossing a and b. */
  overIndex: number;
  underIndex: number;
}

/** Index used for the jump and crossing on circuits that have none (see the constructor). */
const NO_JUMP = -100000;

const ASPHALT_TILE = 6; // metres of road covered by one texture tile

/** Small tileable tarmac texture: fine grit plus a few coarse stones. Null where there is no DOM (tests). */
function makeAsphaltTexture(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const img = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const g = 90 + (Math.random() - 0.5) * 26; // per-pixel grit around a mid dark grey
    img.data[i * 4] = g;
    img.data[i * 4 + 1] = g + 1;
    img.data[i * 4 + 2] = g + 6;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  for (let i = 0; i < 900; i++) {
    const light = Math.random() < 0.5;
    ctx.fillStyle = light ? 'rgba(150,152,160,0.35)' : 'rgba(30,31,36,0.45)';
    const w = 1 + Math.random() * 2;
    // draw twice (wrapped) so stones crossing an edge still tile seamlessly
    const x = Math.random() * size;
    const y = Math.random() * size;
    for (const [dx, dy] of [[0, 0], [-size, 0], [0, -size], [-size, -size]]) ctx.fillRect(x + dx, y + dy, w, w);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/**
 * Rolling hills and valleys: a few low harmonics of the lap (so the road closes up seamlessly). Slopes stay
 * under ~10% and the crests are far too gentle to launch a car at top speed. The terrain is flattened around
 * the jump so its geometry (and the speed needed to clear it) does not depend on the hills. Shifted so the
 * road never dips below the ground plane.
 */
const ROLLING = [
  { cycles: 2, amplitude: 1.3, phase: 0.6 },
  { cycles: 3, amplitude: 0.9, phase: 2.1 },
  { cycles: 4, amplitude: 0.6, phase: 3.3 },
  { cycles: 6, amplitude: 0.35, phase: 1.3 },
];
const FLAT_BEFORE_JUMP = 24; // samples of flat terrain before the lip (the up ramp is ~20 m long)
const FLAT_AFTER_JUMP = 24; // ... and after the landing lip (the mirrored down ramp is the same length)
const FLAT_BLEND = 35; // samples over which the hills fade back in
// The other strand passes under the jump at ground level: its road is flat at height 0 around the crossing,
// and its barriers are left out where the jump's ramps stand over them.
const CROSSING_FLAT = 30; // samples
const CROSSING_BLEND = 40;
const CROSSING_NO_WALLS = 30;

/** A bridge: the road climbs to this height over the crossing road, with ramps of this length (m) either side. */
const BRIDGE_HEIGHT = 5.5;
const BRIDGE_RAMP = 45;
const BRIDGE_DECK = 0.9; // thickness of the slab under the road

/**
 * The jump: a ramp up to a sharp lip, a pit as long as the road is wide (no road in it), then the same
 * ramp mirrored back down. Both ramps share one profile, so they have identical height and length. A car
 * leaves the lip with vertical speed = speed * (slope at the lip), so `lipSlope` is what makes a car at top
 * speed (30 m/s, gravity 78) clear the pit and land well beyond it. The profile is a curve (flat at the
 * foot, steepening to the lip) so a long ramp is not absurdly tall: the slope falls off as
 * (1 - u/length)^p with u the distance from the lip, and p follows from the height.
 */
const JUMP = { x: 0, z: 0, height: 8, length: 20, lipSlope: 1.7 };

export class Track {
  readonly halfWidth = 9;
  readonly wallOffset = 12; // centerline distance of the barriers
  readonly wallHeight = 1.4;
  readonly wallThickness = 1.4; // extends outward from the collision face
  readonly checkpointCount = 8; // checkpoint 0 is the start/finish line
  readonly samples: TrackSample[] = [];
  readonly mesh: THREE.Mesh;
  readonly walls: THREE.Mesh;
  readonly centreLine: THREE.Mesh;
  readonly kerbs: THREE.Mesh;
  readonly terrain: THREE.Mesh;
  readonly finishLine: THREE.Mesh;
  readonly pit: THREE.Mesh;
  readonly spacing: number; // average distance between samples along the ground (m)
  readonly pitFloor = -0.05;
  readonly gapFrom: number; // last road sample before the pit (the lip)
  readonly gapTo: number; // first road sample after the pit (top of the landing ramp)
  readonly respawnIndex: number; // where cars restart after falling into the pit
  readonly crossingIndex: number; // where the other strand passes under the jump (at ground level)
  readonly crossings: ResolvedCrossing[];
  readonly deck: THREE.Mesh; // the slabs under bridges
  private terrainHole: boolean[] = []; // samples where the road is too high above the ground for an embankment beside it
  private readonly bridgeSamples = new Set<number>(); // samples that are on a flyover (for the slab underneath)
  private readonly searchWindow = 40;

  readonly sampleCount: number;
  readonly hasJump: boolean; // a ramp crossing (a pit to jump) exists on this circuit
  /** Middle and half-size of the circuit's footprint, for cameras. */
  readonly centre = new THREE.Vector2();
  readonly extent: number;

  constructor(readonly def: TrackDef) {
    const curve = new THREE.CatmullRomCurve3(
      def.points.map(([x, z]) => new THREE.Vector3(x, 0, z)),
      true,
      'centripetal',
    );
    // About one sample every 1.07 m on any circuit, because the AI and the pickups reason in samples.
    const sampleCount = Math.max(40, Math.round(curve.getLength() / SAMPLE_SPACING));
    this.sampleCount = sampleCount;
    for (let i = 0; i < sampleCount; i++) {
      const t = i / sampleCount;
      const p = curve.getPointAt(t);
      const tangent = curve.getTangentAt(t);
      tangent.y = 0;
      tangent.normalize();
      this.samples.push({ p, tangent });
    }
    let length = 0;
    for (let i = 0; i < sampleCount; i++) {
      const a = this.samples[i].p;
      const b = this.samples[(i + 1) % sampleCount].p;
      length += Math.hypot(b.x - a.x, b.z - a.z);
    }
    this.spacing = length / sampleCount;

    // Without a jump the "gap" and "crossing" indices are parked far outside the track, so that every zone test
    // built on them (AI run-up, weapon bans near the jump...) is simply false.
    this.terrainHole = new Array(sampleCount).fill(false);
    this.crossings = this.resolveCrossings(def);
    const ramp = this.crossings.find((c) => c.type === 'ramp');
    this.hasJump = !!ramp;
    const gap = ramp ? this.jumpLayout(ramp.overIndex) : { from: NO_JUMP, to: NO_JUMP };
    this.crossingIndex = ramp ? ramp.underIndex : NO_JUMP;
    this.addRolling(gap.from, gap.to);
    if (ramp) this.addJump(gap);
    for (const c of this.crossings) if (c.type === 'bridge') this.addBridge(c);
    this.gapFrom = gap.from;
    this.gapTo = gap.to;
    this.respawnIndex = ramp ? (gap.from - 65 + sampleCount) % sampleCount : 0;

    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const { p } of this.samples) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }
    this.centre.set((minX + maxX) / 2, (minZ + maxZ) / 2);
    this.extent = Math.max(maxX - minX, maxZ - minZ) / 2;

    this.mesh = this.buildMesh();
    this.walls = this.buildWalls();
    this.centreLine = this.buildCentreLine();
    this.kerbs = this.buildKerbs();
    this.terrain = this.buildTerrain();
    this.pit = this.buildPit();
    this.deck = this.buildDeck();
    this.finishLine = this.buildFinishLine();
  }

  private addRolling(from: number, to: number): void {
    const n = this.sampleCount;
    const smooth = (t: number) => { const c = Math.min(1, Math.max(0, t)); return c * c * (3 - 2 * c); };
    const heights = this.samples.map((_, i) => {
      const raw = ROLLING.reduce((sum, w) => sum + w.amplitude * Math.sin((2 * Math.PI * w.cycles * i) / n + w.phase), 0) * this.def.hills;
      // Distance in samples from the flat zone around the jump, 0 inside it.
      const outside = Math.max(from - FLAT_BEFORE_JUMP - i, i - (to + FLAT_AFTER_JUMP), 0);
      return raw * smooth(outside / FLAT_BLEND);
    });
    const lowest = Math.min(...heights);
    this.samples.forEach((s, i) => {
      // Ground level (exactly 0) under the jump, easing back into the hills on either side.
      const away = Math.max(this.nearestCrossingDistance(i) - CROSSING_FLAT, 0);
      s.p.y += (heights[i] - lowest) * smooth(away / CROSSING_BLEND);
    });
  }

  /** Distance (samples, round the loop) from sample i to the nearest crossing on either strand; huge when there is none. */
  private nearestCrossingDistance(i: number): number {
    let best = Infinity;
    for (const c of this.crossings) best = Math.min(best, this.loopDistance(i, c.a), this.loopDistance(i, c.b));
    return best;
  }

  private loopDistance(i: number, j: number): number {
    const d = Math.abs(i - j);
    return Math.min(d, this.sampleCount - d);
  }

  /**
   * Find where the circuit crosses itself and settle each crossing: the drawn setting nearest to it (within 40 m), or a
   * plain level crossing. Only one ramp is possible (the AI plans its run-up for one), and it cannot sit within 35
   * samples of the start line; any other falls back to a level crossing.
   */
  private resolveCrossings(def: TrackDef): ResolvedCrossing[] {
    const positions = this.samples.map((s) => ({ x: s.p.x, z: s.p.z }));
    const tangents = this.samples.map((s) => ({ x: s.tangent.x, z: s.tangent.z }));
    const settings = def.crossings ?? (def.jump ? [{ x: 0, z: 0, type: 'ramp' as const, over: 'first' as const }] : []);
    return settleCrossings(detectCrossings(positions, tangents), settings, this.sampleCount).map((c) => ({
      ...c,
      overIndex: c.over === 'first' ? c.a : c.b,
      underIndex: c.over === 'first' ? c.b : c.a,
    }));
  }

  /** Which samples are the lip and the landing of the jump (the pit lies between them). */
  private jumpLayout(centre: number): { from: number; to: number } {
    // The road it crosses over, plus a metre each side, in an even number of samples so the pit is centred on the crossing.
    const span = 2 * Math.ceil((2 * this.halfWidth + 2) / this.spacing / 2);
    const from = centre - Math.floor(span / 2);
    return { from, to: from + span };
  }

  /**
   * Raise the road into a flyover across a crossing: it climbs on smooth ramps to a deck long enough to span the other
   * road (longer when the roads cross at a shallow angle). The embankments beside the raised stretch are dropped so the
   * road underneath can run through.
   */
  private addBridge(c: ResolvedCrossing): void {
    const n = this.sampleCount;
    const ramp = Math.round(BRIDGE_RAMP / this.spacing);
    const deckHalf = Math.round(Math.min(45, Math.max(16, (this.halfWidth + 4) / Math.max(Math.sin(c.angle), 0.35))) / this.spacing);
    const smooth = (t: number) => { const x = Math.min(1, Math.max(0, t)); return x * x * (3 - 2 * x); };
    for (let k = -(ramp + deckHalf); k <= ramp + deckHalf; k++) {
      const i = (((c.overIndex + k) % n) + n) % n;
      const lift = BRIDGE_HEIGHT * smooth((ramp + deckHalf - Math.abs(k)) / ramp);
      this.samples[i].p.y += lift;
      if (lift > 0.9) this.terrainHole[i] = true;
      if (lift > 0.15) this.bridgeSamples.add(i);
    }
  }

  /** Builds the ramp-pit-ramp profile on top of the rolling terrain. */
  private addJump({ from, to }: { from: number; to: number }): void {
    const span = to - from;
    const height = JUMP.height;
    const p = (JUMP.lipSlope * JUMP.length) / height - 1; // curve exponent; needs lipSlope * length >= height
    /** How far the ramp surface lies below the lip at distance u from it (same on both sides of the pit). */
    const drop = (u: number) =>
      ((JUMP.lipSlope * JUMP.length) / (p + 1)) * (1 - Math.pow(1 - Math.min(u, JUMP.length) / JUMP.length, p + 1));

    for (let k = 0; k * this.spacing <= JUMP.length; k++) {
      this.samples[from - k].p.y += height - drop(k * this.spacing); // on-ramp
      this.samples[to + k].p.y += height - drop(k * this.spacing); // off-ramp: the mirror image
    }
    // The pit samples carry a flat surface between the two lips; it is only used for the barriers.
    const y0 = this.samples[from].p.y;
    const y1 = this.samples[to].p.y;
    for (let i = from + 1; i < to; i++) this.samples[i].p.y += y0 + ((y1 - y0) * (i - from)) / span;
  }

  /**
   * No barrier here: another road goes over the top of this one (the strand underneath a ramp or bridge).
   */
  private wallsOmitted(i: number): boolean {
    for (const c of this.crossings) {
      // (Level crossings are not here: their walls are trimmed exactly to the other road, see levelCrossingClearance.)
      if (c.type !== 'level' && this.loopDistance(i, c.underIndex) <= CROSSING_NO_WALLS) return true;
    }
    return false;
  }

  /**
   * The underside of the lowest bridge deck above height `belowY` that covers the ground position (x, z), or Infinity if
   * nothing is overhead. For keeping a camera from poking through a flyover.
   */
  ceilingAt(x: number, z: number, belowY: number): number {
    if (!this.bridgeSamples.size) return Infinity;
    const reach = this.wallOffset + this.wallThickness + this.spacing;
    let ceiling = Infinity;
    for (const i of this.bridgeSamples) {
      const p = this.samples[i].p;
      const underside = p.y - BRIDGE_DECK;
      if (underside <= belowY || underside >= ceiling) continue;
      if ((p.x - x) ** 2 + (p.z - z) ** 2 <= reach * reach) ceiling = underside;
    }
    return ceiling;
  }

  /** Sample i lies where another road crosses this one on the same level: no edge lines or kerbs there. */
  private inLevelCrossing(i: number): boolean {
    for (const c of this.crossings) {
      if (c.type !== 'level') continue;
      // Half the stretch the other road covers along this one: wider when the roads cross at a shallow angle.
      const half = Math.ceil((this.halfWidth + 3) / Math.max(Math.sin(c.angle), 0.35) / this.spacing);
      if (this.loopDistance(i, c.a) <= half || this.loopDistance(i, c.b) <= half) return true;
    }
    return false;
  }

  /** The slabs under the raised stretches of road (bridges), so the flyover has a visible thickness. */
  private buildDeck(): THREE.Mesh {
    const n = this.sampleCount;
    const pos: number[] = [];
    const idx: number[] = [];
    // The slab reaches out to the barriers (the shoulder beside a flyover is concrete, there is no bank there).
    const hw = this.wallOffset + this.wallThickness;
    for (let i = 0; i < n; i++) {
      const next = (i + 1) % n;
      if (!this.bridgeSamples.has(i) || !this.bridgeSamples.has(next)) continue;
      const corner = (k: number, side: number, drop: number) => {
        const { p, tangent } = this.samples[k];
        return [p.x - tangent.z * hw * side, p.y - drop, p.z + tangent.x * hw * side];
      };
      const base = pos.length / 3;
      // The four corners of this slab segment at the top (road level) and the bottom (a slab below), left and right.
      pos.push(...corner(i, 1, 0.04), ...corner(i, -1, 0.04), ...corner(next, 1, 0.04), ...corner(next, -1, 0.04));
      pos.push(...corner(i, 1, BRIDGE_DECK), ...corner(i, -1, BRIDGE_DECK), ...corner(next, 1, BRIDGE_DECK), ...corner(next, -1, BRIDGE_DECK));
      // sides (left, right) and underside
      idx.push(base, base + 2, base + 4, base + 4, base + 2, base + 6);
      idx.push(base + 1, base + 5, base + 3, base + 3, base + 5, base + 7);
      idx.push(base + 4, base + 6, base + 5, base + 5, base + 6, base + 7);
      // the top surface out to the barriers (the road mesh lies just above it)
      idx.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: 0x8e929a, side: THREE.DoubleSide }));
  }

  /** The quad between samples k and k+1 lies over the pit. */
  private isGapQuad(k: number): boolean {
    return k >= this.gapFrom && k < this.gapTo;
  }

  /** Road surface: tarmac texture tiled along the track, no stripes. */
  private buildMesh(): THREE.Mesh {
    const n = this.sampleCount;
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    const across = (2 * this.halfWidth) / ASPHALT_TILE;
    let dist = 0;
    // One extra pair of vertices closes the loop, so the texture coordinate keeps running.
    for (let i = 0; i <= n; i++) {
      const { p, tangent } = this.samples[i % n];
      if (i > 0) dist += p.distanceTo(this.samples[i - 1].p);
      const left = new THREE.Vector3(-tangent.z, 0, tangent.x); // perpendicular to tangent in xz
      const a = p.clone().addScaledVector(left, this.halfWidth);
      const b = p.clone().addScaledVector(left, -this.halfWidth);
      pos.push(a.x, a.y + 0.02, a.z, b.x, b.y + 0.02, b.z);
      const v = dist / ASPHALT_TILE;
      uv.push(0, v, across, v);
      if (i < n && !this.isGapQuad(i)) idx.push(i * 2, i * 2 + 1, (i + 1) * 2, (i + 1) * 2, i * 2 + 1, (i + 1) * 2 + 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    const map = makeAsphaltTexture();
    const material = map
      ? new THREE.MeshLambertMaterial({ map, side: THREE.DoubleSide })
      : new THREE.MeshLambertMaterial({ color: 0x4a4c55, side: THREE.DoubleSide });
    return new THREE.Mesh(g, material);
  }

  /**
   * Red/white striped kerbs on the inside edge of the sharper bends, just outside the edge line.
   * Visual only; they sit at road level on the shoulder.
   */
  private buildKerbs(): THREE.Mesh {
    const n = this.sampleCount;
    const TURN_RATE = 0.022; // rad/m; tighter than this (radius under ~45 m) gets kerbs
    const smoothHalf = 5;
    const stripe = Math.max(1, Math.round(3 / this.spacing));
    const width = 1.4;
    const inner = this.halfWidth - 0.3; // tuck under the edge line so there is no gap
    // Signed turn rate per sample: positive = bending toward the left vector.
    const raw: number[] = [];
    for (let i = 0; i < n; i++) {
      const t = this.samples[i].tangent;
      const u = this.samples[(i + 1) % n].tangent;
      raw.push((t.x * u.z - t.z * u.x) / this.spacing); // cross(t, u) ~ sin(turn angle)
    }
    const rate = raw.map((_, i) => {
      let sum = 0;
      for (let d = -smoothHalf; d <= smoothHalf; d++) sum += raw[(i + d + n) % n];
      return sum / (2 * smoothHalf + 1);
    });
    const pos: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    const red = [0.82, 0.1, 0.1];
    const white = [0.95, 0.95, 0.95];
    for (let k = 0; k < n; k++) {
      if ((k >= this.gapFrom && k < this.gapTo) || this.inLevelCrossing(k)) continue;
      const r = rate[k];
      if (Math.abs(r) < TURN_RATE) continue;
      // The inside of the bend is the side the tangent turns toward.
      const a = this.samples[k];
      const b = this.samples[(k + 1) % n];
      const left = { x: -a.tangent.z, z: a.tangent.x };
      const side = (b.tangent.x - a.tangent.x) * left.x + (b.tangent.z - a.tangent.z) * left.z >= 0 ? 1 : -1;
      const color = Math.floor(k / stripe) % 2 === 0 ? red : white;
      const base = pos.length / 3;
      for (const s of [a, b]) {
        const lx = -s.tangent.z;
        const lz = s.tangent.x;
        for (const off of [inner, inner + width]) {
          pos.push(s.p.x + lx * side * off, s.p.y + 0.05, s.p.z + lz * side * off);
          col.push(...color);
        }
      }
      idx.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const material = new THREE.MeshLambertMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    return new THREE.Mesh(g, material);
  }

  /** Solid white edge lines along both sides of the road, following the elevation (named centreLine for legacy reasons). */
  private buildCentreLine(): THREE.Mesh {
    const n = this.sampleCount;
    const lineHalf = 0.15;
    const inset = 0.5; // centre of each line, from the road edge
    const pos: number[] = [];
    const idx: number[] = [];
    for (const side of [1, -1]) {
      const offset = side * (this.halfWidth - inset);
      let base = -1; // vertex index of the previous sample in the current run, -1 when a run is not open
      for (let k = 0; k <= n; k++) {
        const over = (k > this.gapFrom && k < this.gapTo) || this.inLevelCrossing(k % n); // no road over the pit; no edge line across another road
        if (over) {
          base = -1;
          continue;
        }
        const { p, tangent } = this.samples[k % n];
        const lx = -tangent.z;
        const lz = tangent.x;
        const c = pos.length / 3;
        pos.push(
          p.x + lx * (offset + lineHalf), p.y + 0.04, p.z + lz * (offset + lineHalf),
          p.x + lx * (offset - lineHalf), p.y + 0.04, p.z + lz * (offset - lineHalf),
        );
        if (base >= 0) idx.push(base, base + 1, c, c, base + 1, c + 1);
        base = c;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const material = new THREE.MeshLambertMaterial({
      color: 0xf4f4f4,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    return new THREE.Mesh(g, material);
  }

  /** Chequered start/finish line across the road at sample 0, where laps are counted. */
  private buildFinishLine(): THREE.Mesh {
    const n = this.sampleCount;
    const cols = Math.round(2 * this.halfWidth); // roughly 1 m squares, as deep as the sample spacing
    const rows = 4;
    const first = -Math.floor(rows / 2);
    const white = new THREE.Color(0xf4f4f4);
    const black = new THREE.Color(0x141414);
    const pos: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    const point = (sample: number, c: number) => {
      const { p, tangent } = this.samples[((sample % n) + n) % n];
      const lateral = -this.halfWidth + (c / cols) * 2 * this.halfWidth;
      return [p.x - tangent.z * lateral, p.y + 0.05, p.z + tangent.x * lateral];
    };
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const base = pos.length / 3;
        pos.push(...point(first + r, c), ...point(first + r, c + 1), ...point(first + r + 1, c), ...point(first + r + 1, c + 1));
        const color = (r + c) % 2 === 0 ? white : black;
        for (let k = 0; k < 4; k++) col.push(color.r, color.g, color.b);
        idx.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return new THREE.Mesh(
      g,
      new THREE.MeshLambertMaterial({
        vertexColors: true,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -3,
        polygonOffsetUnits: -3,
      }),
    );
  }

  /**
   * Solid ground around the road so raised sections read as ramps: a shoulder at road height out to
   * the barriers, then a 45 degree embankment dropping to the ground. Both vanish where the road is flat.
   */
  private buildTerrain(): THREE.Mesh {
    const n = this.sampleCount;
    const pos: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    // Multiplied with the grass texture, so grass is plain white and dirt is a warm tint.
    const style = THEMES[this.def.theme];
    const grass = new THREE.Color(style.shoulder);
    const dirt = new THREE.Color(style.embankment);
    const groundY = -0.05;
    const outer = this.wallOffset + this.wallThickness;

    const addStrip = (side: number, rail: (i: number) => [number, number, THREE.Color][]) => {
      const base = pos.length / 3;
      for (let i = 0; i < n; i++) {
        const { p, tangent } = this.samples[i];
        for (const [d, y, c] of rail(i)) {
          pos.push(p.x - tangent.z * d * side, y, p.z + tangent.x * d * side);
          col.push(c.r, c.g, c.b);
        }
      }
      for (let i = 0; i < n; i++) {
        if (this.isGapQuad(i) || this.terrainHole[i] || this.terrainHole[(i + 1) % n]) continue;
        const a = base + i * 2;
        const b = base + ((i + 1) % n) * 2;
        idx.push(a, a + 1, b, b, a + 1, b + 1);
      }
    };

    for (const side of [1, -1]) {
      const h = (i: number) => this.samples[i].p.y;
      addStrip(side, (i) => [[this.halfWidth, h(i), grass], [outer, h(i), grass]]); // shoulder
      addStrip(side, (i) => [[outer, h(i), dirt], [outer + Math.max(h(i), 0), groundY, grass]]); // embankment
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  }

  /**
   * Barriers with real thickness: an inner face, a top and an outer face per side. The top is the
   * face a top-down camera sees, so it gets its own light colour. Collision uses the inner face.
   */
  private buildWalls(): THREE.Mesh {
    const n = this.sampleCount;
    const pos: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    const sideColor = new THREE.Color(0xa9adb5);
    const topColor = new THREE.Color(0xf2f2f2);
    const inner = this.wallOffset;
    const outer = this.wallOffset + this.wallThickness;
    const H = this.wallHeight;

    // How far each wall point is outside the other road's corridor at a level crossing (negative = inside it), per side.
    const edge = [this.levelCrossingClearance(1), this.levelCrossingClearance(-1)];
    const sides = [1, -1];

    /** The part (fractions of the quad from sample i to i+1) of a side's wall that is built, or null. */
    const kept = (i: number, s: number): [number, number] | null => {
      if (this.isGapQuad(i) || this.wallsOmitted(i)) return null;
      const f0 = edge[s === 1 ? 0 : 1][i];
      const f1 = edge[s === 1 ? 0 : 1][(i + 1) % n];
      if (f0 >= 0 && f1 >= 0) return [0, 1];
      if (f0 < 0 && f1 < 0) return null;
      const t = f0 / (f0 - f1); // where the wall leaves (or enters) the other road's corridor
      return f0 >= 0 ? [0, t] : [t, 1];
    };

    /** A point on a rail of the wall (lateral offset d, height h above the road) a fraction t along quad i. */
    const rail = (i: number, t: number, s: number, d: number, h: number): number[] => {
      const A = this.samples[i];
      const B = this.samples[(i + 1) % n];
      let tx = A.tangent.x + (B.tangent.x - A.tangent.x) * t;
      let tz = A.tangent.z + (B.tangent.z - A.tangent.z) * t;
      const len = Math.hypot(tx, tz) || 1;
      tx /= len;
      tz /= len;
      return [A.p.x + (B.p.x - A.p.x) * t - tz * d * s, A.p.y + (B.p.y - A.p.y) * t + h, A.p.z + (B.p.z - A.p.z) * t + tx * d * s];
    };

    const quad = (a: number[], b: number[], c: number[], d: number[], color: THREE.Color) => {
      const base = pos.length / 3;
      for (const v of [a, b, c, d]) {
        pos.push(...v);
        col.push(color.r, color.g, color.b);
      }
      idx.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
    };

    for (const s of sides) {
      for (let i = 0; i < n; i++) {
        const range = kept(i, s);
        if (!range) continue;
        const [t0, t1] = range;
        // road-facing face, top, outer face
        quad(rail(i, t0, s, inner, 0), rail(i, t0, s, inner, H), rail(i, t1, s, inner, 0), rail(i, t1, s, inner, H), sideColor);
        quad(rail(i, t0, s, inner, H), rail(i, t0, s, outer, H), rail(i, t1, s, inner, H), rail(i, t1, s, outer, H), topColor);
        quad(rail(i, t0, s, outer, H), rail(i, t0, s, outer, 0), rail(i, t1, s, outer, H), rail(i, t1, s, outer, 0), sideColor);
        // End caps where the wall stops (at a crossing, or beside the pit), so it ends in a clean solid face.
        const before = kept((i + n - 1) % n, s);
        const after = kept((i + 1) % n, s);
        if (t0 > 1e-6 || !before || before[1] < 1 - 1e-6) {
          quad(rail(i, t0, s, inner, 0), rail(i, t0, s, outer, 0), rail(i, t0, s, inner, H), rail(i, t0, s, outer, H), sideColor);
        }
        if (t1 < 1 - 1e-6 || !after || after[0] > 1e-6) {
          quad(rail(i, t1, s, inner, 0), rail(i, t1, s, outer, 0), rail(i, t1, s, inner, H), rail(i, t1, s, outer, H), sideColor);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  }

  /**
   * For each sample, how far its wall (on one side) is clear of the road that crosses it on the same level: the distance
   * from the wall's inner face to the other road's centreline, minus the wall offset. Positive = the wall stands,
   * negative = it is inside the other road's corridor and must stop. Infinity away from any level crossing.
   */
  private levelCrossingClearance(side: number): Float32Array {
    const n = this.sampleCount;
    const out = new Float32Array(n).fill(Infinity);
    for (const c of this.crossings) {
      if (c.type !== 'level') continue;
      const zone = Math.min(110, Math.ceil((this.wallOffset + this.wallThickness + 4) / Math.max(Math.sin(c.angle), 0.3) / this.spacing) + 8);
      for (const [own, other] of [[c.a, c.b], [c.b, c.a]]) {
        for (let k = -zone; k <= zone; k++) {
          const i = (((own + k) % n) + n) % n;
          const { p, tangent } = this.samples[i];
          const x = p.x - tangent.z * this.wallOffset * side;
          const z = p.z + tangent.x * this.wallOffset * side;
          out[i] = Math.min(out[i], this.distanceToStrand(x, z, other, zone + 25) - this.wallOffset);
        }
      }
    }
    return out;
  }

  /** Distance from (x, z) to the road's centreline within `reach` samples either side of sample `centre`. */
  private distanceToStrand(x: number, z: number, centre: number, reach: number): number {
    const n = this.sampleCount;
    let best = Infinity;
    for (let k = -reach; k < reach; k++) {
      const a = this.samples[(((centre + k) % n) + n) % n].p;
      const b = this.samples[(((centre + k + 1) % n) + n) % n].p;
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len2 = dx * dx + dz * dz || 1;
      const u = Math.min(1, Math.max(0, ((x - a.x) * dx + (z - a.z) * dz) / len2));
      best = Math.min(best, Math.hypot(x - (a.x + dx * u), z - (a.z + dz * u)));
    }
    return best;
  }

  /** The two sheer faces of the ramps either side of the gap. The ground beneath is the other road and grass. */
  private buildPit(): THREE.Mesh {
    if (!this.hasJump) return new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    const outer = this.wallOffset + this.wallThickness;
    const floor = this.pitFloor + 0.01;
    const face = new THREE.Color(THEMES[this.def.theme].embankment).multiplyScalar(0.8); // the cut earth, a shade darker than the bank
    const dirt = new THREE.Color(THEMES[this.def.theme].embankment);
    const pos: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    const quad = (pts: number[][], color: THREE.Color) => {
      const base = pos.length / 3;
      for (const q of pts) {
        pos.push(...q);
        col.push(color.r, color.g, color.b);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    const at = (sample: number, lateral: number, y: number) => {
      const { p, tangent } = this.samples[sample];
      return [p.x - tangent.z * lateral, y, p.z + tangent.x * lateral];
    };
    for (const sample of [this.gapFrom, this.gapTo]) {
      const top = this.samples[sample].p.y;
      // The cut face is the whole cross-section of the ramp: the road and shoulders, and the banks that slope down
      // beside them (45 degrees, as wide as they are high). Closing the banks too stops the cut looking hollow.
      const reach = outer + Math.max(top, 0);
      quad([at(sample, -outer, floor), at(sample, outer, floor), at(sample, outer, top), at(sample, -outer, top)], face);
      quad([at(sample, -reach, floor), at(sample, -outer, floor), at(sample, -outer, top), at(sample, -outer, top)], dirt);
      quad([at(sample, outer, floor), at(sample, reach, floor), at(sample, outer, top), at(sample, outer, top)], dirt);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  }

  /** True while a sample index lies in the first half-segment after checkpoint `cp`. */
  inCheckpoint(index: number, cp: number): boolean {
    const spacing = this.sampleCount / this.checkpointCount;
    const delta = (index - cp * spacing + this.sampleCount) % this.sampleCount;
    return delta < spacing / 2;
  }

  /** Unit vector pointing to the +lateral side of the track at a sample. */
  sideVector(index: number): THREE.Vector2 {
    const t = this.samples[index].tangent;
    return new THREE.Vector2(-t.z, t.x);
  }

  /** Nearest centerline sample. Pass lastIndex to search a local window (prevents shortcut jumps). */
  query(x: number, z: number, lastIndex?: number): TrackQuery {
    const n = this.sampleCount;
    let best = 0;
    let bestD = Infinity;
    const test = (i: number) => {
      const s = this.samples[i].p;
      const d = (s.x - x) ** 2 + (s.z - z) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    };
    if (lastIndex === undefined) {
      for (let i = 0; i < n; i++) test(i);
    } else {
      for (let o = -this.searchWindow; o <= this.searchWindow; o++) test((lastIndex + o + n) % n);
    }
    const { p, tangent } = this.samples[best];
    const lateral = (x - p.x) * -tangent.z + (z - p.z) * tangent.x;
    // Interpolate the height toward the neighbouring sample on the car's side. Stepping between samples
    // would give the ground an artificial vertical speed and launch cars over every slope.
    const along = (x - p.x) * tangent.x + (z - p.z) * tangent.z;
    const forward = along >= 0;
    const next = this.samples[forward ? (best + 1) % n : (best - 1 + n) % n].p;
    const height = p.y + (next.y - p.y) * Math.min(1, Math.abs(along) / this.spacing);
    const slope = ((next.y - p.y) / this.spacing) * (forward ? 1 : -1);
    const position = best + along / this.spacing; // continuous sample index
    return { index: best, height, lateral, gap: position > this.gapFrom && position < this.gapTo, slope };
  }
}
