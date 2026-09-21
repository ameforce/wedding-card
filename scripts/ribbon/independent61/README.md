# Independent ribbon 61

This source capsule authors one connected ribbon independently in Blender. The
accepted Houdini `straight-wings-final-61` render is a visual reference only.
No Houdini mesh, cache, motion or unwatermarked output is included or imported.

`source-rest.npz` contains the independently authored 285 × 9 control mesh,
explicit triangle topology and diagnostic flat coordinates. Its fixed **3D rest
surface** preserves the approved pressed wing faces and soft central knot.
This is a CG rest-shape model, not proof that the shape can be cut from an
unstretched flat rectangular strip. Only the two free endpoint rows are driven.
Interior vertices follow fixed springs, bending, inertia and collision forces.
There are no interior pose targets, shrinking loops or width-scaling keyframes.

Use separate Python 3.11 environments for `requirements-physics.txt` and
`requirements-render.txt`. The renderer uses the official `bpy` package.
Run the following with the corresponding environment's Python, from any folder:

```text
python simulate.py --out /absolute/path/physics
python verify_physics.py --source /absolute/path/physics
python refine.py --source /absolute/path/physics --out /absolute/path/physics/surface
python verify_surface.py --source /absolute/path/physics/surface
python render.py --surface /absolute/path/physics/surface --out /absolute/path/render
```

Output directories must not already exist. Do not overwrite a prior run.
The checks must finish with an empty `violations` list before rendering is
accepted. The simulation retains every accepted implicit step; the verifier
checks self-collision, fixed-paper collision and continuous passage between
steps. Refinement preserves topology and certifies its entire dense trajectory,
inserting midpoint samples when necessary. Rendering interpolates only within
those certified segments. No subdivision modifier changes the checked surface.

`render-scene.blend` fixes the ivory satin material, broad lighting, holdout paper
and orthographic camera: 480 × 1920 RGBA, registration (240, 960), width 14 world
units. It samples physical motion at 2.5× speed for 30fps playback. Once the whole
ribbon is below the physical paper, a rigid root translation is extracted for
viewport-aware exit. The terminal frame is transparent. No frame is separately
cropped, normalized or resized.

Package the 73 PNGs with `../package_sequence.py`, Pillow 11.3.0 and libwebp 1.5.0,
`--frame-pack`, `--render-manifest /absolute/path/render/render-manifest.json`,
`--release-complete-frame 61`, the generated `root-track.json`,
registration (240, 960), and `../reference-paper-curve.json`. The pack concatenates
the exact lossless WebP files; browser decoding stays bounded. Public output
contains only the manifest, WebP frames and binary pack. The source scene,
simulation arrays and reference video are never public website assets.

The renderer loads the exact hash-verified surface bytes into memory once and
freezes its scene before rendering. It refuses stale, failed or incomplete
verification. Its manifest binds all 73 PNGs, the root track and certified
surface. Packaging checks those bytes before conversion and records each
PNG-to-WebP hash and the public manifest hash outside the public directory.

Physics checks establish geometric passage, not visual acceptance. Review the
standalone normal/slow playback and the full invitation before release. Keep
actual verification outputs, asset hashes and browser limitations with the
release evidence. Desktop viewport tests do not prove physical iPhone behavior.
