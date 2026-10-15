import type { CarStyle } from './carmodel';

export type CarId = 'bug' | 'crawler' | 'commuter';

export interface GarageCar {
  id: CarId;
  name: string;
  style: CarStyle;
  color: number;
  blurb: string;
}

/**
 * The three cars a new game starts with. They share the same stock performance for now; they differ in looks, and
 * the shop will take it from there.
 */
export const GARAGE: GarageCar[] = [
  { id: 'bug', name: 'Bug', style: 'beetle', color: 0xd8352a, blurb: 'Round, cheerful and nobody expects it to win.' },
  { id: 'crawler', name: 'Crawler', style: 'jeep', color: 0xe8a317, blurb: 'Slab-sided off-roader with a spare wheel on the tail.' },
  { id: 'commuter', name: 'Commuter', style: 'hatch', color: 0xb8bcc4, blurb: 'Sensible family hatchback. Surprisingly eager.' },
];

export function garageCar(id: CarId): GarageCar {
  return GARAGE.find((c) => c.id === id) ?? GARAGE[0];
}
