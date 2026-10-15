import { ACCEL, AXLE_GRIP, BRAKE, DRAG, TURN_DECEL, type Car } from './car';
import type { Controls } from './input';
import { worthChasing, type PickupSpot } from './pickups';
import type { Track } from './track';

/** Half the car plus half a wreck, with a margin: the lateral gap needed to drive past a wreck. */
const WRECK_CLEARANCE = 3.1;
/** A car counts as an obstacle when it is this slow (m/s), or this much slower than us. */
const OBSTACLE_SLOW = 3;
const OBSTACLE_MUCH_SLOWER = 9;
const OBSTACLE_STOP_MARGIN = 5; // metres to keep clear of whatever we are slowing for

const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export interface AiLevel {
  name: string;
  corner: number; // 0..1, higher = carries more speed through bends
  wander: number; // lane wobble amplitude (m)
  steerNoise: number; // steering jitter
  mistakesPerSec: number; // chance per second of a short lapse (steer error + lift)
  racingLine: number; // 0..1, how much the AI cuts toward the inside of bends
  pit: number; // PIT attempts per second while a target is in reach (0 = never)
  pitSkill: number; // 0..1, aim and timing accuracy of a PIT
  missile: number; // missile shots per second while a target is lined up (0 = never)
  mine: number; // mine drops per second while a car is right behind
  oil: number; // oil slicks dropped per second while a car is right behind (0 = never)
  rearMissile: number; // rear missile shots per second while a car is lined up behind (0 = never)
  nitro: number; // nitro bursts per second on a clear straight
  gun: number; // machine-gun bursts started per second while a car is dead ahead (0 = never)
  pickup: number; // 0..1, how far off its line it will go for a crate it wants
}

export const LEVELS: AiLevel[] = [
  { name: 'Rookie', corner: 0.3, wander: 3.0, steerNoise: 0.5, mistakesPerSec: 0.15, racingLine: 0, pit: 0, pitSkill: 0, missile: 0.15, mine: 0.1, rearMissile: 0.1, oil: 0.05, nitro: 0.05, gun: 0.3, pickup: 0.3 },
  { name: 'Pro', corner: 0.65, wander: 1.8, steerNoise: 0.3, mistakesPerSec: 0.06, racingLine: 0.5, pit: 0.4, pitSkill: 0.5, missile: 0.4, mine: 0.25, rearMissile: 0.3, oil: 0.15, nitro: 0.2, gun: 0.8, pickup: 0.7 },
  { name: 'Elite', corner: 0.95, wander: 0.8, steerNoise: 0.12, mistakesPerSec: 0.02, racingLine: 1, pit: 1.2, pitSkill: 0.9, missile: 0.7, mine: 0.4, rearMissile: 0.55, oil: 0.35, nitro: 0.5, gun: 2, pickup: 1 },
];

/**
 * Follows the track spline in its own lane, with human-ish imperfection scaled by AiLevel.
 * Level only affects driving skill and how freely weapons are used; car performance comes from the car's own stats,
 * which do not depend on the level (see RIVAL_CAR_TIER).
 */
export class AiDriver implements Controls {
  throttle = 0;
  brake = 0;
  steer = 0;
  handbrake = 0; // AI drivers never use it
  // Weapon requests for this tick; the game loop acts on them.
  fireMissile = false;
  fireRearMissile = false;
  dropMine = false;
  dropOil = false;
  useNitro = false;
  fireGun = false; // true on every tick of a burst

  private t = 0;
  private lane: number;
  private noise = 0;
  private mistakeLeft = 0;
  private mistakeBias = 0;
  private recovering = false;
  private stun = 0; // seconds of lost control after an impact
  private dodging = false; // a mine is lying in the way, so change lane quickly

  // Stuck handling (typically nose-first against a wreck): reverse away, then take a lane that is clear.
  private stuckTime = 0;
  private unstick = 0; // seconds of reversing left
  private unstickSteer = 0;
  private detourLane: number | null = null;
  private detourUntil = 0;

