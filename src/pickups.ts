import * as THREE from 'three';
import type { Car } from './car';
import type { Track } from './track';

export type PickupKind = 'ammo' | 'nitro' | 'repair' | 'gun' | 'rear' | 'oil' | 'shield' | 'cash';

const SPOT_COUNT = 16;
const SPOT_LANES = [4.5, -4.5, 0, 4, -4, 1.5, -1.5]; // metres from the centreline, cycled along the lap
const RESPAWN_TIME = 40; // seconds after being taken
const COLLECT_RADIUS = 1.9;
const COLLECT_HEIGHT = 1.8;
const KIND_WEIGHTS: [PickupKind, number][] = [['ammo', 0.14], ['nitro', 0.11], ['repair', 0.19], ['gun', 0.11], ['rear', 0.1], ['oil', 0.09], ['shield', 0.09], ['cash', 0.17]];

/** What each kind gives. */
const AMMO_GIFT = { missiles: 3, mines: 3 };
const NITRO_GIFT = 1;
const REPAIR_GIFT = 45;
const GUN_GIFT = 60;
const REAR_GIFT = 3;
const OIL_GIFT = 2;
const SHIELD_GIFT = 8; // seconds
/** Cash crates are worth one of these, picked when the crate appears (coins on the crate show which). */
const CASH_VALUES: [number, number][] = [[50, 0.5], [100, 0.33], [150, 0.17]];

/** Map-marker colours for the minimap. */
export const PICKUP_COLOURS: Record<PickupKind, string> = { ammo: '#e0c030', nitro: '#3f9bff', repair: '#ffffff', gun: '#ff8a30', rear: '#ff4a4a', oil: '#a070ff', shield: '#40e0d0', cash: '#ffd23a' };

export interface PickupSpot {
  readonly x: number;
  readonly z: number;
  readonly y: number;
  readonly index: number; // nearest track sample
  readonly lane: number; // offset along the track's side vector
  kind: PickupKind;
  value: number; // cash crates: dollars
  active: boolean;
  timer: number; // seconds until it is back, while inactive
}

/** Could this car use the pickup at all (anything short of full)? Decides whether driving over it takes it. */
export function canUse(car: Car, kind: PickupKind): boolean {
  if (car.wrecked) return false;
  if (kind === 'ammo') return car.ammoRoom('missiles') > 0 || car.ammoRoom('mines') > 0;
  if (kind === 'nitro') return car.ammoRoom('nitro') > 0;
  if (kind === 'gun') return car.ammoRoom('bullets') > 0;
  if (kind === 'rear') return car.ammoRoom('rearMissiles') > 0;
  if (kind === 'oil') return car.ammoRoom('oil') > 0;
  if (kind === 'shield') return car.shieldTimer < 4;
  if (kind === 'cash') return !car.wrecked;
  return car.health < car.stats.maxHealth;
}

/** Is it worth a detour? Used by the AI so it does not chase a crate it barely benefits from. */
export function worthChasing(car: Car, kind: PickupKind): boolean {
  if (!canUse(car, kind)) return false;
  if (kind === 'ammo') return car.ammoRoom('missiles') >= 2 || car.ammoRoom('mines') >= 2;
  if (kind === 'repair') return car.health < car.stats.maxHealth * 0.8;
  if (kind === 'gun') return car.ammoRoom('bullets') >= 40;
  if (kind === 'rear') return car.ammoRoom('rearMissiles') >= 2;
  if (kind === 'oil') return car.ammoRoom('oil') >= 2;
  if (kind === 'shield') return car.shieldTimer <= 0;
  if (kind === 'cash') return true;
  return true;
}

