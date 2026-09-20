"""Author the approved one-strip ribbon motion in Blender 4.5.13.

The scene is the procedural source for the public transparent sequence. Running
this module directly creates the paper-backed visual-admission proof; the public
frames are rendered separately by ``render_approved_sequence.py``.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
import time
from pathlib import Path

import bpy
from mathutils import Vector


FPS = 30
FRAME_COUNT = 75
CANVAS = (960, 640)
ROWS = 360
ACROSS = 7
WIDTH = 0.86
RIBBON_NAME = "One coherent sliding ivory satin strip"
CAMERA_NAME = "Ribbon proof fixed camera"
PAPER_NAME = "Neutral ivory inspection ground"


def smoothstep(edge0: float, edge1: float, value: float) -> float:
    value = max(0.0, min(1.0, (value - edge0) / (edge1 - edge0)))
    return value * value * (3.0 - 2.0 * value)


def mix(a: Vector, b: Vector, amount: float) -> Vector:
    return a * (1.0 - amount) + b * amount


def smooth_path(points: list[Vector], iterations: int = 4) -> list[Vector]:
    """Corner-cut the authored path without overshooting tight knot crossings."""
    result = [point.copy() for point in points]
    for _ in range(iterations):
        refined = [result[0].copy()]
        for first, second in zip(result, result[1:]):
            refined.append(first * 0.75 + second * 0.25)
            refined.append(first * 0.25 + second * 0.75)
        refined.append(result[-1].copy())
        result = refined
    return result


def cumulative(points: list[Vector]) -> list[float]:
    distances = [0.0]
    for first, second in zip(points, points[1:]):
        distances.append(distances[-1] + (second - first).length)
    return distances


def point_at(points: list[Vector], distances: list[float], distance: float) -> Vector:
    if distance <= 0.0:
        return points[0].copy()
    if distance >= distances[-1]:
        return points[-1].copy()
    low, high = 0, len(distances) - 1
    while low + 1 < high:
        middle = (low + high) // 2
        if distances[middle] <= distance:
            low = middle
        else:
            high = middle
    span = distances[low + 1] - distances[low]
    amount = 0.0 if span == 0.0 else (distance - distances[low]) / span
    return mix(points[low], points[low + 1], amount)


def resample(points: list[Vector], count: int) -> tuple[list[Vector], float]:
    distances = cumulative(points)
    length = distances[-1]
    return [point_at(points, distances, length * index / (count - 1)) for index in range(count)], length


def tied_controls(progress: float) -> tuple[list[Vector], dict[str, float]]:
    right_loop = 1.0 - smoothstep(0.06, 0.38, progress)
    left_loop = 1.0 - smoothstep(0.22, 0.55, progress)
    pull = smoothstep(0.02, 0.58, progress)
    release = smoothstep(0.42, 0.62, progress)
    band_shift = 0.85 * smoothstep(0.15, 0.58, progress)
    knot_open = smoothstep(0.32, 0.57, progress)

    controls = [
        Vector((-2.45, -0.42, -3.45)),
        Vector((-1.45, -0.52, -2.35)),
        Vector((-0.42, -0.62, -0.62)),
        Vector((-0.85, -0.48, 0.12)),
        Vector((-1.55, -0.36, 0.92)),
        Vector((-2.80, -0.22, 1.62)),
        Vector((-4.05, -0.05, 1.08)),
        Vector((-4.20, 0.04, 0.00)),
        Vector((-3.72, -0.10, -1.08)),
        Vector((-2.30, -0.28, -1.50)),
        Vector((-0.58, -0.52, -0.34)),
        Vector((-0.14, -0.74, 0.16)),
        Vector((-0.82, 0.18, 0.00)),
        Vector((-4.20, 0.25, 0.00)),
        Vector((-8.30, 0.30, 0.00)),
        Vector((-9.15, 2.00, -10.50)),
        Vector((0.00, 2.00, -14.00)),
        Vector((9.15, 2.00, -10.50)),
        Vector((8.30, 0.30, 0.00)),
        Vector((4.20, 0.25, 0.00)),
        Vector((0.82, 0.18, 0.00)),
        Vector((0.16, -0.72, 0.14)),
        Vector((0.62, -0.48, -0.28)),
        Vector((2.20, -0.27, -1.42)),
        Vector((3.82, -0.08, -1.02)),
        Vector((4.18, 0.04, 0.02)),
        Vector((4.00, -0.05, 1.06)),
        Vector((2.78, -0.24, 1.56)),
        Vector((1.58, -0.36, 0.92)),
        Vector((0.56, -0.54, 0.20)),
        Vector((0.50, -0.64, -0.42)),
        Vector((1.75, -0.50, -1.80)),
        Vector((3.18, -0.34, -3.18)),
        Vector((4.62, -0.20, -3.70)),
    ]

    left_pivot = Vector((-0.30, -0.50, -0.03))
    for index in range(3, 11):
        relative = controls[index] - left_pivot
        relative.x *= left_loop
        relative.z *= left_loop
        controls[index] = left_pivot + relative

    right_pivot = Vector((0.34, -0.50, -0.03))
    for index in range(22, 30):
        relative = controls[index] - right_pivot
        relative.x *= right_loop
        relative.z *= right_loop
        controls[index] = right_pivot + relative

    # The same strip moves at the band and bow. No static horizontal band is left behind.
    for index in list(range(12, 21)) + [2, 10, 11, 21, 22, 29, 30]:
        controls[index].x += band_shift
        controls[index].z += 0.14 * math.sin(progress * math.pi) * (1.0 if index % 2 else -1.0)

    # The right free tail is the pull source. Its travel pays out the shrinking loops.
    for index, weight in ((31, 0.35), (32, 0.68), (33, 1.0)):
        controls[index].x += (9.5 * pull) * weight
        controls[index].z += (2.55 * pull) * weight
        controls[index].y -= 0.20 * pull * weight

    # The knot opens in depth before the loops disappear, avoiding a pose cross-fade.
    for index, direction in ((2, -1), (10, 1), (11, -1), (21, 1), (22, -1), (29, 1), (30, -1)):
        controls[index].x += direction * 0.42 * knot_open
        controls[index].y += 0.46 * knot_open
        controls[index].z += direction * 0.18 * knot_open

    # A gentle left-tail reaction makes the release read as transmitted tension.
    for index, weight in ((0, 0.28), (1, 0.18), (2, 0.10)):
        controls[index].x += 1.20 * pull * weight
        controls[index].z += 0.35 * math.sin(math.pi * pull) * weight

    return controls, {
        "rightLoopScale": right_loop,
        "leftLoopScale": left_loop,
        "pull": pull,
        "knotRelease": release,
        "bandShift": band_shift,
    }


def loose_controls(count: int, progress: float) -> list[Vector]:
    exit_progress = smoothstep(0.69, 0.98, progress)
    controls: list[Vector] = []
    for index in range(count):
        amount = index / (count - 1)
        x = -45.0 + 90.0 * amount + 61.0 * exit_progress
        z = 0.34 * math.sin(amount * math.tau * 1.25 + 0.6) + 0.12 * math.sin(amount * math.tau * 4.0)
        z -= 1.15 * exit_progress
        y = -0.12 + 0.06 * math.cos(amount * math.tau * 2.0)
        controls.append(Vector((x, y, z)))
    return controls


def centerline(progress: float) -> tuple[list[Vector], dict[str, float]]:
    tied, evidence = tied_controls(progress)
    release = smoothstep(0.42, 0.62, progress)
    loose = loose_controls(len(tied), progress)
    controls = [mix(first, second, release) for first, second in zip(tied, loose)]
    sampled, raw_length = resample(smooth_path(controls), ROWS)
    evidence.update(
        {
            "progress": progress,
            "releaseBlend": release,
            "rawCenterlineLength": raw_length,
            "freeStartX": sampled[0].x,
            "freeEndX": sampled[-1].x,
        }
    )
    return sampled, evidence


def ribbon_geometry(progress: float) -> tuple[list[Vector], list[tuple[int, int, int, int]], dict[str, float]]:
    centers, evidence = centerline(progress)
    vertices: list[Vector] = []
    view = Vector((0.0, -1.0, 0.0))
    previous_width = Vector((1.0, 0.0, 0.0))
    for index, center in enumerate(centers):
        tangent = (centers[min(len(centers) - 1, index + 1)] - centers[max(0, index - 1)]).normalized()
        width_axis = tangent.cross(view)
        if width_axis.length < 1e-7:
            width_axis = previous_width - tangent * previous_width.dot(tangent)
        width_axis.normalize()
        if width_axis.dot(previous_width) < 0.0:
            width_axis = -width_axis
        previous_width = width_axis
        for column in range(ACROSS):
            across = column / (ACROSS - 1) - 0.5
            crown = -0.065 * (1.0 - (across * 2.0) ** 2)
            vertices.append(center + width_axis * (across * WIDTH) + view * crown)
    faces: list[tuple[int, int, int, int]] = []
    for row in range(ROWS - 1):
        for column in range(ACROSS - 1):
            offset = row * ACROSS + column
            faces.append((offset, offset + 1, offset + ACROSS + 1, offset + ACROSS))
    width_lengths = []
    for row in range(ROWS):
        start = row * ACROSS
        width_lengths.append(
            sum((vertices[start + column + 1] - vertices[start + column]).length for column in range(ACROSS - 1))
        )
    evidence["crossSectionMin"] = min(width_lengths)
    evidence["crossSectionMax"] = max(width_lengths)
    evidence["sampledCenterlineLength"] = sum((second - first).length for first, second in zip(centers, centers[1:]))
    evidence["boundsX"] = [min(point.x for point in vertices), max(point.x for point in vertices)]
    evidence["boundsZ"] = [min(point.z for point in vertices), max(point.z for point in vertices)]
    return vertices, faces, evidence


def look_at(obj: bpy.types.Object, target: tuple[float, float, float]) -> None:
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()


def socket(node: bpy.types.Node, *names: str):
    for name in names:
        if name in node.inputs:
            return node.inputs[name]
    raise KeyError(f"Missing socket: {names}")


def satin_material() -> bpy.types.Material:
    material = bpy.data.materials.new("Ivory satin proof material")
    material.use_nodes = True
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    shader = nodes.new("ShaderNodeBsdfPrincipled")
    socket(shader, "Base Color").default_value = (0.91, 0.80, 0.64, 1.0)
    socket(shader, "Roughness").default_value = 0.24
    socket(shader, "Metallic").default_value = 0.02
    socket(shader, "IOR").default_value = 1.46
    socket(shader, "Coat Weight", "Clearcoat").default_value = 0.24
    socket(shader, "Coat Roughness", "Clearcoat Roughness").default_value = 0.18
    socket(shader, "Sheen Weight", "Sheen").default_value = 0.30
    if "Anisotropic IOR Level" in shader.inputs:
        shader.inputs["Anisotropic IOR Level"].default_value = 0.42
    elif "Anisotropic" in shader.inputs:
        shader.inputs["Anisotropic"].default_value = 0.42
    texture = nodes.new("ShaderNodeTexNoise")
    texture.inputs["Scale"].default_value = 110.0
    texture.inputs["Detail"].default_value = 2.0
    texture.inputs["Roughness"].default_value = 0.38
    bump = nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.15
    bump.inputs["Distance"].default_value = 0.018
    links.new(texture.outputs["Fac"], bump.inputs["Height"])
    links.new(bump.outputs["Normal"], shader.inputs["Normal"])
    links.new(shader.outputs["BSDF"], output.inputs["Surface"])
    return material


def paper_material() -> bpy.types.Material:
    material = bpy.data.materials.new("Ivory paper inspection material")
    material.use_nodes = True
    shader = material.node_tree.nodes.get("Principled BSDF")
    socket(shader, "Base Color").default_value = (0.92, 0.89, 0.82, 1.0)
    socket(shader, "Roughness").default_value = 0.72
    return material


def build_scene() -> tuple[bpy.types.Scene, bpy.types.Object, list[dict[str, float]]]:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE_NEXT"
    scene.render.resolution_x, scene.render.resolution_y = CANVAS
    scene.render.resolution_percentage = 100
    scene.render.fps = FPS
    scene.render.film_transparent = False
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.use_file_extension = True
    scene.frame_start, scene.frame_end = 0, FRAME_COUNT - 1
    scene.world = bpy.data.worlds.new("Ribbon proof world")
    scene.world.color = (0.055, 0.045, 0.035)

    vertices, faces, first_row = ribbon_geometry(0.0)
    mesh = bpy.data.meshes.new(RIBBON_NAME)
    mesh.from_pydata(vertices, [], faces)
    ribbon = bpy.data.objects.new(RIBBON_NAME, mesh)
    scene.collection.objects.link(ribbon)
    mesh.materials.append(satin_material())
    for polygon in mesh.polygons:
        polygon.use_smooth = True

    solidify = ribbon.modifiers.new("Satin thickness", "SOLIDIFY")
    solidify.thickness = 0.032
    solidify.offset = 0.0
    bevel = ribbon.modifiers.new("Soft ribbon edges", "BEVEL")
    bevel.width = 0.024
    bevel.segments = 2

    ribbon.shape_key_add(name="Basis")
    ribbon.data.shape_keys.use_relative = False
    evidence = [first_row]
    for frame in range(FRAME_COUNT):
        progress = frame / (FRAME_COUNT - 1)
        frame_vertices, _, row = ribbon_geometry(progress)
        key = ribbon.shape_key_add(name=f"Frame {frame:03d}")
        key.data.foreach_set("co", [component for point in frame_vertices for component in point])
        key.interpolation = "KEY_LINEAR"
        ribbon.data.shape_keys.eval_time = key.frame
        ribbon.data.shape_keys.keyframe_insert(data_path="eval_time", frame=frame)
        row["frame"] = frame
        evidence.append(row)
    for curve in ribbon.data.shape_keys.animation_data.action.fcurves:
        for point in curve.keyframe_points:
            point.interpolation = "LINEAR"

    paper_mesh = bpy.data.meshes.new(PAPER_NAME)
    paper_mesh.from_pydata(
        [(-12.0, 1.35, -8.0), (12.0, 1.35, -8.0), (12.0, 1.35, 8.0), (-12.0, 1.35, 8.0)],
        [],
        [(0, 1, 2, 3)],
    )
    paper = bpy.data.objects.new(PAPER_NAME, paper_mesh)
    scene.collection.objects.link(paper)
    paper_mesh.materials.append(paper_material())

    camera_data = bpy.data.cameras.new(CAMERA_NAME)
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = 15.0
    camera = bpy.data.objects.new(CAMERA_NAME, camera_data)
    scene.collection.objects.link(camera)
    camera.location = (0.0, -25.0, -0.55)
    camera.rotation_euler = (math.pi / 2.0, 0.0, 0.0)
    scene.camera = camera

    for name, location, energy, size in (
        ("Large soft key", (-4.5, -8.0, 7.0), 930.0, 6.0),
        ("Warm fill", (5.0, -6.0, 1.5), 480.0, 5.0),
        ("Top edge light", (0.0, -2.0, 8.5), 520.0, 4.0),
    ):
        data = bpy.data.lights.new(name, "AREA")
        data.energy = energy
        data.shape = "DISK"
        data.size = size
        light = bpy.data.objects.new(name, data)
        scene.collection.objects.link(light)
        light.location = location
        look_at(light, (0.0, 0.0, 0.0))

    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.frame_set(0)
    return scene, ribbon, evidence[1:]


def file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def render_outputs(scene: bpy.types.Scene, output: Path) -> tuple[Path, list[dict[str, object]]]:
    still_rows = []
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    for frame in (0, 15, 30, 45, 60, 74):
        scene.frame_set(frame)
        target = output / f"proof-frame-{frame:03d}.png"
        scene.render.filepath = str(target)
        started = time.monotonic()
        bpy.ops.render.render(write_still=True)
        still_rows.append(
            {
                "frame": frame,
                "seconds": round(time.monotonic() - started, 3),
                "sha256": file_sha256(target),
                "bytes": target.stat().st_size,
            }
        )

    scene.frame_set(0)
    scene.render.image_settings.file_format = "FFMPEG"
    scene.render.ffmpeg.format = "MPEG4"
    scene.render.ffmpeg.codec = "H264"
    scene.render.ffmpeg.constant_rate_factor = "MEDIUM"
    scene.render.ffmpeg.ffmpeg_preset = "GOOD"
    scene.render.ffmpeg.gopsize = 15
    scene.render.ffmpeg.audio_codec = "NONE"
    scene.render.filepath = str(output / "ribbon-core-proof")
    bpy.ops.render.render(animation=True)
    candidates = sorted(output.glob("ribbon-core-proof*.mp4"))
    if len(candidates) != 1:
        raise RuntimeError(f"Expected one MP4 output, found: {candidates}")
    return candidates[0], still_rows


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True)
    script_args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else sys.argv[1:]
    args = parser.parse_args(script_args)
    output = Path(args.out).resolve()
    if output.exists() and (not output.is_dir() or any(output.iterdir())):
        parser.error("Output must be a new or empty directory.")
    if bpy.app.version != (4, 5, 13):
        parser.error(f"This proof is pinned to Blender 4.5.13; found {bpy.app.version_string}.")
    output.mkdir(parents=True, exist_ok=True)

    scene, ribbon, frame_evidence = build_scene()
    blend_path = output / "ribbon-core-proof.blend"
    bpy.ops.wm.save_as_mainfile(filepath=str(blend_path))
    video_path, still_rows = render_outputs(scene, output)

    last = frame_evidence[-1]
    report = {
        "schemaVersion": 1,
        "purpose": "standalone visual admission before public integration",
        "blenderVersion": bpy.app.version_string,
        "scriptSha256": file_sha256(Path(__file__)),
        "blendSha256": file_sha256(blend_path),
        "video": {
            "file": video_path.name,
            "sha256": file_sha256(video_path),
            "bytes": video_path.stat().st_size,
            "fps": FPS,
            "frameCount": FRAME_COUNT,
            "durationSeconds": FRAME_COUNT / FPS,
            "width": CANVAS[0],
            "height": CANVAS[1],
            "audio": False,
        },
        "sceneContract": {
            "ribbonObjects": [ribbon.name],
            "ribbonMaterials": [slot.material.name for slot in ribbon.material_slots],
            "camera": CAMERA_NAME,
            "cameraType": scene.camera.data.type,
            "cameraScale": scene.camera.data.ortho_scale,
            "canvas": list(CANVAS),
            "fps": FPS,
            "registration": [0.0, 0.0, 0.0],
            "topology": {"rows": ROWS, "across": ACROSS, "vertices": ROWS * ACROSS},
        },
        "motionContract": {
            "rightLoopBegins": frame_evidence[0]["rightLoopScale"],
            "rightLoopEnds": frame_evidence[-1]["rightLoopScale"],
            "leftLoopBegins": frame_evidence[0]["leftLoopScale"],
            "leftLoopEnds": frame_evidence[-1]["leftLoopScale"],
            "knotReleaseEnds": frame_evidence[-1]["knotRelease"],
            "bandMotionObserved": max(row["bandShift"] for row in frame_evidence) > 0.8,
            "terminalBoundsX": last["boundsX"],
            "terminalLeavesCamera": last["boundsX"][0] > 11.25,
            "crossSectionRange": [
                min(row["crossSectionMin"] for row in frame_evidence),
                max(row["crossSectionMax"] for row in frame_evidence),
            ],
        },
        "selectedFrames": still_rows,
        "visualAdmission": "pending-user-review",
        "integrationPerformed": False,
        "publicAssetsChanged": False,
    }
    evidence_path = output / "proof-evidence.json"
    evidence_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({"status": "complete", "output": str(output), "video": video_path.name, "evidence": evidence_path.name}))


if __name__ == "__main__":
    main()