  // PIT maneuver: 'approach' lines up beside the target's rear quarter, 'strike' steers into it.
  private pitState: 'none' | 'approach' | 'strike' = 'none';
  private pitTarget: Car | null = null;
  private pitSide = 1;
  private pitSpacing = 2.5;
  private pitStrikeGap = 3.9;
  private pitTimer = 0;
  private pitCooldown = 4;
  private missileCooldown = 3;
  private mineCooldown = 3;
  private rearCooldown = 4;
  private oilCooldown = 5;
  private nitroCooldown = 4;
  private gunBurst = 0; // seconds of firing left in the current burst
  private gunCooldown = 2;
  pitsStarted = 0;
  pitsStruck = 0;
  private readonly phase1 = Math.random() * Math.PI * 2;
  private readonly phase2 = Math.random() * Math.PI * 2;

  constructor(
    private readonly car: Car,
    private readonly track: Track,
    private readonly baseLane: number,
    private readonly level: AiLevel,
    private readonly others: () => Car[] = () => [],
    private readonly mines: () => { x: number; z: number }[] = () => [],
    private readonly pickups: () => readonly PickupSpot[] = () => [],
  ) {
    this.lane = baseLane;
  }

  update(dt: number, racing = true): void {
    const { car, track, level } = this;
    const n = track.sampleCount;
    const speed = Math.max(car.vf, 0);
    this.t += dt;
    this.fireMissile = this.fireRearMissile = this.dropMine = this.dropOil = this.useNitro = this.fireGun = false;

    // A hard knock costs the driver a moment of control, longer for less skilled drivers.
    const impact = car.lastImpact;
    car.lastImpact = 0;
    if (impact > 0.6) this.stun = Math.max(this.stun, clamp(impact * 0.4, 0.25, 1.2) * (1.5 - level.corner));
    if (this.stun > 0) {
      this.stun -= dt;
      if (this.pitState !== 'none') this.endPit();
      this.throttle = this.brake = this.steer = 0;
      return;
    }

    if (this.updateStuck(dt, racing)) return;

    // The jump needs near top speed to clear the pit, so every driver commits to a run-up: no lapses,
    // no PIT attempts (they slow the car), and a target speed set by the jump rather than the skill cap.
    const runUp = car.trackIndex >= track.gapFrom - 75 && car.trackIndex <= track.gapTo;
    if (runUp) {
      this.mistakeLeft = 0;
      if (this.pitState !== 'none') this.endPit();
    }

    this.decideWeapons(dt);

    this.pitCooldown -= dt;
    if (!this.recovering && !runUp && this.updatePit(dt, speed)) return;

    const look = Math.round(6 + speed * 0.25);
    const ti = (car.trackIndex + look) % n;
    const target = track.samples[ti];
    const side = track.sideVector(ti);

    const now = track.samples[car.trackIndex].tangent;
    const aheadIdx = (car.trackIndex + look * 2) % n;
    const ahead = track.samples[aheadIdx].tangent;
    const turn = Math.acos(clamp(now.x * ahead.x + now.z * ahead.z, -1, 1));

    // Lane: base slot + slow wobble + (skilled drivers) a shift toward the inside of the next bend.
    const wobble = level.wander * (0.6 * Math.sin(this.t * 0.44 + this.phase1) + 0.4 * Math.sin(this.t * 1.07 + this.phase2));
    const towardInside = Math.sign(ahead.x * side.x + ahead.z * side.y - (now.x * side.x + now.z * side.y)) || 0;
    const cut = towardInside * Math.min(turn, 0.8) * 4 * level.racingLine;
    const limit = track.halfWidth - 2.2;
    let laneTarget = clamp(this.baseLane * (1 - level.racingLine * 0.5) + wobble + cut + this.avoidance(), -limit, limit);
    const crate = runUp ? null : this.pickupLane();
    if (crate !== null) laneTarget = clamp(laneTarget * 0.2 + crate * 0.8, -limit, limit);
    // Wrecks and cars at a standstill do not get out of the way, so plan a clear lane early instead of nudging at the last moment.
    const wreckLane = this.t < this.detourUntil ? this.detourLane : this.clearLaneAround(limit);
    if (wreckLane !== null) {
      laneTarget = clamp(laneTarget * 0.1 + wreckLane * 0.9, -limit, limit);
      this.dodging = true;
    }
    this.lane += (laneTarget - this.lane) * Math.min(1, dt * (this.dodging ? 8 : 2));

    const tx = target.p.x + side.x * this.lane;
    const tz = target.p.z + side.y * this.lane;
    const err = wrapAngle(Math.atan2(tx - car.x, tz - car.z) - car.heading);

    // Steering jitter (Ornstein-Uhlenbeck) plus occasional lapses.
    this.noise += (Math.random() - 0.5) * 4 * level.steerNoise * Math.sqrt(dt) - this.noise * 3 * dt;
    if (this.mistakeLeft > 0) this.mistakeLeft -= dt;
    else if (Math.random() < level.mistakesPerSec * dt) {
      this.mistakeLeft = 0.3 + Math.random() * 0.5;
      this.mistakeBias = (Math.random() < 0.5 ? -1 : 1) * (0.4 + Math.random() * 0.4);
    }
    const lapse = this.mistakeLeft > 0;

    // Spun out or pointing the wrong way: stop, then reverse round (reversing flips the steering sense).
    if (Math.abs(err) > 1.3 && speed < 12) this.recovering = true;
    else if (Math.abs(err) < 0.7) this.recovering = false;
    if (this.recovering) {
      this.throttle = 0;
      this.brake = 1;
      this.steer = car.vf < 0.5 ? -Math.sign(err) : Math.sign(err);
      return;
    }

    this.steer = clamp(err * 2.5 - car.omega * 0.25 + this.noise + (lapse ? this.mistakeBias : 0), -1, 1);

    // Corner speed: highest speed at which the bend's turn drag can still be overcome by the engine
    // (TURN_DECEL * c * v^2 + DRAG * v = accel), checked at two horizons so we brake early enough.
    const budget = ACCEL * car.stats.accel;
    let speedCap = car.topSpeed;
    for (const horizon of [2, 4]) {
      const h = (car.trackIndex + look * horizon) % n;
      const t2 = track.samples[h].tangent;
      const angle = Math.acos(clamp(now.x * t2.x + now.z * t2.z, -1, 1));
      const c = angle / (look * horizon * track.spacing);
      if (c < 1e-4) continue;
      const v = (-DRAG + Math.sqrt(DRAG * DRAG + 4 * TURN_DECEL * c * budget)) / (2 * TURN_DECEL * c);
      // ... and the highest speed the tyres can hold round it (a stock car with worn tyres has to slow down more).
      const vGrip = Math.sqrt((2 * AXLE_GRIP * car.stats.grip * 0.7) / c);
      speedCap = Math.min(speedCap, v, vGrip);
    }
    // Slow for whatever is in the way (and ease off to thread past things beside the line).
    const obstacleCap = this.obstacleSpeedCap();
    const targetSpeed = Math.min(obstacleCap, runUp ? car.topSpeed * (0.93 + 0.07 * level.corner) : speedCap * (0.7 + 0.3 * level.corner));
    this.throttle = !lapse && speed < targetSpeed ? 1 : 0;
    this.brake = speed > targetSpeed * 1.1 ? 1 : 0;
  }