/** Hand the pickup's contents to the car. Returns a short description of what it got, or null if nothing. */
function apply(car: Car, kind: PickupKind, value: number): string | null {
  const parts: string[] = [];
  if (kind === 'cash') return `+$${value}`;
  if (kind === 'ammo') {
    const m = car.give('missiles', AMMO_GIFT.missiles);
    const n = car.give('mines', AMMO_GIFT.mines);
    if (m) parts.push(`+${m} missile${m > 1 ? 's' : ''}`);
    if (n) parts.push(`+${n} mine${n > 1 ? 's' : ''}`);
  } else if (kind === 'nitro') {
    if (car.give('nitro', NITRO_GIFT)) parts.push('+1 nitro');
  } else if (kind === 'shield') {
    const s = car.giveShield(SHIELD_GIFT);
    if (s) parts.push(`shield ${Math.round(s)}s`);
  } else if (kind === 'oil') {
    const o = car.give('oil', OIL_GIFT);
    if (o) parts.push(`+${o} oil`);
  } else if (kind === 'rear') {
    const r = car.give('rearMissiles', REAR_GIFT);
    if (r) parts.push(`+${r} rear missile${r > 1 ? 's' : ''}`);
  } else if (kind === 'gun') {
    const b = car.give('bullets', GUN_GIFT);
    if (b) parts.push(`+${b} bullets`);
  } else {
    const hp = car.repair(REPAIR_GIFT);
    if (hp) parts.push(`+${Math.round(hp)} HP`);
  }
  return parts.length ? parts.join(' ') : null;
}

function pickCash(): number {
  let r = Math.random();
  for (const [value, weight] of CASH_VALUES) {
    if (r < weight) return value;
    r -= weight;
  }
  return CASH_VALUES[0][0];
}

/** Crates that only make sense with weapons in the race. */
const WEAPON_KINDS: PickupKind[] = ['ammo', 'gun', 'rear', 'oil'];

function pickKind(weapons: boolean): PickupKind {
  const options = KIND_WEIGHTS.filter(([kind]) => weapons || !WEAPON_KINDS.includes(kind));
  let r = Math.random() * options.reduce((sum, [, weight]) => sum + weight, 0);
  for (const [kind, weight] of options) {
    if (r < weight) return kind;
    r -= weight;
  }
  return options[0][0];
}

/** Circular distance from sample i forward to sample `target` (0..n). */
const ahead = (i: number, target: number, n: number) => (target - i + n) % n;

/**
 * Crates at fixed spots along the lap with random contents. Driving over one gives its contents to a car that can
 * use them, then it is gone for a while and comes back with new contents.
 */
export class Pickups {
  readonly spots: PickupSpot[] = [];
  readonly group = new THREE.Group();
  /** With weapons off, no weapon crates appear (they re-roll at the next reset or respawn). */
  weaponsEnabled = true;
  onCollect?: (car: Car, kind: PickupKind, text: string, value: number) => void;

  private readonly models: Record<PickupKind, THREE.Group>[] = [];
  private readonly holders: THREE.Group[] = [];
  private readonly pads: THREE.Mesh[] = [];
  private readonly padColours: Record<PickupKind, THREE.Material>;
  private time = 0;

  constructor(track: Track) {
    const n = track.sampleCount;
    const blocked = (i: number) => {
      if (track.hasJump && ahead(track.gapFrom - 90, i, n) <= track.gapTo + 30 - (track.gapFrom - 90)) return true; // the jump and its run-up
      if (track.hasJump && ahead(track.crossingIndex - 40, i, n) <= 80) return true; // the crossing under the jump
      if (ahead(n - 90, i, n) <= 105) return true; // the starting grid
      return false;
    };
    for (let k = 0, lane = 0; k < SPOT_COUNT; k++) {
      const i = Math.round(((k + 0.5) * n) / SPOT_COUNT) % n;
      if (blocked(i)) continue;
      const s = track.samples[i];
      const side = track.sideVector(i);
      const offset = SPOT_LANES[lane++ % SPOT_LANES.length];
      this.spots.push({
        x: s.p.x + side.x * offset,
        z: s.p.z + side.y * offset,
        y: s.p.y,
        index: i,
        lane: offset,
        kind: 'ammo',
        value: 0,
        active: true,
        timer: 0,
      });
    }
    const shared = this.buildShared();
    this.padColours = shared.padColours;
    for (const spot of this.spots) {
      const holder = new THREE.Group();
      const models = {
        ammo: shared.ammo(),
        nitro: shared.nitro(),
        repair: shared.repair(),
        gun: shared.gun(),
        rear: shared.rear(),
        oil: shared.oil(),
        shield: shared.shield(),
        cash: shared.cash(),
      };
      for (const m of Object.values(models)) holder.add(m);
      const pad = shared.pad();
      holder.add(pad);
      this.pads.push(pad);
      holder.position.set(spot.x, spot.y, spot.z);
      this.group.add(holder);
      this.holders.push(holder);
      this.models.push(models);
    }
    this.reset();
  }

