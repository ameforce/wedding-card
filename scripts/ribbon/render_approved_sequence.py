"""Render the approved coherent ribbon motion as one fixed transparent PNG sequence.

This script reuses the visually approved Blender-authored topology and motion from
``approved_motion.py``. It changes only the delivery surface: the inspection
paper is removed, transparent film is enabled, and every 30 fps frame is rendered
with one camera, material, canvas, scale, and registration point.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

import bpy

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))
import approved_motion as core


def file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def configure_transparent_delivery(scene: bpy.types.Scene) -> None:
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.image_settings.color_depth = "8"
    scene.render.image_settings.compression = 45


def render_sequence(scene: bpy.types.Scene, output: Path) -> list[dict[str, object]]:
    configure_transparent_delivery(scene)
    frames: list[dict[str, object]] = []
    for frame in range(core.FRAME_COUNT):
        scene.frame_set(frame)
        target = output / f"frame-{frame:03d}.png"
        scene.render.filepath = str(target)
        started = time.monotonic()
        bpy.ops.render.render(write_still=True)
        frames.append(
            {
                "frame": frame,
                "file": target.name,
                "seconds": round(time.monotonic() - started, 3),
                "sha256": file_sha256(target),
                "bytes": target.stat().st_size,
            }
        )
        if frame % 10 == 0 or frame == core.FRAME_COUNT - 1:
            print(json.dumps({"status": "rendering", "frame": frame, "count": core.FRAME_COUNT}), flush=True)
    return frames


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True)
    script_args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else sys.argv[1:]
    args = parser.parse_args(script_args)
    output = Path(args.out).resolve()
    if output.exists() and (not output.is_dir() or any(output.iterdir())):
        parser.error("Output must be a new or empty directory.")
    if bpy.app.version != (4, 5, 13):
        parser.error(f"This sequence is pinned to Blender 4.5.13; found {bpy.app.version_string}.")
    output.mkdir(parents=True, exist_ok=True)

    scene, ribbon, motion_rows = core.build_scene()
    paper = bpy.data.objects.get(core.PAPER_NAME)
    if paper is None:
        raise RuntimeError("Inspection paper was not present before transparent finalization.")
    paper_data = paper.data
    bpy.data.objects.remove(paper, do_unlink=True)
    if paper_data.users == 0:
        bpy.data.meshes.remove(paper_data)

    configure_transparent_delivery(scene)
    blend_path = output / "ribbon-final-sequence.blend"
    bpy.ops.wm.save_as_mainfile(filepath=str(blend_path))
    frame_rows = render_sequence(scene, output)
    terminal = motion_rows[-1]
    report = {
        "schemaVersion": 1,
        "purpose": "approved transparent public ribbon sequence source",
        "blenderVersion": bpy.app.version_string,
        "authorScriptSha256": file_sha256(Path(__file__)),
        "approvedMotionScriptSha256": file_sha256(Path(core.__file__)),
        "blendSha256": file_sha256(blend_path),
        "sceneContract": {
            "ribbonObjects": [ribbon.name],
            "ribbonMaterials": [slot.material.name for slot in ribbon.material_slots],
            "camera": core.CAMERA_NAME,
            "cameraType": scene.camera.data.type,
            "cameraScale": scene.camera.data.ortho_scale,
            "canvas": list(core.CANVAS),
            "fps": core.FPS,
            "frameCount": core.FRAME_COUNT,
            "registration": [0.0, 0.0, 0.0],
            "transparentFilm": scene.render.film_transparent,
            "topology": {"rows": core.ROWS, "across": core.ACROSS, "vertices": core.ROWS * core.ACROSS},
        },
        "motionContract": {
            "bandMotionObserved": max(row["bandShift"] for row in motion_rows) > 0.8,
            "rightLoopEnds": terminal["rightLoopScale"],
            "leftLoopEnds": terminal["leftLoopScale"],
            "knotReleaseEnds": terminal["knotRelease"],
            "terminalBoundsX": terminal["boundsX"],
            "terminalLeavesCamera": terminal["boundsX"][0] > 11.25,
        },
        "frames": frame_rows,
        "visualAdmission": "approved-by-user-2026-09-20",
        "integrationPerformed": False,
        "publicAssetsChanged": False,
    }
    evidence_path = output / "final-sequence-evidence.json"
    evidence_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(
        json.dumps(
            {
                "status": "complete",
                "output": str(output),
                "frames": core.FRAME_COUNT,
                "evidence": evidence_path.name,
            }
        ),
        flush=True,
    )


if __name__ == "__main__":
    main()