  /** Decide whether to shoot, lay a mine or use nitro this tick, according to the driver's level. */
  private decideWeapons(dt: number): void {
    const { car, track, level } = this;
    this.missileCooldown -= dt;
    this.mineCooldown -= dt;
    this.rearCooldown -= dt;
    this.oilCooldown -= dt;
    this.nitroCooldown -= dt;
    this.gunCooldown -= dt;
    this.gunBurst -= dt;
    if (car.wrecked || car.finished || car.airborne) return;
    // No shooting or mine laying around the jump: a blast there costs a car the speed it needs to clear the pit.
    const inJumpZone = (i: number) => i >= track.gapFrom - 90 && i <= track.gapTo + 5;
    const jumpZone = inJumpZone(car.trackIndex);

    const fx = Math.sin(car.heading);
    const fz = Math.cos(car.heading);
    for (const o of this.others()) {
      if (o === car || o.wrecked || o.finished || !this.onSameStretch(o)) continue;
      if (jumpZone || inJumpZone(o.trackIndex)) continue;
      const rx = o.x - car.x;
      const rz = o.z - car.z;
      const g = rx * fx + rz * fz; // ahead (+) or behind (-)
      const s = rx * fz - rz * fx; // sideways
      if (this.missileCooldown <= 0 && car.ammo.missiles > 0 && g > 6 && g < 45 && Math.abs(s) < 2.2 && Math.random() < level.missile * dt) {
        this.fireMissile = true;
        this.missileCooldown = 4;
      }
      // Short bursts at a car right in front, only when it is lined up closely enough for the narrow cone to hit.
      if (this.gunBurst <= 0 && this.gunCooldown <= 0 && car.ammo.bullets > 0 && g > 5 && g < 40 && Math.abs(s) < 1.6 && Math.random() < level.gun * dt) {
        this.gunBurst = 0.5 + Math.random() * 0.6;
        this.gunCooldown = 2.5;
      }
      // A car tailgating us gets a missile up the tail pipe if it is lined up; otherwise maybe a mine.
      if (this.rearCooldown <= 0 && car.ammo.rearMissiles > 0 && g < -6 && g > -40 && Math.abs(s) < 2.2 && Math.random() < level.rearMissile * dt) {
        this.fireRearMissile = true;
        this.rearCooldown = 4;
        this.mineCooldown = Math.max(this.mineCooldown, 1.5); // not a mine on top of it in the same instant
      }
      // A slick for a car tailing us closely; not on the same tick as a mine.
      if (this.oilCooldown <= 0 && car.ammo.oil > 0 && g < -4 && g > -25 && Math.abs(s) < 3 && Math.random() < level.oil * dt) {
        this.dropOil = true;
        this.oilCooldown = 7;
        this.mineCooldown = Math.max(this.mineCooldown, 2);
      }
      if (this.mineCooldown <= 0 && car.ammo.mines > 0 && g < -5 && g > -30 && Math.abs(s) < 3 && Math.random() < level.mine * dt) {
        this.dropMine = true;
        this.mineCooldown = 5;
      }
    }

    if (this.gunBurst > 0 && car.ammo.bullets > 0 && !jumpZone) this.fireGun = true;

    // Nitro on a clear straight, never anywhere near the jump (it needs a steady, known speed).
    const nearJump = car.trackIndex >= track.gapFrom - 170 && car.trackIndex <= track.gapTo + 15;
    if (this.nitroCooldown <= 0 && car.ammo.nitro > 0 && !car.nitroActive && !nearJump && car.vf > 27) {
      const now = track.samples[car.trackIndex].tangent;
      const ahead = track.samples[(car.trackIndex + 45) % track.sampleCount].tangent;
      if (now.x * ahead.x + now.z * ahead.z > 0.985 && Math.random() < level.nitro * dt) {
        this.useNitro = true;
        this.nitroCooldown = 6;
      }
    }
  }

