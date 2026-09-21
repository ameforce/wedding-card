"""Bounded diagnostic cloth study. Only free-end hooks animate before Cloth.

Study output is never production-admitted by this script. The optional initial
module is preserved evidence and only its geometry(0) is evaluated.
"""
import argparse
import hashlib
import importlib.util
import json
import math
import shutil
import time
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree


def validate_timeline(args):
    """Keep the authored motion timeline independent of a bounded evaluation."""
    if args.settle < 1 or args.frames < 1:
        raise ValueError('frames and settle must be positive')
    authored_end=max(180,args.frames,args.settle+1) if args.initial_only else args.frames
    if authored_end <= args.settle:
        raise ValueError('frames must be greater than settle; pull cannot overwrite the initial hold')
    if args.fall_after is not None and not args.settle < args.fall_after < authored_end-args.settle_after:
        raise ValueError('fall-after must follow settle and precede the final fall key')
    if args.single_tail and args.release_opposite_frame <= 1:
        raise ValueError('opposite pin release must follow frame 1')
    if args.release_pull_frame is not None and args.release_pull_frame <= 1:
        raise ValueError('pull pin release must follow frame 1')
    evaluation_end=1 if args.initial_only else (args.evaluate_through or authored_end)
    if not 1 <= evaluation_end <= authored_end:
        raise ValueError('evaluation must end within the authored timeline')
    return authored_end,evaluation_end


def validate_pull_path(path):
    if not path or path[0]['frame'] != 1 or path[0]['offset'] != [0,0,0]:
        raise ValueError('explicit pull path must start at frame 1 with zero offset')
    previous=0
    for point in path:
        if point['frame'] <= previous or len(point['offset']) != 3 or not all(math.isfinite(v) for v in point['offset']):
            raise ValueError('pull path needs increasing unique frames and finite XYZ offsets')
        previous=point['frame']


def hook_readback():
    result={}
    for side in ['left','right']:
        hook=bpy.data.objects[f'{side} tail pull']
        result[side]={'location':list(hook.location),'matrixWorld':[list(row) for row in hook.matrix_world],
            'curves':[{'path':curve.data_path,'axis':curve.array_index,
                'keys':[[float(k.co.x),float(k.co.y)] for k in curve.keyframe_points]}
                for curve in hook.animation_data.action.fcurves]}
    return result


def intersections(vertices, faces, across):
    tree = BVHTree.FromPolygons([Vector(v) for v in vertices], faces)
    face_sets = [set(f) for f in faces]
    return [(a, b) for a, b in tree.overlap(tree) if a < b
            and not face_sets[a].intersection(face_sets[b])]


