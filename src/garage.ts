import type { CarStyle } from './carmodel';

export type CarId = 'bug' | 'crawler' | 'commuter' | 'lada';

export interface GarageCar {
  id: CarId;
  name: string;
  style: CarStyle;
  color: number;
  blurb: string;
}

/**
 * The cars a new game starts with. They share the same stock performance for now; they differ in looks, and
 * the shop will take it from there.
 */
export const GARAGE: GarageCar[] = [
  { id: 'bug', name: 'Bug', style: 'beetle', color: 0xd8352a, blurb: 'Round, cheerful and nobody expects it to win.' },
  { id: 'crawler', name: 'Crawler', style: 'jeep', color: 0xe8a317, blurb: 'Slab-sided off-roader with a spare wheel on the tail.' },
  { id: 'commuter', name: 'Commuter', style: 'hatch', color: 0xb8bcc4, blurb: 'Sensible family hatchback. Surprisingly eager.' },
  { id: 'lada', name: 'Lada', style: 'lada', color: 0xc9a227, blurb: 'Soviet-era saloon. Built like a tank, steers like one.' },
];

export function garageCar(id: CarId): GarageCar {
  return GARAGE.find((c) => c.id === id) ?? GARAGE[0];
}

/** The sixteen paint colours on offer in the garage. */
export const PALETTE: { name: string; color: number }[] = [
  { name: 'Red', color: 0xd8352a },
  { name: 'Orange', color: 0xe8731a },
  { name: 'Amber', color: 0xe8a317 },
  { name: 'Yellow', color: 0xf0d53a },
  { name: 'Lime', color: 0x8bc53f },
  { name: 'Green', color: 0x2f9e4f },
  { name: 'Teal', color: 0x1fa89a },
  { name: 'Cyan', color: 0x30b8e0 },
  { name: 'Sky blue', color: 0x4a90e2 },
  { name: 'Blue', color: 0x2f56c8 },
  { name: 'Indigo', color: 0x5b3fb8 },
  { name: 'Purple', color: 0x9a45c8 },
  { name: 'Pink', color: 0xe55aa5 },
  { name: 'White', color: 0xf2f2f2 },
  { name: 'Silver', color: 0xb0b4bc },
  { name: 'Black', color: 0x22252a },
];
