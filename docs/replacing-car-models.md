# Replacing the car models with Blender models

The game draws its cars with code (`src/carmodel.ts`). You can replace any of them with a model made in Blender, just by
dropping a `.glb` file in a folder. No code changes are needed. Cars you do not replace keep their built-in model.

## 1. The short version

1. Model the car in Blender with its **nose pointing towards you in Front view (numpad 1)**, in **metres**, standing on
   the ground, and about **4.2 m long**.
2. Make the **wheels separate objects** named `Wheel_FL`, `Wheel_FR`, `Wheel_RL`, `Wheel_RR`, each with its origin at
   the centre of the wheel.
3. Give the body paint a material named **`Paint`**.
4. Export as **glTF Binary (.glb)** with the settings in section 5.
5. Save the file in **`public/models/`** under the name of the style you are replacing (section 2).
6. Reload the game. Open the browser console to confirm: `Custom car models loaded: ...`.

## 2. Which file replaces which car

The file name is the car **style**. One file per style:

| File in `public/models/` | Used by |
|---|---|
| `beetle.glb` | **Bug**, one of the three cars you pick at the start of a new game |
| `jeep.glb` | **Crawler**, one of the three starter cars |
| `hatch.glb` | **Commuter**, one of the three starter cars, and the Yellow and Purple rival cars |
| `coupe.glb` | the Green and White rivals |
| `sedan.glb` | the Blue, Orange and Cyan rivals |

Start with one of the starter cars (`beetle`, `jeep` or `hatch`) so you can see your model in the Garage and in a race
straight away. A style with no file keeps its built-in model, so you can replace them one at a time.

To go back to the built-in car, delete the file.

## 3. What the game expects from the model

### Orientation, units and position

| | |
|---|---|
| Units | **1 Blender unit = 1 metre** (Scene Properties, Units: Metric, Unit Scale 1.0) |
| Nose direction | towards **-Y in Blender** (the car faces you in Front view, numpad 1) |
| Up | **+Z in Blender** (the glTF exporter turns this into the game's up direction) |
| Origin | the middle of the car, on the ground (the exporter keeps the object positions) |
| Length | about **4.2 m** nose to tail |
| Width | about **1.9 m** |
| Height | about 1.4 to 1.6 m for a normal car |

The game **normalises** what it loads, to forgive small mistakes: it scales the model so its nose-to-tail length is
exactly 4.2 m, centres it, and stands it on the ground (the lowest point sits at height 0). If your model needed more than
a 15% scale change, the browser console says so, because that usually means the wrong units or the car lying the wrong
way round.

The invisible shape the game uses for collisions is fixed (about 1.96 m wide and 4.2 m long), whatever the model looks
like. A model that is much wider or longer than that will visibly poke into walls and other cars.

### Wheels

The game rolls the wheels and turns the front ones when you steer. For that it looks for objects by **name**:

| Name | Turns | Rolls |
|---|---|---|
| `Wheel_FL`, `Wheel_FR` | yes (steering) | yes |
| `Wheel_RL`, `Wheel_RR` | no | yes |

Rules for the wheels:

- Each wheel is **its own object** (not part of the body mesh), and its **origin is at the centre of the wheel (the hub)**.
- The axle runs **along the X axis**. The wheel rolls around X.
- Name them exactly as above (letters, underscore, capital letters). Do not leave Blender's automatic `.001` suffixes
  on them: rename the object, not just the mesh data.
- Reference positions of the built-in car: wheel centres **0.74 m to each side** and **1.35 m forwards and backwards**
  from the middle, wheel radius **0.38 m**, so the hub is 0.38 m above the ground. In Blender (nose towards -Y) that
  is X = ±0.74, Y = -1.35 for the front wheels and Y = +1.35 for the rear wheels, Z = 0.38. Using the same layout makes
  the wheels look right against the game's physics.
- If a wheel is missing the game still works: that wheel just does not turn (a warning appears in the console).

### Paint colour

The Garage's colour palette (and the rivals' colours) recolour the car. The game does this by finding the material named
**`Paint`** (a name starting with `Paint` or `Body` also works, in any capitals) and setting its base colour.

- Put the **body paint on a material called `Paint`**. Everything else (glass, tyres, trim, lights) keeps its own look.
- For the tint to look right, give the `Paint` material a plain **base colour with no image texture**. Textures are
  multiplied by the chosen colour and look muddy.
- Roughness, metallic and clearcoat settings on that material are kept, only the colour changes.

### Nitro flames (optional)

Objects named `Flame_L` and `Flame_R` are hidden normally and shown while the nitro burns. Typically a cone behind each
exhaust pointing backwards, with an emissive material. If you do not add them the car just has no nitro flames.

### What is not replaced

- The **wreck** model (the burnt-out hulk) and its smoke.
- The **shield** bubble.
- Collision shapes, wheel positions used by the physics, and the car's handling. Those are the same for every car.

## 4. Step by step in Blender

1. **New scene.** Delete the default cube. In Scene Properties, set Units to Metric with Unit Scale 1.0.
2. **Reference box (optional).** Add a cube, scale it to 1.9 (X) by 4.2 (Y) by 1.4 (Z), and use it as a guide. Delete it
   before exporting.
3. **Model the body.** Make the nose point to -Y. Put the lowest part of the body about 0.25 to 0.3 m above the ground
   plane (Z = 0), because the wheels reach the ground.