  /** True for cars close by along the track, so cars on the other strand of the figure 8 are ignored. */
  private onSameStretch(o: Car): boolean {
    const n = this.track.sampleCount;
    const d = Math.abs(o.trackIndex - this.car.trackIndex);
    return Math.min(d, n - d) < 45;
  }

  /** Lane of the nearest wanted crate just ahead and not too far off the current line, or null. */
  private pickupLane(): number | null {
    const { car, level } = this;
    if (level.pickup <= 0 || car.wrecked) return null;
    const n = this.track.sampleCount;
    let best: number | null = null;
    let bestAhead = Infinity;
    for (const spot of this.pickups()) {
      if (!spot.active || !worthChasing(car, spot.kind)) continue;
      const ahead = (spot.index - car.trackIndex + n) % n;
      if (ahead < 4 || ahead > 40 || ahead >= bestAhead) continue;
      if (Math.abs(spot.lane - this.lane) > 2 + 7 * level.pickup) continue;
      best = spot.lane;
      bestAhead = ahead;
    }
    return best;
  }

  /**
   * Things in the way: wrecks, cars standing still or crawling, and cars going much slower than us, within `ahead`
   * samples in front (and a few behind). Each comes with its lane, how far ahead it is (m, along our heading) and its
   * own speed. Cars keeping up with us are not obstacles; they are handled by the lighter avoidance().
   */
  private obstaclesNear(ahead: number, behind = 6, wrecksOnly = false): { lane: number; dist: number; gap: number; speed: number }[] {
    const { car, track } = this;
    const n = track.sampleCount;
    const fx = Math.sin(car.heading);
    const fz = Math.cos(car.heading);
    const ours = Math.max(car.vf, 0);
    const out: { lane: number; dist: number; gap: number; speed: number }[] = [];
    for (const o of this.others()) {
      if (o === car || o.airborne) continue;
      const blocking = o.wrecked || (!wrecksOnly && (o.vf < OBSTACLE_SLOW || ours - o.vf > OBSTACLE_MUCH_SLOWER));
      if (!blocking) continue;
      let d = (o.trackIndex - car.trackIndex + n) % n;
      if (d > n / 2) d -= n; // signed samples ahead
      if (d < -behind || d > ahead) continue;
      out.push({
        lane: track.query(o.x, o.z, o.trackIndex).lateral,
        dist: d,
        gap: (o.x - car.x) * fx + (o.z - car.z) * fz,
        speed: o.wrecked ? 0 : Math.max(o.vf, 0),
      });
    }
    return out;
  }

