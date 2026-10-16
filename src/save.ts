import { type CarId, GARAGE } from './garage';
import { STOCK_LEVELS, UPGRADE_SLOTS, type UpgradeLevels } from './upgrades';

const SAVE_KEY = 'supercars.save.v1';
const SETTINGS_KEY = 'supercars.settings.v1';

export interface LastRace {
  track: string;
  position: number;
  finished: boolean;
  prize: number;
  cash: number; // dollars picked up on the track in that race
}

/** Everything about a career in progress. */
export interface SaveGame {
  version: 1;
  name: string;
  carId: CarId;
  levels: UpgradeLevels;
  money: number;
  racesDone: number;
  lastRace: LastRace | null;
}

export interface Settings {
  /** Index into the AI levels (0 = Rookie). */
  difficulty: number;
  /** Missiles, mines, guns and oil on or off, in every race. */
  weapons: boolean;
}

export const DEFAULT_SETTINGS: Settings = { difficulty: 1, weapons: true };

/**
 * Prize money by final position (index 0 = winner). Every one of the eight cars is paid: $1,500 for first down to $50 for
 * last. A car that was wrecked is placed behind the ones still running, so it is simply paid for where it ended up.
 */
export const PRIZES = [1500, 1000, 700, 450, 300, 175, 100, 50];
export const prizeFor = (position: number): number => PRIZES[position - 1] ?? 0;

export const MAX_NAME_LENGTH = 14;

/** A name as it will be stored and shown: trimmed, single-spaced, not too long, never empty. */
export function cleanName(raw: unknown): string {
  const name = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH).trim();
  return name || 'Racer';
}

export function newGame(carId: CarId, name: string): SaveGame {
  return { version: 1, name: cleanName(name), carId, levels: { ...STOCK_LEVELS }, money: 1000, racesDone: 0, lastRace: null };
}

// Storage can be missing or throw (private windows, blocked site data), so every access is guarded; the game plays on
// without saving.
function read(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* no storage: nothing to do */
  }
}

/** The saved career, repaired against the current game data, or null if there is none (or it is unreadable). */
export function loadGame(): SaveGame | null {
  const raw = read(SAVE_KEY) as Partial<SaveGame> | null;
  if (!raw || raw.version !== 1 || !GARAGE.some((c) => c.id === raw.carId)) return null;
  const levels = { ...STOCK_LEVELS };
  for (const slot of UPGRADE_SLOTS) {
    const v = raw.levels?.[slot];
    if (typeof v === 'number' && Number.isFinite(v)) levels[slot] = Math.max(0, Math.min(3, Math.round(v)));
  }
  const last = raw.lastRace;
  return {
    version: 1,
    name: cleanName(raw.name),
    carId: raw.carId as CarId,
    levels,
    money: typeof raw.money === 'number' && Number.isFinite(raw.money) ? Math.max(0, Math.round(raw.money)) : 0,
    racesDone: typeof raw.racesDone === 'number' && Number.isFinite(raw.racesDone) ? Math.max(0, Math.floor(raw.racesDone)) : 0,
    lastRace:
      last && typeof last.track === 'string' && typeof last.position === 'number'
        ? { track: last.track, position: last.position, finished: !!last.finished, prize: Number(last.prize) || 0, cash: Number(last.cash) || 0 }
        : null,
  };
}

export function saveGame(game: SaveGame): void {
  write(SAVE_KEY, game);
}

export function loadSettings(): Settings {
  const raw = read(SETTINGS_KEY) as Partial<Settings> | null;
  const d = raw?.difficulty;
  return {
    difficulty: typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 2 ? d : DEFAULT_SETTINGS.difficulty,
    weapons: typeof raw?.weapons === 'boolean' ? raw.weapons : DEFAULT_SETTINGS.weapons,
  };
}

export function saveSettings(settings: Settings): void {
  write(SETTINGS_KEY, settings);
}
