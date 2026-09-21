"""Fabricate one flat-metric ribbon with collision-aware sequential folds.

The strip is a chain of rigid triangles cut from one rectangle.  Each new
triangle is rotated only around the preceding material edge.  A bounded beam
search follows explicit spatial ports while rejecting ribbon and paper-box
penetration as soon as it would be introduced.  This authors an initial tied
shape only; it does not claim a physical untying run.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path

import numpy as np

from cloth_construct_hinges import subdivide, unit
from cloth_construct_verify import classify
from cloth_study import intersections, render_setup


WIDTH = .85
PAPER_LOW = np.array([-7., 1.6, -4.5])
PAPER_HIGH = np.array([7., 2.3, 4.5])


def paper_geometry():
    vertices = np.array([[x, y, z]
                         for x in [PAPER_LOW[0], PAPER_HIGH[0]]
                         for y in [PAPER_LOW[1], PAPER_HIGH[1]]
                         for z in [PAPER_LOW[2], PAPER_HIGH[2]]])
    quads = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1],
             [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]]
    faces = np.array([tri for a, b, c, d in quads
                      for tri in [[a, b, c], [a, c, d]]])
    return vertices, faces


def resample_ports(ports, pitch):
    segments = np.linalg.norm(np.diff(ports, axis=0), axis=1)
    stations = np.r_[0., segments.cumsum()]
    samples = np.linspace(0., stations[-1], int(np.ceil(stations[-1] / pitch)) + 1)
    centers = np.stack([np.interp(samples, stations, ports[:, axis])
                        for axis in range(3)], axis=1)
    return centers, samples, np.interp(samples, stations, np.arange(len(ports)))


def transported_directors(centers):
    tangents = np.gradient(centers, axis=0)
    tangents /= np.linalg.norm(tangents, axis=1)[:, None]
    directors = []
    for index, tangent in enumerate(tangents):
        if index:
            candidate = directors[-1] - tangent * np.dot(directors[-1], tangent)
        else:
            candidate = np.cross(tangent, np.array([0., -1., 0.]))
        if np.linalg.norm(candidate) < 1e-8:
            fallback = np.array([0., 0., 1.])
            candidate = fallback - tangent * np.dot(fallback, tangent)
        director = unit(candidate)
        if directors and np.dot(director, directors[-1]) < 0:
            director *= -1
        directors.append(director)
    return np.asarray(directors)


def target_strip(ports, pitch):
    centers, samples, parameters = resample_ports(ports, pitch)
    directors = transported_directors(centers)
    target = (centers[:, None, :] +
              np.array([-.5, .5])[None, :, None] * WIDTH * directors[:, None, :])
    rest = np.array([[station, side, 0.]
                     for station in samples for side in [-WIDTH / 2, WIDTH / 2]])
    return target.reshape(-1, 3), rest, samples, parameters


def rigid_constants(rest):
    constants = []
    for index in range(3, len(rest)):
        a, b, c = rest[index - 2:index + 1]
        edge = np.linalg.norm(b - a)
        d0, d1 = np.linalg.norm(c - a), np.linalg.norm(c - b)
        x = (d0 * d0 + edge * edge - d1 * d1) / (2 * edge)
        constants.append((x, math.sqrt(max(0., d0 * d0 - x * x))))
    return constants


def positive_intersection(a, b):
    category, _ = classify(a, b)
    return category in ('transverse_interior', 'coplanar_area')


def penetrates_paper(triangle, paper_triangles):
    if np.any(np.all((triangle > PAPER_LOW + 1e-8) &
                     (triangle < PAPER_HIGH - 1e-8), axis=1)):
        return True
    lo, high = triangle.min(axis=0), triangle.max(axis=0)
    for paper in paper_triangles:
        if np.all(lo - 1e-8 <= paper.max(axis=0)) and np.all(high + 1e-8 >= paper.min(axis=0)):
            if positive_intersection(triangle, paper):
                return True
    return False


def collides(vertices, new_index, paper_triangles):
    new_ids = {new_index - 2, new_index - 1, new_index}
    triangle = vertices[[new_index - 2, new_index - 1, new_index]]
    if penetrates_paper(triangle, paper_triangles):
        return True
    lo, high = triangle.min(axis=0), triangle.max(axis=0)
    for first in range(new_index - 2):
        ids = {first, first + 1, first + 2}
        if ids & new_ids:
            continue
        other = vertices[[first, first + 1, first + 2]]
        if np.all(lo - 1e-8 <= other.max(axis=0)) and np.all(high + 1e-8 >= other.min(axis=0)):
            if positive_intersection(triangle, other):
                return True
    return False


def root_triangle(target, rest):
    vertices = np.empty_like(target)
    vertices[:2] = target[:2]
    edge = unit(vertices[1] - vertices[0])
    direction = target[2] - vertices[0]
    direction -= edge * np.dot(edge, direction)
    d0 = np.linalg.norm(rest[2] - rest[0])
    d1 = np.linalg.norm(rest[2] - rest[1])
    width = np.linalg.norm(vertices[1] - vertices[0])
    x = (d0 * d0 + width * width - d1 * d1) / (2 * width)
    height = math.sqrt(max(0., d0 * d0 - x * x))
    vertices[2] = vertices[0] + x * edge + height * unit(direction)
    return vertices


def fabricate(target, rest, beam_width, angle_steps):
    paper_vertices, paper_faces = paper_geometry()
    paper_triangles = paper_vertices[paper_faces]
    initial = root_triangle(target, rest)
    if penetrates_paper(initial[:3], paper_triangles):
        raise RuntimeError('Root triangle penetrates the paper box')
    initial_cost = float(np.sum((initial[:3] - target[:3]) ** 2))
    beam = [(initial_cost, initial[:3].copy(), [])]
    constants = rigid_constants(rest)
    offsets = np.r_[0., np.linspace(.12, math.pi, angle_steps),
                    -np.linspace(.12, math.pi, angle_steps)]
    trace = []
    for new_index, (x, height) in enumerate(constants, start=3):
        proposals = []
        for cost, existing, angles in beam:
            pivot = existing[new_index - 2]
            axis = unit(existing[new_index - 1] - pivot)
            old = existing[new_index - 3] - pivot
            base = -unit(old - axis * np.dot(axis, old))
            cross = np.cross(axis, base)
            aim = target[new_index] - pivot - axis * x
            ideal = math.atan2(float(np.dot(aim, cross)), float(np.dot(aim, base)))
            for offset in offsets:
                angle = ideal + float(offset)
                point = pivot + axis * x + height * (math.cos(angle) * base + math.sin(angle) * cross)
                vertices = np.vstack([existing, point])
                if collides(vertices, new_index, paper_triangles):
                    continue
                target_error = float(np.sum((point - target[new_index]) ** 2))
                bend = 0. if not angles else math.atan2(math.sin(angle - angles[-1]),
                                                        math.cos(angle - angles[-1]))
                score = cost + target_error + .0015 * bend * bend + .0001 * offset * offset
                proposals.append((score, vertices, angles + [angle]))
        if not proposals:
            raise RuntimeError(f'No collision-free rigid fold remains at material vertex {new_index}')
        proposals.sort(key=lambda item: item[0])
        beam = proposals[:beam_width]
        if new_index % 20 == 0 or new_index == len(target) - 1:
            row = {'vertex': new_index, 'beam': len(beam), 'bestCost': beam[0][0],
                   'bestTargetError': float(np.linalg.norm(beam[0][1][-1] - target[new_index]))}
            trace.append(row)
            print(json.dumps(row), flush=True)
    return beam[0][1], np.asarray(beam[0][2]), trace


def inspect_surface(vertices, rest, faces):
    edge_ids = np.unique(np.sort(np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]],
                                                 faces[:, [2, 0]]]), axis=1), axis=0)
    ratios = (np.linalg.norm(vertices[edge_ids[:, 0]] - vertices[edge_ids[:, 1]], axis=1) /
              np.linalg.norm(rest[edge_ids[:, 0]] - rest[edge_ids[:, 1]], axis=1))
    candidates = intersections(vertices, faces.tolist(), None)
    positive = []
    for first, second in candidates:
        category, measure = classify(vertices[faces[first]], vertices[faces[second]])
        if category in ('transverse_interior', 'coplanar_area'):
            positive.append({'faces': [first, second], 'category': category, 'measure': measure})
    paper_vertices, paper_faces = paper_geometry()
    paper_triangles = paper_vertices[paper_faces]
    paper_hits = 0
    for face in faces:
        paper_hits += int(penetrates_paper(vertices[face], paper_triangles))
    inside = np.all((vertices > PAPER_LOW + 1e-8) & (vertices < PAPER_HIGH - 1e-8), axis=1)
    return {'edgeRatioMin': float(ratios.min()), 'edgeRatioMax': float(ratios.max()),
            'bvhCandidates': len(candidates), 'strictIntersections': len(positive),
            'intersectionDetails': positive[:100], 'paperIntersectingFaces': paper_hits,
            'paperInsideVertices': int(inside.sum())}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--design', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--pitch', type=float, default=.65)
    parser.add_argument('--beam-width', type=int, default=32)
    parser.add_argument('--angle-steps', type=int, default=8)
    parser.add_argument('--subdivisions', type=int, default=3)
    args = parser.parse_args()
    if args.out.exists() and any(args.out.iterdir()):
        parser.error('Use a new empty output directory')
    if args.pitch <= 0 or args.beam_width < 1 or args.angle_steps < 1 or args.subdivisions < 1:
        parser.error('Positive bounded search parameters are required')
    args.out.mkdir(parents=True, exist_ok=True)
    source = Path(__file__).read_bytes()
    design_source = args.design.read_bytes()
    design = json.loads(design_source)
    ports = np.asarray(design['waypoints'], dtype=float)
    target, coarse_rest, samples, parameters = target_strip(ports, args.pitch)
    coarse, angles, trace = fabricate(target, coarse_rest, args.beam_width, args.angle_steps)
    vertices, rest, faces, owners = subdivide(coarse, coarse_rest, args.subdivisions)
    inspection = inspect_surface(vertices, rest, faces)
    passed = (inspection['strictIntersections'] == 0 and
              inspection['paperIntersectingFaces'] == 0 and
              inspection['paperInsideVertices'] == 0 and
              max(abs(inspection['edgeRatioMin'] - 1), abs(inspection['edgeRatioMax'] - 1)) < 1e-8)
    np.savez_compressed(args.out / 'candidate.npz', vertices=vertices, flatRest=rest, faces=faces,
                        materialCoordinates=rest[:, :2], coarseVertices=coarse,
                        coarseFlatRest=coarse_rest, triangleOwner=owners, angles=angles,
                        guidePorts=ports, materialGuideParameters=parameters,
                        restWidth=np.array(WIDTH), across=np.array(2))
    evidence = {'schemaVersion': 1, 'construction': 'collision-aware sequential rigid-triangle folds',
                'sourceSha256': hashlib.sha256(source).hexdigest(),
                'designSha256': hashlib.sha256(design_source).hexdigest(),
                'pitch': args.pitch, 'beamWidth': args.beam_width,
                'angleStepsPerSide': args.angle_steps, 'subdivisions': args.subdivisions,
                'coarseVertices': len(coarse), 'vertices': len(vertices), 'faces': len(faces),
                'materialLength': float(samples[-1]), 'inspection': inspection,
                'searchTrace': trace, 'preflightPassed': passed,
                'physicsRun': False, 'visualAdmission': False, 'releaseCompleteFrame': None}
    (args.out / 'construction-evidence.json').write_text(json.dumps(evidence, indent=2))
    if not passed:
        print(json.dumps({'preflightPassed': False, **inspection}), flush=True)
        return

    import bpy
    from mathutils import Vector
    from PIL import Image, ImageDraw
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    mesh = bpy.data.meshes.new('Collision-free exact-metric ribbon')
    mesh.from_pydata(vertices.tolist(), [], faces.tolist())
    mesh.update()
    ribbon = bpy.data.objects.new('Sequential rigid-fold bow candidate', mesh)
    scene.collection.objects.link(ribbon)
    ribbon.shape_key_add(name='Basis')
    key = ribbon.shape_key_add(name='Flat rectangular material rest')
    key.data.foreach_set('co', rest.ravel())
    key.value = 0
    render_setup(scene, ribbon, 2)
    for polygon in mesh.polygons:
        station = float(rest[list(polygon.vertices), 0].mean())
        stripe = int(station / WIDTH)
        polygon.material_index = 0 if station / WIDTH - stripe > .18 else 1 + stripe % 3
    bpy.ops.wm.save_as_mainfile(filepath=str(args.out / 'sequential-fold-initial.blend'))
    entries = []
    for view in ['front', 'side']:
        if view == 'side':
            scene.camera.location = (25, -8, 3)
            scene.camera.rotation_euler = (Vector((0, 1, 0)) - scene.camera.location).to_track_quat('-Z', 'Y').to_euler()
        scene.render.filepath = str(args.out / f'{view}-001.png')
        bpy.ops.render.render(write_still=True)
        entries.append(args.out / f'{view}-001.png')
    sheet = Image.new('RGB', (960, 400), (239, 237, 231))
    draw = ImageDraw.Draw(sheet)
    for index, path in enumerate(entries):
        image = Image.open(path).convert('RGBA')
        tile = Image.new('RGBA', image.size, (239, 237, 231, 255))
        tile.alpha_composite(image)
        sheet.paste(tile.convert('RGB').resize((480, 320)), (index * 480, 0))
        draw.text((index * 480 + 10, 328), path.stem, fill=(20, 20, 20))
    draw.text((10, 360), 'STATIC PREFLIGHT ONLY / exact metric / no intersections / no physics run', fill=(20, 20, 20))
    sheet.save(args.out / 'front-side-contact-sheet.jpg', quality=94)
    print(json.dumps({'preflightPassed': True, **inspection}), flush=True)


if __name__ == '__main__':
    main()
