const KEY = 'supercars.lapRecords.v1';

/** Best lap time (seconds) per track id, kept across careers and training. */
export function loadRecords(): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    const out: Record<string, number> = {};
    if (raw && typeof raw === 'object') {
      for (const [id, t] of Object.entries(raw)) if (typeof t === 'number' && Number.isFinite(t) && t > 5) out[id] = t;
    }
    return out;
  } catch {
    return {};
  }
}

/** Offer a lap time. Returns true if it beats the track's record (or is the first one), and stores it. */
export function submitLap(trackId: string, seconds: number): boolean {
  if (!Number.isFinite(seconds) || seconds < 5) return false;
  const records = loadRecords();
  if (records[trackId] !== undefined && seconds >= records[trackId]) return false;
  records[trackId] = seconds;
  try {
    localStorage.setItem(KEY, JSON.stringify(records));
  } catch {
    /* no storage: the record lasts for this session only */
  }
  return true;
}
