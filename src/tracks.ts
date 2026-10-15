export interface TrackInfo {
  id: string;
  name: string;
  description: string;
}

/**
 * The circuits that can be raced. Only the figure-eight with the jump is built so far; the screens and the career
 * (which cycles through this list) are ready for more.
 */
export const TRACK_LIST: TrackInfo[] = [
  { id: 'figure8', name: 'Figure Eight', description: 'Two strands cross at right angles. Jump the pit where they meet.' },
];

/** The circuit for the nth race of a career (0-based). */
export function trackForRace(raceNumber: number): TrackInfo {
  return TRACK_LIST[raceNumber % TRACK_LIST.length];
}
