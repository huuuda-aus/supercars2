import type { CarStats } from './car';

/**
 * Car upgrade slots and what each level is worth. This is the data the shop will sell: a car is just a level per
 * slot, and its handling comes from `statsFor`. Level 0 is the stock starter car (shabby on purpose), level 3 is
 * the best on offer. The base physics constants in car.ts are tuned so that stats of about 1 feel like a good car.
 */
export type UpgradeSlot = 'engine' | 'transmission' | 'tyres' | 'brakes' | 'steering' | 'armor' | 'turbo';
export const UPGRADE_SLOTS: UpgradeSlot[] = ['engine', 'transmission', 'tyres', 'brakes', 'steering', 'armor', 'turbo'];
export const MAX_UPGRADE_LEVEL = 3;

export type UpgradeLevels = Record<UpgradeSlot, number>;

/** Which stat each slot drives, and its value at levels 0..3. */
const TABLE: Record<UpgradeSlot, { stat: keyof CarStats; values: number[] }> = {
  engine: { stat: 'accel', values: [0.38, 0.62, 0.86, 1.1] }, // acceleration
  transmission: { stat: 'maxSpeed', values: [0.88, 0.96, 1.04, 1.12] }, // top speed (the jump needs about 24 m/s to clear, so even the stock car, 26 m/s, makes it)
  tyres: { stat: 'grip', values: [0.7, 0.84, 0.98, 1.12] }, // cornering grip and how late the tail steps out
  brakes: { stat: 'brake', values: [0.55, 0.8, 1.05, 1.3] },
  steering: { stat: 'steer', values: [0.88, 0.96, 1.04, 1.12] }, // front wheel lock
  armor: { stat: 'maxHealth', values: [70, 90, 115, 145] }, // hit points
  turbo: { stat: 'nitro', values: [0.7, 0.9, 1.1, 1.3] }, // strength of a nitro charge
};

export const STOCK_LEVELS: UpgradeLevels = { engine: 0, transmission: 0, tyres: 0, brakes: 0, steering: 0, armor: 0, turbo: 0 };

/** Value of a slot at a (possibly fractional) level, interpolating between the table entries. */
export function slotValue(slot: UpgradeSlot, level: number): number {
  const { values } = TABLE[slot];
  const l = Math.min(MAX_UPGRADE_LEVEL, Math.max(0, level));
  const lo = Math.floor(l);
  const hi = Math.min(MAX_UPGRADE_LEVEL, lo + 1);
  return values[lo] + (values[hi] - values[lo]) * (l - lo);
}

/** Handling stats for a car with the given upgrade levels. */
export function statsFor(levels: UpgradeLevels): CarStats {
  const stats = { accel: 1, brake: 1, maxSpeed: 1, grip: 1, steer: 1, maxHealth: 100, nitro: 1 };
  for (const slot of UPGRADE_SLOTS) stats[TABLE[slot].stat] = slotValue(slot, levels[slot]);
  stats.maxHealth = Math.round(stats.maxHealth);
  return stats;
}

/** The car the player starts with. */
export function starterStats(): CarStats {
  return statsFor(STOCK_LEVELS);
}

/**
 * Class of car the computer drivers race in. It is the same at every AI difficulty: difficulty is only how well the
 * drivers drive. Rivals start level with the player's stock car; later this is what championship divisions raise.
 */
export const RIVAL_CAR_TIER = 0;

/**
 * A computer car of a given class: `tier` is an average upgrade level (0 = stock, 3 = fully upgraded). Acceleration,
 * braking, grip and steering vary by up to `spread` either way so no two rivals are quite identical, but they stay
 * centred on the class (top speed and hit points do not vary).
 */
export function aiStats(tier: number, spread = 0.04): CarStats {
  const levels = { ...STOCK_LEVELS };
  for (const slot of UPGRADE_SLOTS) levels[slot] = tier;
  const stats = statsFor(levels);
  const r = () => 1 + (Math.random() * 2 - 1) * spread;
  stats.accel *= r();
  stats.brake *= r();
  stats.grip *= r();
  stats.steer *= r();
  return stats;
}
