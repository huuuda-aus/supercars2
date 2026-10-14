// Car geometry shared by the car model and the collision code. Car-local axes: +z forward.
export const WHEEL_X = 0.74; // wheel centres; the tyres' outer faces sit just inside the body line (0.95)
export const WHEEL_Z = 1.35;
export const WHEEL_R = 0.38;
// Collision footprint = what you see: body width sideways (tyres are tucked inside it), body ends lengthways.
export const HULL_HX = 0.98;
export const HULL_HZ = 2.1;

// Rigid body: unit mass, so forces are accelerations. Inertia of a uniform slab of the hull size.
export const INERTIA = ((2 * HULL_HX) ** 2 + (2 * HULL_HZ) ** 2) / 12;
