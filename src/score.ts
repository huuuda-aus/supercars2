/** Points for a race. Kept apart from the money: score is bragging rights (and, later, the hall of fame). */
export const FIRST_PLACE_POINTS = 100;
export const LAST_PLACE_POINTS = 5;
export const DESTROYED_POINTS = 50; // per opponent you wrecked
export const LAP_RECORD_POINTS = 10; // per improvement of a track's lap record

export interface ScoreBreakdown {
  position: number;
  placement: number;
  destroyed: number;
  destroyedPoints: number;
  lapRecords: number;
  lapRecordPoints: number;
  bestLap: number | null; // seconds, the fastest lap of this race
  total: number;
}

/** 100 for first place down to 5 for last, in equal steps. */
export function placementPoints(position: number, carCount: number): number {
  if (carCount <= 1) return FIRST_PLACE_POINTS;
  const step = (FIRST_PLACE_POINTS - LAST_PLACE_POINTS) / (carCount - 1);
  return Math.round(FIRST_PLACE_POINTS - (Math.min(Math.max(position, 1), carCount) - 1) * step);
}

export function scoreRace(position: number, carCount: number, destroyed: number, lapRecords: number, bestLap: number | null): ScoreBreakdown {
  const placement = placementPoints(position, carCount);
  const destroyedPoints = destroyed * DESTROYED_POINTS;
  const lapRecordPoints = lapRecords * LAP_RECORD_POINTS;
  return { position, placement, destroyed, destroyedPoints, lapRecords, lapRecordPoints, bestLap, total: placement + destroyedPoints + lapRecordPoints };
}
