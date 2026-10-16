/** Points for a race. Kept apart from the money: score is bragging rights (and, later, the hall of fame). */
export const FIRST_PLACE_POINTS = 100;
export const LAST_PLACE_POINTS = 5;
export const DESTROYED_POINTS = 50; // per opponent you wrecked
export const LAP_RECORD_POINTS = 10; // per improvement of a track's lap record
export const DRIFT_UNITS_PER_POINT = 20; // the car's drift score (speed x slide angle x time) per point
export const AIR_POINTS_PER_SECOND = 25; // for time in the air on a flight that ends in a landing

export interface ScoreBreakdown {
  position: number;
  placement: number;
  destroyed: number;
  destroyedPoints: number;
  lapRecords: number;
  lapRecordPoints: number;
  driftPoints: number;
  airSeconds: number;
  airPoints: number;
  bestLap: number | null; // seconds, the fastest lap of this race
  total: number;
}

/** 100 for first place down to 5 for last, in equal steps. */
export function placementPoints(position: number, carCount: number): number {
  if (carCount <= 1) return FIRST_PLACE_POINTS;
  const step = (FIRST_PLACE_POINTS - LAST_PLACE_POINTS) / (carCount - 1);
  return Math.round(FIRST_PLACE_POINTS - (Math.min(Math.max(position, 1), carCount) - 1) * step);
}

export function scoreRace(
  position: number,
  carCount: number,
  destroyed: number,
  lapRecords: number,
  bestLap: number | null,
  driftUnits: number,
  airSeconds: number,
): ScoreBreakdown {
  const placement = placementPoints(position, carCount);
  const destroyedPoints = destroyed * DESTROYED_POINTS;
  const lapRecordPoints = lapRecords * LAP_RECORD_POINTS;
  const driftPoints = Math.round(driftUnits / DRIFT_UNITS_PER_POINT);
  const airPoints = Math.round(airSeconds * AIR_POINTS_PER_SECOND);
  return {
    position,
    placement,
    destroyed,
    destroyedPoints,
    lapRecords,
    lapRecordPoints,
    driftPoints,
    airSeconds,
    airPoints,
    bestLap,
    total: placement + destroyedPoints + lapRecordPoints + driftPoints + airPoints,
  };
}