  /** New race: everything back, with fresh random contents. */
  reset(): void {
    for (const spot of this.spots) {
      spot.kind = pickKind(this.weaponsEnabled);
      spot.value = pickCash();
      spot.active = true;
      spot.timer = 0;
    }
    this.syncAll();
  }

  update(dt: number, cars: Car[]): void {
    this.time += dt;
    this.spots.forEach((spot, i) => {
      if (!spot.active) {
        spot.timer -= dt;
        if (spot.timer <= 0) {
          spot.kind = pickKind(this.weaponsEnabled);
          spot.value = pickCash();
          spot.active = true;
          this.sync(i);
        }
        return;
      }
      for (const car of cars) {
        if (!canUse(car, spot.kind)) continue;
        if (Math.hypot(car.x - spot.x, car.z - spot.z) > COLLECT_RADIUS || Math.abs(car.y - spot.y) > COLLECT_HEIGHT) continue;
        const text = apply(car, spot.kind, spot.value);
        if (!text) continue;
        spot.active = false;
        spot.timer = RESPAWN_TIME;
        this.sync(i);
        this.onCollect?.(car, spot.kind, text, spot.value);
        break;
      }
    });
    // Spin and bob the crates that are out.
    this.holders.forEach((_, i) => {
      const spot = this.spots[i];
      if (!spot.active) return;
      const model = this.models[i][spot.kind];
      model.rotation.y = this.time * 1.6 + i;
      model.position.y = 0.75 + 0.15 * Math.sin(this.time * 2.4 + i * 1.7);
    });
  }

  private syncAll(): void {
    this.spots.forEach((_, i) => this.sync(i));
  }

  private sync(i: number): void {
    const spot = this.spots[i];
    const models = this.models[i];
    this.holders[i].visible = spot.active;
    this.pads[i].material = this.padColours[spot.kind];
    for (const kind of Object.keys(models) as PickupKind[]) models[kind].visible = kind === spot.kind;
    // A stack of one, two or three coins for $50, $100, $150.
    (models.cash.userData.coins as THREE.Object3D[]).forEach((coin, k) => (coin.visible = k < spot.value / 50));
  }