4. **Model one wheel.**
   - Make a cylinder lying on its side so the axle runs along X. Radius 0.38 m, width about 0.28 m.
   - Place it at X = 0.74, Y = -1.35 (a front wheel), Z = 0.38.
   - Set its **origin to its centre**: Object menu, Set Origin, Origin to Geometry (or put the 3D cursor on the hub
     and use Origin to 3D Cursor).
   - Apply Rotation and Scale **only**: Object menu, Apply, **Rotation & Scale**. Do not apply Location.
5. **Duplicate the wheel** three times and place them at (±0.74, ±1.35, 0.38): front wheels at Y = -1.35, rear wheels at
   Y = +1.35. Mirror the geometry if the rim detail is not symmetrical. Rename the objects `Wheel_FL`, `Wheel_FR`,
   `Wheel_RL`, `Wheel_RR`.
6. **Materials.**
   - Body: a Principled BSDF material named `Paint` (plain colour, no image texture).
   - Glass, tyres, lights, trim: any other materials. Emissive materials work for lights.
7. **Body transforms.** Select the body objects and apply Scale and Rotation (Ctrl+A, Rotation & Scale) so the exported
   sizes are real. Check the modifiers (a Subdivision or Bevel modifier is fine; the exporter applies it).
8. **Optional flames.** Add two cones named `Flame_L` and `Flame_R` behind the exhaust pipes, pointing backwards.
9. **Check the size** in the sidebar (N key, Item tab): the whole car about 1.9 by 4.2 by 1.5 metres.

### Detail budget

Keep it modest: the game draws up to eight cars at once, with shadows. Aim for **5,000 to 20,000 triangles per car** and
a handful of materials. Avoid very large textures (1024 px or smaller is plenty at this camera distance).

## 5. Exporting from Blender

File, Export, **glTF 2.0 (.glb/.gltf)**. In the export panel:

| Section | Setting |
|---|---|
| Format | **glTF Binary (.glb)** |
| Include | Limit to **Selected Objects** only if the scene has other objects. Visible objects is fine otherwise |
| Transform | **+Y Up** (on) |
| Geometry | Apply Modifiers on, UVs on, Normals on, Vertex Colors as you wish |
| Geometry, Compression | **Off.** The game does not include the Draco decoder |
| Materials | Export |
| Animation | **Off** (the cars have no animations) |
| Lighting, Cameras | Off |

Save the file as `public/models/<style>.glb` in the project, for example `public/models/hatch.glb`.

## 6. Seeing it in the game

- **Dev server (`npm run dev`):** reload the page (Ctrl+Shift+R). The models are loaded once at start-up.
- **Build (`npm run build`):** everything in `public/` is copied into `dist/` as it is, so `dist/models/*.glb` ships with
  the game.
- Open the browser developer console. On success it says `Custom car models loaded: hatch`. Warnings tell you about
  missing wheel names, a model that had to be scaled a lot, or a file that could not be read.
- Quick test: pick **New game** or the Garage. The car chooser and the Garage show the models spinning, with the colour
  palette working on them.

## 7. When it looks wrong

| What you see | Likely cause and fix |
|---|---|
| The car drives backwards (the nose is at the back) | The model faces +Y in Blender. Rotate it 180 degrees around Z, apply the rotation (Ctrl+A), and export again |
| The console says the model was scaled | The units are not metres, or the model is not about 4.2 m long. Fix the Unit Scale or the size in Blender |
| The car is tiny or huge | Same as above: check the real dimensions in the N panel (Item tab) |
| The car lies on its side or points up | Export with **+Y Up** on, and model the car with Z up in Blender |
| Wheels do not roll | The names are wrong, or the wheel origins are not at the hub. Check `Wheel_FL` etc. (no `.001`) |
| Wheels roll wrongly or wobble when steering | The origin is not at the wheel centre, or the axle is not along X |
| Steering turns the wrong wheels | A front wheel is named `Wheel_R*` or the car faces the wrong way: front wheels are the ones at the nose |
| The colour palette does nothing | The body material is not named `Paint`/`Body...`, or it has an image texture (use a plain colour) |
| The model is washed out or very dark | A glossy or metallic material with nothing to reflect looks dark. Raise Roughness, lower Metallic |
| The car floats or sinks | The lowest point of the model is put on the ground automatically, so check that nothing (a wing, an aerial) hangs below the tyres |
| Nothing changed | The file is in the wrong folder or has the wrong name (`public/models/hatch.glb`), or the page was not hard-reloaded. Check the console message |
| `could not be used` in the console | The file is not a binary glTF, or it uses compression (Draco / meshopt). Export again with compression off |

## 8. For developers

The code is in `src/carmodel.ts`:

- `loadCustomCarModels()` runs once at start-up (`await` at the top of `src/main.ts`). It fetches
  `models/<style>.glb` for every style, accepts only real binary glTF files (they start with `glTF`), and registers the
  scene with `registerCarModel(style, scene)`.
- `buildCarModel(color, style)` returns the loaded model (cloned, with its own materials) when one exists, and the
  procedural car otherwise. The Garage, the car chooser and the race all use this one function.
- `instantiateModel` hooks up the pieces: the `Paint` materials are tinted, each front wheel is put inside a pivot
  object that steers while the wheel inside it rolls, and the flame objects are hidden until nitro.
- The conventions (names, scale target, wheel layout) are constants at the top of the glTF section of that file.