  /** How far ahead (samples) a driver looks for obstacles: further when going fast, and less for careless drivers. */
  private lookAhead(): number {
    return Math.round((18 + Math.max(this.car.vf, 0) * 1.1) * (0.6 + 0.4 * this.level.corner));
  }

  /**
   * The lane with the most room between the obstacles ahead, or null when none of them is near the lane we are on.
   * Obstacles that overlap the way are treated together, so a cluster is passed on its open side.
   */
  private clearLaneAround(limit: number): number | null {
    const obstacles = this.obstaclesNear(this.lookAhead());
    if (!obstacles.some((w) => Math.abs(w.lane - this.lane) < WRECK_CLEARANCE + 1.2)) return null;
    return this.bestLane(obstacles, limit);
  }

  /**
   * A speed that lets the car stop (or match the obstacle's speed) before reaching the nearest thing that is in its
   * lane, braking comfortably; near-misses in the next lane just ease the speed a little. Infinity when the way is clear.
   */
  private obstacleSpeedCap(): number {
    const { car } = this;
    let cap = Infinity;
    for (const o of this.obstaclesNear(this.lookAhead(), 0)) {
      if (o.gap <= 0) continue;
      const lateral = Math.abs(o.lane - this.lane);
      if (lateral < WRECK_CLEARANCE) {
        const room = Math.max(o.gap - OBSTACLE_STOP_MARGIN, 0);
        const comfortable = BRAKE * car.stats.brake * 0.5;
        cap = Math.min(cap, o.speed + Math.sqrt(2 * comfortable * room));
      } else if (lateral < WRECK_CLEARANCE + 1.5 && o.gap < 25) {
        cap = Math.min(cap, Math.max(o.speed + 9, 14));
      }
    }
    return cap;
  }