  /** Geometry and materials are created once and shared by every crate. */
  private buildShared() {
    const std = (color: number, extra: THREE.MeshStandardMaterialParameters = {}) =>
      new THREE.MeshStandardMaterial({ color, roughness: 0.55, flatShading: true, ...extra });
    const oliveMat = std(0x5a6b2a);
    const yellowMat = std(0xe0c030);
    const blueMat = std(0x2a6fe0, { metalness: 0.4 });
    const steelMat = std(0xc9ccd2, { metalness: 0.6 });
    const whiteMat = std(0xf2f2f2);
    const redMat = std(0xd82020);
    const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
    const crateGeo = box(0.95, 0.6, 0.95);
    const bandGeo = box(1.0, 0.12, 1.0);
    const tankGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.9, 10);
    const capGeo = new THREE.CylinderGeometry(0.14, 0.18, 0.2, 8);
    const kitGeo = box(0.9, 0.55, 0.9);
    const crossA = box(0.56, 0.06, 0.18);
    const crossB = box(0.18, 0.06, 0.56);
    const brassGeo = new THREE.CylinderGeometry(0.07, 0.07, 0.3, 6);
    const darkMat = std(0x34373d, { metalness: 0.5 });
    const brassMat = std(0xd9a53a, { metalness: 0.7 });
    const rearPodGeo = box(1.0, 0.45, 0.8);
    const rocketGeo = new THREE.ConeGeometry(0.15, 0.55, 8).rotateX(-Math.PI / 2);
    const redMat2 = std(0xd83a3a);
    const orbGeo = new THREE.IcosahedronGeometry(0.5, 1);
    const orbMat = std(0x40e0d0, { metalness: 0.2, emissive: 0x1a8a80, emissiveIntensity: 0.8 });
    const ringGeo = new THREE.TorusGeometry(0.62, 0.05, 6, 20).rotateX(Math.PI / 2);
    const coinGeo = new THREE.CylinderGeometry(0.46, 0.46, 0.14, 20);
    const goldMat = std(0xffc82e, { metalness: 0.75, emissive: 0x6b4a00, emissiveIntensity: 0.4 });
    const drumGeo = new THREE.CylinderGeometry(0.4, 0.4, 0.8, 12);
    const drumBandGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.14, 12);
    const drumMat = std(0x16161a, { metalness: 0.4 });
    const gunBoxGeo = box(1.0, 0.5, 0.7);
    const padGeo = new THREE.CircleGeometry(1.15, 20).rotateX(-Math.PI / 2);
    const padColours: Record<PickupKind, THREE.MeshBasicMaterial> = {
      ammo: new THREE.MeshBasicMaterial({ color: 0xe0c030, transparent: true, opacity: 0.35, depthWrite: false }),
      nitro: new THREE.MeshBasicMaterial({ color: 0x3f9bff, transparent: true, opacity: 0.35, depthWrite: false }),
      repair: new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false }),
      gun: new THREE.MeshBasicMaterial({ color: 0xff8a30, transparent: true, opacity: 0.35, depthWrite: false }),
      rear: new THREE.MeshBasicMaterial({ color: 0xff4a4a, transparent: true, opacity: 0.35, depthWrite: false }),
      oil: new THREE.MeshBasicMaterial({ color: 0xa070ff, transparent: true, opacity: 0.35, depthWrite: false }),
      shield: new THREE.MeshBasicMaterial({ color: 0x40e0d0, transparent: true, opacity: 0.35, depthWrite: false }),
      cash: new THREE.MeshBasicMaterial({ color: 0xffd23a, transparent: true, opacity: 0.4, depthWrite: false }),
    };
    const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material, y = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.y = y;
      return m;
    };
    return {
      ammo: () => {
        const g = new THREE.Group();
        g.add(mesh(crateGeo, oliveMat), mesh(bandGeo, yellowMat));
        return g;
      },
      nitro: () => {
        const g = new THREE.Group();
        g.add(mesh(tankGeo, blueMat), mesh(capGeo, steelMat, 0.55));
        return g;
      },
      repair: () => {
        const g = new THREE.Group();
        g.add(mesh(kitGeo, whiteMat), mesh(crossA, redMat, 0.3), mesh(crossB, redMat, 0.3));
        return g;
      },
      // Dark ammo box with a row of brass rounds sticking out of the top.
      gun: () => {
        const g = new THREE.Group();
        g.add(mesh(gunBoxGeo, darkMat));
        for (const x of [-0.3, -0.1, 0.1, 0.3]) {
          const round = mesh(brassGeo, brassMat, 0.4);
          round.position.x = x;
          g.add(round);
        }
        return g;
      },
      // A stack of gold coins; how many are showing tells the value.
      cash: () => {
        const g = new THREE.Group();
        const coins = [0, 1, 2].map((k) => {
          const coin = mesh(coinGeo, goldMat, -0.2 + k * 0.17);
          coin.position.x = k === 1 ? 0.05 : k === 2 ? -0.04 : 0;
          g.add(coin);
          return coin;
        });
        g.userData.coins = coins;
        return g;
      },
      // Glowing teal orb inside a ring.
      shield: () => {
        const g = new THREE.Group();
        g.add(mesh(orbGeo, orbMat), mesh(ringGeo, steelMat));
        return g;
      },
      // Black oil drum with a yellow band.
      oil: () => {
        const g = new THREE.Group();
        g.add(mesh(drumGeo, drumMat), mesh(drumBandGeo, yellowMat));
        return g;
      },
      // Grey launcher pod with two red rocket tips poking out of the back.
      rear: () => {
        const g = new THREE.Group();
        g.add(mesh(rearPodGeo, steelMat));
        for (const x of [-0.25, 0.25]) {
          const rocket = mesh(rocketGeo, redMat2, 0.1);
          rocket.position.set(x, 0.1, -0.55);
          g.add(rocket);
        }
        return g;
      },
      /** Flat disc on the road under the crate, so it reads from the top-down camera; its colour follows the kind. */
      pad: () => mesh(padGeo, padColours.ammo, 0.06),
      padColours,
    };
  }
}