def initial(source, stride, depth, repair=False):
    if source.suffix == '.npz':
        data = np.load(source)
        v, f, across = data['vertices'], data['faces'].tolist(), int(data['across'])
        if repair:
            v = separate_initial_layers(v, f, across)
        flat = data['flatRest']
        coordinates = data['materialCoordinates'] if 'materialCoordinates' in data else flat[:, :2]
        stations = np.unique(np.round(coordinates[:, 0], 10))
        groups = [np.where(np.isclose(coordinates[:, 0], station, atol=1e-9))[0] for station in stations]
        left = np.where(np.isclose(coordinates[:, 0], stations[0], atol=1e-9))[0].tolist()
        right = np.where(np.isclose(coordinates[:, 0], stations[-1], atol=1e-9))[0].tolist()
        structured = (len(v) % across == 0 and all(len(face) == 4 for face in f))
        pitch = float(np.median(np.diff(stations))) if len(stations) > 1 else 1.
        material = {'structured': structured, 'coordinates': coordinates,
                    'centerlineGroups': groups, 'tipIndices': {'left': left, 'right': right},
                    'faceStations': np.asarray([coordinates[np.asarray(face), 0].mean() for face in f]),
                    'pitch': pitch}
        return v, f, flat, across, material
    spec = importlib.util.spec_from_file_location('initial_evidence', source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    vertices, _, centers, _ = module.geometry(0)
    rows = list(range(0, len(centers), stride))
    if rows[-1] != len(centers)-1:
        rows.append(len(centers)-1)
    across = 5
    v = np.array([[vertices[i*module.ACROSS+j][k] for k in range(3)]
                  for i in rows for j in (0, 2, 4, 6, 8)])
    v[:, 1] *= depth
    faces = []
    for i in range(len(rows)-1):
        for j in range(across-1):
            a = i*across+j
            faces.append((a, a+1, a+across+1, a+across))
    if repair:
        v = separate_initial_layers(v, faces, across)
    c = v.reshape(-1, across, 3)[:, across//2, :]
    s = np.r_[0., np.linalg.norm(np.diff(c, axis=0), axis=1).cumsum()]
    flat = np.array([(x, (j/(across-1)-.5)*module.WIDTH, 0.)
                     for x in s for j in range(across)])
    coordinates = flat[:, :2]
    material = {'structured': True, 'coordinates': coordinates,
                'centerlineGroups': [np.arange(i * across, (i + 1) * across) for i in range(len(rows))],
                'tipIndices': {'left': list(range(across * 2)),
                               'right': list(range(len(v) - across * 2, len(v)))},
                'faceStations': np.asarray([coordinates[np.asarray(face), 0].mean() for face in faces]),
                'pitch': float(np.median(np.diff(np.unique(coordinates[:, 0]))))}
    return v, faces, flat, across, material


def separate_initial_layers(vertices, faces, across):
    """Static passage design: preserve initial over/under order, separate layers.

    This never runs during animation and does not author any release pose.
    Each update moves whole material rows in depth with smooth falloff.
    """
    original = vertices.reshape(-1, across, 3).copy()
    rows = len(original)
    offsets = np.zeros(rows)
    indices = np.arange(rows)
    for iteration in range(400):
        v = original.copy()
        v[:, :, 1] += offsets[:, None]
        pairs = intersections(v.reshape(-1, 3), faces, across)
        if not pairs:
            print(json.dumps({'initialLayerSeparationIterations': iteration,
                              'depthOffsetMin': float(offsets.min()),
                              'depthOffsetMax': float(offsets.max())}), flush=True)
            return v.reshape(-1, 3)
        changes = np.zeros(rows)
        counts = np.zeros(rows)
        material_pairs = set((min(faces[a])//across, min(faces[b])//across) for a,b in pairs)
        for a,b in material_pairs:
            sign = 1 if v[a,across//2,1] >= v[b,across//2,1] else -1
            for row, direction in [(a, sign), (b, -sign)]:
                kernel = np.exp(-((indices-row)/.8)**2)
                changes += direction*.025*kernel
                counts += kernel
        offsets += changes/np.maximum(1., counts)
    raise ValueError(f'Initial passage remains intersecting after bounded separation: {len(pairs)}')


def material(name, color):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1)
    mat.use_nodes = True
    shader = mat.node_tree.nodes.get('Principled BSDF')
    shader.inputs['Base Color'].default_value = (*color, 1)
    shader.inputs['Roughness'].default_value = .8
    return mat


def render_setup(scene, ribbon, across):
    palette = [(0.72, .72, .69), (.08, .25, .62), (.85, .2, .1), (.06, .5, .28)]
    for i, color in enumerate(palette):
        ribbon.data.materials.append(material(f'Fixed material coordinate stripe {i}', color))
    for face in ribbon.data.polygons:
        row = min(face.vertices)//across
        face.material_index = 0 if row % 12 > 2 else 1+(row//12)%3
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 8
    scene.cycles.use_denoising = True
    scene.render.resolution_x, scene.render.resolution_y = 960, 640
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    scene.render.film_transparent = True
    world = bpy.data.worlds.new('Neutral diagnostic studio')
    world.use_nodes = True
    world.node_tree.nodes['Background'].inputs['Strength'].default_value = .65
    scene.world = world
    data = bpy.data.cameras.new('Fixed diagnostic camera')
    data.type, data.ortho_scale = 'ORTHO', 16
    cam = bpy.data.objects.new('Fixed diagnostic camera', data)
    scene.collection.objects.link(cam)
    cam.location = (0, -35, -.65)
    cam.rotation_euler = (math.pi/2, 0, 0)
    scene.camera = cam
    light = bpy.data.lights.new('Broad neutral light', 'AREA')
    light.energy, light.size = 1800, 8
    ob = bpy.data.objects.new('Broad neutral light', light)
    scene.collection.objects.link(ob)
    ob.location = (-4, -10, 8)
    ob.rotation_euler = (Vector((0,0,0))-ob.location).to_track_quat('-Z','Y').to_euler()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--initial-source', type=Path, required=True)
    parser.add_argument('--stride', type=int, default=4)
    parser.add_argument('--depth', type=float, default=1.5)
    parser.add_argument('--frames', type=int, default=180)
    parser.add_argument('--pull', type=float, default=14.)
    parser.add_argument('--gravity', type=float, default=-.35)
    parser.add_argument('--quality', type=int, default=12)
    parser.add_argument('--settle', type=int, default=12)
    parser.add_argument('--render-every', type=int, default=30)
    parser.add_argument('--separate-layers', action='store_true')
    parser.add_argument('--fall-after', type=int)
    parser.add_argument('--fall-distance', type=float, default=12.)
    parser.add_argument('--settle-after', type=int, default=0)
    parser.add_argument('--collision-quality', type=int, default=6)
    parser.add_argument('--bending-stiffness',type=float,default=.015)
    parser.add_argument('--bending-damping',type=float,default=.5)
    parser.add_argument('--tension-stiffness',type=float,default=65.)
    parser.add_argument('--compression-stiffness',type=float,default=65.)
    parser.add_argument('--shear-stiffness',type=float,default=30.)
    parser.add_argument('--material-damping',type=float,default=8.)
    parser.add_argument('--self-distance-min',type=float,default=.004)
    parser.add_argument('--pin-center-only',action='store_true',help='Pin only the center vertex of each of two free-tip rows')
    parser.add_argument('--initial-only', action='store_true')
    parser.add_argument('--evaluate-through',type=int,help='Evaluate only this many sequential frames without shortening authored motion')
    parser.add_argument('--allow-invalid-initial-for-diagnostics', action='store_true')
    parser.add_argument('--single-tail',action='store_true')
    parser.add_argument('--pull-side',choices=['left','right'],default='left',
                        help='Material endpoint driven by --pull-path-file; the opposite endpoint is released')
    parser.add_argument('--release-opposite-frame',type=int,default=13)
    parser.add_argument('--release-pull-frame',type=int)
    parser.add_argument('--pull-path-file',type=Path,help='Explicit frame/XYZ offsets for --pull-side only')
    parser.add_argument('--consume-rest-at-start',action='store_true',help='Always-active non-pin VWM, matching the isolated v6 runtime probe')
    args = parser.parse_args()
    if min(args.tension_stiffness,args.compression_stiffness,args.shear_stiffness,args.material_damping)<=0:
        parser.error('Material stiffness and damping values must be positive')
    try:
        authored_end,evaluation_end=validate_timeline(args)
        explicit_path=json.loads(args.pull_path_file.read_text(encoding='utf-8-sig')) if args.pull_path_file else None
        if explicit_path is not None:validate_pull_path(explicit_path)
    except ValueError as error:
        parser.error(str(error))
    out = args.out.resolve()
    if out.exists() and any(out.iterdir()):
        parser.error('Output must be new or empty')
    out.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.fps = 60
    scene.frame_start, scene.frame_end = 1, authored_end
    scene.gravity = (0, 0, args.gravity)
    vertices, faces, flat, across, material = initial(args.initial_source, args.stride, args.depth, args.separate_layers)
    core_rows=None
    if args.initial_source.suffix=='.npz':
        with np.load(args.initial_source) as source_data:
            if 'coreRows' in source_data:core_rows=set(map(int,source_data['coreRows']))
    mesh = bpy.data.meshes.new('Continuous flat-rest strip')
    mesh.from_pydata(vertices.tolist(), [], faces)
    ribbon = bpy.data.objects.new('One locally sliding bow strip', mesh)
    scene.collection.objects.link(ribbon)
    ribbon.shape_key_add(name='Basis')
    rest = ribbon.shape_key_add(name='Flat rectangular material rest')
    rest.data.foreach_set('co', flat.ravel())
    rest.value = 0
    pins = ribbon.vertex_groups.new(name='Only two free-tail tips')
    tip_indices={side:list(indices) for side,indices in material['tipIndices'].items()}
    if args.pin_center_only:
        tip_indices={side:[min(indices,key=lambda index:abs(material['coordinates'][index,1]))]
                     for side,indices in tip_indices.items()}
    for side, indices in tip_indices.items():
        pins.add(indices, 1., 'REPLACE')
        group = ribbon.vertex_groups.new(name=f'{side} tiny tip')
        group.add(indices, 1., 'REPLACE')
        hook = bpy.data.objects.new(f'{side} tail pull', None)
        scene.collection.objects.link(hook)
        mod = ribbon.modifiers.new(f'{side} tip only, before Cloth', 'HOOK')
        mod.object = hook
        mod.vertex_group = group.name
        hook.location = (0, 0, 0)
        hook.keyframe_insert(data_path='location', frame=1)
        hook.keyframe_insert(data_path='location', frame=args.settle)
        hook.location = ((-1 if side == 'left' else 1)*args.pull, -1.2, 2.0)
        if args.single_tail and side!=args.pull_side:
            hook.location=(.35,-.05,.1)
        hook.keyframe_insert(data_path='location', frame=args.fall_after or authored_end)
        if args.fall_after:
            hook.location.z -= args.fall_distance
            hook.keyframe_insert(data_path='location', frame=authored_end-args.settle_after)
        for curve in hook.animation_data.action.fcurves:
            for key in curve.keyframe_points:
                key.interpolation = 'LINEAR'
        if args.pull_path_file and side==args.pull_side:
            hook.animation_data_clear()
            for point in explicit_path:
                hook.location=point['offset']
                hook.keyframe_insert(data_path='location',frame=point['frame'])
            for curve in hook.animation_data.action.fcurves:
                for key in curve.keyframe_points:key.interpolation='LINEAR'
        if any(abs(curve.evaluate(1))>1e-8 for curve in hook.animation_data.action.fcurves):
            raise ValueError('Frame 1 hook offset must remain zero before Cloth evaluation')
    if args.single_tail:
        opposite_side='right' if args.pull_side=='left' else 'left'
        release_specs=[(opposite_side,args.release_opposite_frame)]
        if args.release_pull_frame:release_specs.append((args.pull_side,args.release_pull_frame))
        for side,release_frame in release_specs:
            release=ribbon.modifiers.new(f'Release only {side} free-tip pin','VERTEX_WEIGHT_MIX')
            release.vertex_group_a=pins.name
            release.vertex_group_b=f'{side} tiny tip'
            release.default_weight_a=0.
            release.default_weight_b=0.
            release.mix_mode='SUB'
            release.mix_set='A'
            release.mask_constant=0.
            release.keyframe_insert(data_path='mask_constant',frame=1)
            release.keyframe_insert(data_path='mask_constant',frame=release_frame-1)
            release.mask_constant=1.
            release.keyframe_insert(data_path='mask_constant',frame=release_frame)
        for curve in ribbon.animation_data.action.fcurves:
            for key in curve.keyframe_points:key.interpolation='CONSTANT'
    if args.consume_rest_at_start:
        dummy_a=ribbon.vertex_groups.new(name='Dummy destination weights')
        dummy_b=ribbon.vertex_groups.new(name='Dummy subtractor weights')
        dummy_a.add([across*3,across*3+1],.75,'REPLACE')
        dummy_b.add([across*3,across*3+1],.25,'REPLACE')
        dummy=ribbon.modifiers.new('Always active rest-data evaluation','VERTEX_WEIGHT_MIX')
        dummy.vertex_group_a=dummy_a.name;dummy.vertex_group_b=dummy_b.name
        dummy.default_weight_a=0.;dummy.default_weight_b=0.
        dummy.mix_mode='SUB';dummy.mix_set='A';dummy.mask_constant=1.
    # Key insertion leaves the object at the last authored value. Reset every
    # animated hook/weight before any operator can initialize the Cloth cache.
    scene.frame_set(1)
    bpy.context.view_layer.update()
    before_cloth={'sceneFrame':scene.frame_current,'hooks':hook_readback(),'clothAlreadyPresent':any(m.type=='CLOTH' for m in ribbon.modifiers)}
    if any(abs(value)>1e-8 for h in before_cloth['hooks'].values() for value in h['location']):
        raise ValueError('Hooks must be physically at the origin before attaching Cloth')
    cloth = ribbon.modifiers.new('Contact-constrained Cloth', 'CLOTH')
    settings = cloth.settings
    settings.quality = args.quality
    settings.mass = .12
    settings.air_damping = 2
    settings.tension_stiffness = args.tension_stiffness
    settings.compression_stiffness = args.compression_stiffness
    settings.shear_stiffness = args.shear_stiffness
    settings.bending_stiffness = args.bending_stiffness
    settings.tension_damping = args.material_damping
    settings.compression_damping = args.material_damping
    settings.shear_damping = args.material_damping
    settings.bending_damping = args.bending_damping
    settings.vertex_group_mass = pins.name
    settings.pin_stiffness = 1
    settings.rest_shape_key = rest
    settings.use_dynamic_mesh = False
    collision = cloth.collision_settings
    collision.use_collision = True
    collision.use_self_collision = True
    collision.collision_quality = args.collision_quality
    collision.distance_min = .012
    collision.self_distance_min = args.self_distance_min
    collision.self_friction = 1
    cloth.point_cache.frame_start, cloth.point_cache.frame_end = 1, authored_end
    # The ribbon wraps around this finite card; geometry and collision agree.
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 1.3*args.depth, 0))
    paper = bpy.context.object
    paper.name = 'Actual card back occlusion'
    paper.dimensions = (14.0, .45*args.depth, 9.)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    paper.modifiers.new('Real paper collision', 'COLLISION')
    paper.collision.thickness_outer = .012
    paper.collision.cloth_friction = 2
    holdout = bpy.data.materials.new('Paper holdout')
    holdout.use_nodes = True
    nd = holdout.node_tree.nodes
    nd.clear()
    h, o = nd.new('ShaderNodeHoldout'), nd.new('ShaderNodeOutputMaterial')
    holdout.node_tree.links.new(h.outputs[0], o.inputs[0])
    paper.data.materials.append(holdout)
    render_setup(scene, ribbon, across)
    if not material['structured']:
        for polygon in mesh.polygons:
            station=float(flat[list(polygon.vertices),0].mean())
            stripe=int(station/.85)
            polygon.material_index=0 if station/.85-stripe>.18 else 1+stripe%3
    edges = np.array([e.vertices[:] for e in mesh.edges])
    rest_lengths = np.linalg.norm(flat[edges[:, 0]]-flat[edges[:, 1]], axis=1)
    pairs = intersections(vertices, faces, across)
    paper_tree=BVHTree.FromPolygons([paper.matrix_world@v.co for v in paper.data.vertices],
                                   [tuple(f.vertices) for f in paper.data.polygons])
    ribbon_tree=BVHTree.FromPolygons([Vector(v) for v in vertices],faces)
    paper_pairs=ribbon_tree.overlap(paper_tree)
    ymin,ymax=(1.3-.225)*args.depth,(1.3+.225)*args.depth
    inside=(np.abs(vertices[:,0])<7)&(vertices[:,1]>ymin)&(vertices[:,1]<ymax)&(np.abs(vertices[:,2])<4.5)
    report = {'schemaVersion': 1, 'bpyVersion': bpy.app.version_string,
              'scriptSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              'initialSourceSha256':hashlib.sha256(args.initial_source.read_bytes()).hexdigest(),
              'dynamicMesh': settings.use_dynamic_mesh, 'restShape': rest.name,
              'pinVertices':sum(len(v) for v in tip_indices.values()),'pinVertexIndices':tip_indices,
              'widthSamples':across if material['structured'] else None,
              'materialTopology':'structured_rows' if material['structured'] else 'triangulated_material_coordinates',
              'materialStationCount':len(material['centerlineGroups']),'totalVertices': len(vertices),
              'coreMaterialRows':sorted(core_rows) if core_rows is not None else None,
              'authoredFrameEnd':authored_end,'evaluationFrameEnd':evaluation_end,
              'beforeCloth':before_cloth,'freshCacheBaked':cloth.point_cache.is_baked,
              'initialHookOffsets':{side:[float(curve.evaluate(1)) for curve in bpy.data.objects[f'{side} tail pull'].animation_data.action.fcurves] for side in ['left','right']},
              'initialNonlocalTriangleIntersections': len(pairs),
              'initialIntersectionFacePairs': pairs[:100],
              'initialPaperFaceIntersections':len(paper_pairs),
              'initialVerticesInsidePaper':int(inside.sum()),
              'intersectionExemption':'only faces sharing actual vertices',
              'settings': vars(args) | {'out': str(out), 'initial_source': str(args.initial_source),
                  'pull_path_file':str(args.pull_path_file) if args.pull_path_file else None},
              'releaseCompleteFrame': None, 'visualAdmission': False, 'frames': []}
    (out/'initial-evidence.json').write_text(json.dumps(report, indent=2))
    shutil.copy2(Path(__file__),out/'cloth_study.py')
    if (pairs or paper_pairs or inside.any()) and not args.allow_invalid_initial_for_diagnostics:
        raise ValueError('Initial surface fails the complete self/paper contact gate; no simulation admitted.')
    scene.frame_set(1)
    bpy.ops.wm.save_as_mainfile(filepath=str(out/'cloth-source.blend'))
    snapshots = []
    started = time.monotonic()
    for frame in range(1, evaluation_end+1):
        scene.frame_set(frame)
        evaluated = ribbon.evaluated_get(bpy.context.evaluated_depsgraph_get())
        evaluated_mesh = evaluated.to_mesh()
        xyz = np.empty(len(vertices)*3)
        evaluated_mesh.vertices.foreach_get('co', xyz)
        pin_attribute_available=any(len(vertex.groups)>0 for vertex in evaluated_mesh.vertices)
        pin_weights=[]
        for vertex in evaluated_mesh.vertices:
            pin_weights.append(next((g.weight for g in vertex.groups if g.group==pins.index),0.))
        xyz = xyz.reshape(-1, 3)
        evaluated.to_mesh_clear()
        if not np.isfinite(xyz).all():
            (out/'simulation-failure.json').write_text(json.dumps({'frame':frame,'reason':'non-finite evaluated Cloth coordinates',
                'lastFiniteFrame':frame-1,'visualAdmission':False},indent=2))
            raise ValueError(f'Cloth produced non-finite coordinates at frame {frame}; diagnostic run stopped.')
        snapshots.append(xyz.copy())
        ratios = np.linalg.norm(xyz[edges[:,0]]-xyz[edges[:,1]], axis=1)/rest_lengths
        centerline=np.asarray([xyz[indices].mean(axis=0) for indices in material['centerlineGroups']])
        row = {'frame': frame, 'seconds': round(time.monotonic()-started, 3),
               'edgeRatioMin': float(ratios.min()), 'edgeRatioMax': float(ratios.max()),
               'edgeRatioMedian': float(np.median(ratios)),
               'centerlineLength': float(np.linalg.norm(np.diff(centerline, axis=0), axis=1).sum()),
               'minimum': xyz.min(axis=0).tolist(), 'maximum': xyz.max(axis=0).tolist()}
        row['pinGroupAttributeAvailable']=pin_attribute_available
        row['effectivePinnedVertices']=sum(w>.999 for w in pin_weights) if pin_attribute_available else None
        row['effectiveLeftTipPinWeight']=float(np.mean([pin_weights[i] for i in tip_indices['left']])) if pin_attribute_available else None
        row['effectiveRightTipPinWeight']=float(np.mean([pin_weights[i] for i in tip_indices['right']])) if pin_attribute_available else None
        row['pinPositions']={side:xyz[indices].tolist() for side,indices in tip_indices.items()}
        row['leftTipPosition']=xyz[tip_indices['left']].mean(axis=0).tolist()
        row['rightTipPosition']=xyz[tip_indices['right']].mean(axis=0).tolist()
        if frame==1:
            displacement=xyz-vertices
            row['inputDisplacementMax']=float(np.linalg.norm(displacement,axis=1).max())
            row['inputDisplacementRms']=float(np.sqrt(np.mean(displacement**2)))
            row['hooks']=hook_readback()
            row['initialLeftTipDelta']=(xyz[tip_indices['left']]-vertices[tip_indices['left']]).mean(axis=0).tolist()
            row['initialRightTipDelta']=(xyz[tip_indices['right']]-vertices[tip_indices['right']]).mean(axis=0).tolist()
        face_pairs=intersections(xyz, faces, across)
        row['nonAdjacentFaceIntersections'] = len(face_pairs)
        # Local fold pairs remain genuine intersections; this distinction never
        # exempts them. Remote material pairs may change knot passage topology.
        material_pairs=[(int(round(material['faceStations'][a]/material['pitch'])),
                         int(round(material['faceStations'][b]/material['pitch']))) for a,b in face_pairs]
        row['localFoldFaceIntersections']=sum(abs(a-b)<=2 for a,b in material_pairs)
        row['remoteMaterialFaceIntersections']=sum(abs(a-b)>2 for a,b in material_pairs)
        row['coreInvolvedFaceIntersections']=sum(a in core_rows or b in core_rows for a,b in material_pairs) if core_rows is not None else None
        row['coreRemoteMaterialFaceIntersections']=sum(abs(a-b)>2 and (a in core_rows or b in core_rows) for a,b in material_pairs) if core_rows is not None else None
        row['intersectionMaterialRows']=sorted(set(material_pairs))
        current_tree=BVHTree.FromPolygons([Vector(v) for v in xyz],faces)
        row['paperFaceIntersections']=len(current_tree.overlap(paper_tree))
        current_inside=(np.abs(xyz[:,0])<7)&(xyz[:,1]>ymin)&(xyz[:,1]<ymax)&(np.abs(xyz[:,2])<4.5)
        row['verticesInsidePaper']=int(current_inside.sum())
        if frame == 1 or frame % args.render_every == 0 or frame == evaluation_end:
            scene.render.filepath = str(out/f'front-{frame:03d}.png')
            bpy.ops.render.render(write_still=True)
            print(json.dumps(row), flush=True)
            # Keep exact physical progress recoverable if the host turn ends.
            temporary=out/'checkpoint-writing.npz'
            np.savez_compressed(temporary,vertices=np.array(snapshots),faces=np.array(faces),flatRest=flat,
                                materialCoordinates=material['coordinates'],
                                across=across if material['structured'] else 0)
            temporary.replace(out/'checkpoint-vertices.npz')
        report['frames'].append(row)
        if frame % 10 == 0:
            (out/'progress.json').write_text(json.dumps(row, indent=2))
    np.savez_compressed(out/'simulated-vertices.npz', vertices=np.array(snapshots), faces=np.array(faces), flatRest=flat,
                        materialCoordinates=material['coordinates'],
                        across=across if material['structured'] else 0)
    (out/'simulation-evidence.json').write_text(json.dumps(report, indent=2))
    print('CLOTH_STUDY_COMPLETE', flush=True)


if __name__ == '__main__':
    main()