  private bestLane(wrecks: { lane: number }[], limit: number): number | null {
    if (!wrecks.length) return null;
    let best = this.lane;
    let bestScore = -Infinity;
    for (let lane = -limit; lane <= limit; lane += 0.5) {
      const room = Math.min(...wrecks.map((w) => Math.abs(w.lane - lane)));
      // Room beyond what the car needs is worth little; staying close to the current lane is worth a bit.
      const score = Math.min(room, WRECK_CLEARANCE + 1) - 0.06 * Math.abs(lane - this.lane);
      if (score > bestScore) {
        bestScore = score;
        best = lane;
      }
    }
    return best;
  }

  /**
   * Detects a car that is pinned (usually nose-first against a wreck) and gets it out: reverse away turning the nose
   * to the open side, then drive on in a clear lane. Returns true while it is controlling the car.
   */
  private updateStuck(dt: number, racing: boolean): boolean {
    const { car } = this;
    if (this.unstick > 0) {
      this.unstick -= dt;
      this.throttle = 0;
      this.brake = 1; // from a standstill, braking drives the car backwards
      this.steer = this.unstickSteer;
      if (this.unstick <= 0) {
        const limit = this.track.halfWidth - 2.2;
        this.detourLane = this.bestLane(this.obstaclesNear(30, 10, true), limit);
        this.detourUntil = this.t + 4;
        this.stuckTime = 0;
      }
      return true;
    }
    const pinned = racing && !this.recovering && !car.wrecked && !car.airborne && car.speed < 1.5 && this.throttle > 0.5;
    this.stuckTime = pinned ? this.stuckTime + dt : Math.max(0, this.stuckTime - dt * 2);
    if (this.stuckTime < 1.2) return false;

    // Back away from whatever is in front, nose swinging toward the free side.
    const fx = Math.sin(car.heading);
    const fz = Math.cos(car.heading);
    let blocker: Car | null = null;
    let blockerDist = 9;
    for (const o of this.others()) {
      if (o === car) continue;
      const rx = o.x - car.x;
      const rz = o.z - car.z;
      const dist = Math.hypot(rx, rz);
      if (dist < blockerDist && rx * fx + rz * fz > 0) { blocker = o; blockerDist = dist; }
    }
    let s = Math.random() < 0.5 ? 1 : -1;
    if (blocker) s = (blocker.x - car.x) * fz - (blocker.z - car.z) * fx || s;
    this.unstickSteer = Math.sign(s); // reversing, steering toward the blocker swings the nose away from it
    this.unstick = 1.0 + Math.random() * 0.5;
    return true;
  }

  /** Offset (along the track's side axis) that steers around slower cars directly ahead. */
  private avoidance(): number {
    const { car } = this;
    const fx = Math.sin(car.heading);
    const fz = Math.cos(car.heading);
    let offset = 0;
    for (const o of this.others()) {
      if (o === car || o.wrecked || o.airborne || !this.onSameStretch(o)) continue; // wrecks and crawlers: see clearLaneAround
      const rx = o.x - car.x;
      const rz = o.z - car.z;
      const g = rx * fx + rz * fz;
      const s = rx * fz - rz * fx;
      if (g < 1 || g > 18 || Math.abs(s) > 2.8) continue;
      // The car's +lateral axis points opposite to the track's side vector.
      offset += (s >= 0 ? 1 : -1) * 3.2 * (1 - g / 18);
    }
    // Careful drivers steer round mines lying ahead.
    this.dodging = false;
    if (this.level.corner > 0.5) {
      for (const m of this.mines()) {
        const rx = m.x - car.x;
        const rz = m.z - car.z;
        const g = rx * fx + rz * fz;
        const s = rx * fz - rz * fx;
        if (g < 2 || g > 28 || Math.abs(s) > 3.4) continue;
        offset += (s >= 0 ? 1 : -1) * 5.2 * (1 - g / 28);
        this.dodging = true;
      }
    }
    return offset;
  }

  /** Runs the PIT state machine. Returns true when it set the controls this tick. */
  private updatePit(dt: number, speed: number): boolean {
    const { car, level } = this;
    if (level.pit <= 0) return false;
    const fx = Math.sin(car.heading);
    const fz = Math.cos(car.heading);
    const gapTo = (o: Car) => {
      const rx = o.x - car.x;
      const rz = o.z - car.z;
      return { g: rx * fx + rz * fz, s: rx * fz - rz * fx };
    };

    if (this.pitState === 'none') {
      if (this.pitCooldown > 0 || car.airborne || car.finished || speed < 20) return false;
      if (Math.random() >= level.pit * dt) return false;
      const now = this.track.samples[car.trackIndex].tangent;
      const ahead = this.track.samples[(car.trackIndex + 25) % this.track.sampleCount].tangent;
      if (now.x * ahead.x + now.z * ahead.z < 0.9) return false; // only on straights and gentle bends

      let best: Car | null = null;
      let bestG = Infinity;
      for (const o of this.others()) {
        if (o === car || o.wrecked || o.finished || o.airborne || o.vf < 15 || !this.onSameStretch(o)) continue;
        const { g, s } = gapTo(o);
        if (g > 9 && g < 28 && Math.abs(s) < 4.5 && g < bestG) { best = o; bestG = g; }
      }
      if (!best) return false;

      const err = 1 - level.pitSkill;
      this.pitTarget = best;
      this.pitSide = gapTo(best).s >= 0 ? 1 : -1;
      this.pitSpacing = 2.5 + (Math.random() * 2 - 1) * err * 1.0;
      this.pitStrikeGap = 3.9 + (Math.random() * 2 - 1) * err * 1.0;
      this.pitTimer = 0;
      this.pitState = 'approach';
      this.pitsStarted++;
    }

    const target = this.pitTarget!;
    this.pitTimer += dt;
    const { g, s } = gapTo(target);
    const abort = target.finished || g < -1 || g > 35 || Math.abs(s) > 9 || this.pitTimer > 5;

    if (this.pitState === 'approach') {
      if (abort) return this.endPit();
      if (g <= this.pitStrikeGap + 0.8 && g > 0 && Math.abs(s) < this.pitSpacing + 1.0) {
        this.pitState = 'strike';
        this.pitsStruck++;
        this.pitTimer = 0;
      } else {
        // Aim for the spot beside the target's rear quarter, in the target's own frame.
        const tfx = Math.sin(target.heading);
        const tfz = Math.cos(target.heading);
        const tx = target.x - tfx * this.pitStrikeGap - tfz * this.pitSide * this.pitSpacing + tfx * 3;
        const tz = target.z - tfz * this.pitStrikeGap + tfx * this.pitSide * this.pitSpacing + tfz * 3;
        const err = wrapAngle(Math.atan2(tx - car.x, tz - car.z) - car.heading);
        this.steer = clamp(err * 2.5 - car.omega * 0.25, -1, 1);
        // Close slowly (about 5 m/s faster than the target) so there is time to line up alongside.
        this.throttle = speed < target.vf + 5 ? 1 : 0;
        this.brake = speed > target.vf + 8 ? 1 : 0;
        return true;
      }
    }

    // Strike: turn into the target's rear quarter, then back off.
    if (this.pitTimer > 0.55) return this.endPit();
    this.steer = this.pitSide;
    this.throttle = 1;
    this.brake = 0;
    return true;
  }

  private endPit(): boolean {
    this.pitState = 'none';
    this.pitTarget = null;
    this.pitCooldown = 8;
    return false;
  }
}
