"""Author the fixed 46-frame ribbon scene using only adjacent CC0 source data.

Requires the pinned bpy 4.5.13 runtime. Does not import study modules, open a
source blend, execute embedded scripts, render frames, or overwrite outputs.
"""
import argparse
import bisect
import hashlib
import json
import math
import shutil
from pathlib import Path

import bpy
from mathutils import Vector, Quaternion

ACROSS = 9
ARM_ROWS = 501
BACK_ROWS = 501
WIDTH = .85
VIEW = Vector((0, -1, 0))
FRAME_COUNT = 46
FPS = 30
CANVAS = (960, 640)
RIBBON = 'One locally sliding bow strip'
PAPER = 'Actual card back occlusion'
CAMERA = 'Fixed diagnostic camera'
VERIFY_FRAMES = [0, 12, 20, 27, 31, 35, 38, 45]
DATA_PATH = Path(__file__).with_name('source-knot.json')


def load_source():
    data = json.loads(DATA_PATH.read_text(encoding='utf-8'))
    if data.get('schemaVersion') != 1 or len(data.get('splines', [])) != 2:
        raise ValueError('Expected source-knot schema 1 and two splines.')
    for spline in data['splines']:
        if len(spline['bezierPoints']) != 9:
            raise ValueError('Expected nine control points per source spline.')
        for point in spline['bezierPoints']:
            for key in ('co', 'left', 'right'):
                if len(point[key]) != 3 or not all(math.isfinite(x) for x in point[key]):
                    raise ValueError('Control points must be finite XYZ triples.')
    return data


SOURCE_DATA = load_source()
SOURCE = SOURCE_DATA['splines']


def mapped(p):
    return Vector((p[0], -2.5*p[2], p[1]))


def smooth(a,b,t):
    x=min(1,max(0,(t-a)/(b-a)))
    return x*x*(3-2*x)

def cumulative(rail):
    clean=[rail[0]]
    for p in rail[1:]:
        if (p-clean[-1]).length>1e-8:clean.append(p)
    distances=[0.]
    for a,b in zip(clean,clean[1:]):distances.append(distances[-1]+(b-a).length)
    return clean,distances

def at(rail,distance,s):
    if s<0:return rail[0]+(rail[1]-rail[0]).normalized()*s
    if s>distance[-1]:return rail[-1]+(rail[-1]-rail[-2]).normalized()*(s-distance[-1])
    i=max(0,min(len(rail)-2,bisect.bisect_right(distance,s)-1))
    return rail[i].lerp(rail[i+1],(s-distance[i])/(distance[i+1]-distance[i]))

def shape_arm(index,progress):
    controls=[{key:mapped(p[key]) for key in ['co','left','right']} for p in SOURCE[index]['bezierPoints']]
    apex=2 if index==0 else 6
    gate=(controls[apex-1]['co']+controls[apex+1]['co'])*.5
    old_axis=controls[apex]['co']-gate;old_axis.y=0;old_length=old_axis.length;old_axis.normalize()
    old_side=Vector((-old_axis.z,0,old_axis.x))
    new_axis=Vector((2.8 if index==0 else -2.8,0,.46 if index==0 else .52))
    new_length=new_axis.length;new_axis.normalize();new_side=Vector((-new_axis.z,0,new_axis.x))
    def planar(delta):
        return new_axis*(delta.dot(old_axis)*new_length/old_length)+new_side*(delta.dot(old_side)*1.8)+Vector((0,delta.y,0))
    for key in ['co','left','right']:
        controls[apex][key]=gate+planar(controls[apex][key]-gate)
        controls[apex][key].y-=.30
    for point,key in [(apex-1,'right'),(apex+1,'left')]:
        controls[point][key]=controls[point]['co']+planar(controls[point][key]-controls[point]['co'])
    axis=(controls[apex]['co']-gate).normalized()
    rotation=Quaternion(axis,math.radians(60 if index==0 else -60));normal=rotation@VIEW
    for key in ['left','right']:
        controls[apex][key]=controls[apex]['co']+rotation@(controls[apex][key]-controls[apex]['co'])
    for point,key in [(apex-1,'right'),(apex+1,'left')]:
        controls[point][key]=controls[point]['co']+rotation@(controls[point][key]-controls[point]['co'])
    # Move the already anterior part of the existing A wrap farther forward;
    # it is still the same source segment, not an added decorative knot cap.
    if index==0:
        for i,point in enumerate(controls):
            for key,offset in [('left',-.33),('co',0),('right',.33)]:
                point[key].y-=.42*math.exp(-((i+offset-5.2)/.85)**4)
    controls[0]['right'].y=controls[0]['co'].y;controls[-1]['left'].y=controls[-1]['co'].y
    shrink=smooth(.02 if index==0 else .10,.52 if index==0 else .56,progress);scale=1-shrink
    for key in ['co','left','right']:controls[apex][key]=gate+(controls[apex][key]-gate)*scale
    for point,key in [(apex-1,'right'),(apex+1,'left')]:
        controls[point][key]=controls[point]['co']+(controls[point][key]-controls[point]['co'])*scale
    release=smooth(.665,.79,progress);align=smooth(.70,.81,progress)
    values=[];weights=[]
    for i in range(len(controls)-1):
        a,b,c,d=controls[i]['co'],controls[i]['right'],controls[i+1]['left'],controls[i+1]['co']
        for k in range(64):
            u=k/64;v=1-u;values.append(a*v**3+b*(3*v*v*u)+c*(3*v*u*u)+d*u**3)
            distance=abs(i+u-apex);weights.append(smooth(1.,.45,distance)*(1-release) if distance<1 else 0.)
    values.append(controls[-1]['co']);weights.append(0.)
    first,last=values[0].copy(),values[-1].copy()
    for i,p in enumerate(values):
        u=i/(len(values)-1);straight=first.lerp(last,u)
        straight.z=straight.z*(1-align)+.028*align-.22*(1-align)*math.sin(math.pi*u)
        values[i]=p.lerp(straight,release)
    return values,weights,normal,{'bightScale':scale,'collarRelease':release,'gate':list(gate),
        'loopPlaneRotationDegrees':60,'rootTipElevationDegrees':math.degrees(math.atan2(new_axis.z,abs(new_axis.x)))}

def source_arm(index,progress):
    values,weights,normal,row=shape_arm(index,progress)
    lift=smooth(.065,.56,progress)
    if lift==0:
        row['tailLiftProgress']=0
        row['freeTailRotationDegrees']=0
        return values,weights,normal,row
    release=row['collarRelease']
    pivot_index=64 if index==0 else 7*64
    endpoint_index=0 if index==0 else len(values)-1
    pivot=values[pivot_index].copy()
    delta=values[endpoint_index]-pivot
    current=math.atan2(delta.z,delta.x)
    # The pull becomes nearly horizontal as the collar releases. Compute
    # from the current tail direction so the existing final alignment is
    # not undone by applying a second, fixed-angle rotation on top of it.
    down_angle=.065*(1-release)
    target=-math.pi+down_angle if index==0 else -down_angle
    angle=(current-target+math.pi)%(2*math.pi)-math.pi
    indices=range(65) if index==0 else range(7*64,len(values))
    for i in indices:
        distance=abs(i-pivot_index)/64
        influence=smooth(.035,.72,distance)
        rotation=Quaternion(Vector((0,1,0)),angle*lift*influence)
        values[i]=pivot+rotation@(values[i]-pivot)
    row['tailLiftProgress']=lift
    row['freeTailRotationDegrees']=math.degrees(angle*lift)
    return values,weights,normal,row

INITIAL = [cumulative(shape_arm(i, 0)[0])[1][-1] for i in range(2)]
first_end = mapped(SOURCE[0]['bezierPoints'][-1]['co'])
second_start = mapped(SOURCE[1]['bezierPoints'][0]['co'])
corners = [first_end, Vector((7., first_end.y, .028)), Vector((8., 1., .028)),
           Vector((7., 2., .028)), Vector((-7., 2., .028)), Vector((-8., 1., .028)),
           Vector((-7., second_start.y, .028)), second_start]
BACK = []
for i in range(len(corners)-1):
    a = corners[max(0, i-1)]; b = corners[i]; c = corners[i+1]; d = corners[min(len(corners)-1, i+2)]
    for k in range(48):
        u = k/48; u2 = u*u; u3 = u2*u
        BACK.append(.5*(2*b+(-a+c)*u+(2*a-5*b+4*c-d)*u2+(-a+3*b-3*c+d)*u3))
BACK.append(second_start)
BACK, BACK_DISTANCE = cumulative(BACK)
MATERIAL = [INITIAL[0]*i/(ARM_ROWS-1) for i in range(ARM_ROWS)]
MATERIAL += [INITIAL[0]+BACK_DISTANCE[-1]*i/(BACK_ROWS-1) for i in range(1, BACK_ROWS-1)]
MATERIAL += [INITIAL[0]+BACK_DISTANCE[-1]+INITIAL[1]*i/(ARM_ROWS-1) for i in range(ARM_ROWS)]


def field_at(distance,values,s):
    if s<=0:return values[0]
    if s>=distance[-1]:return values[-1]
    i=min(len(values)-2,max(0,bisect.bisect_right(distance,s)-1));u=(s-distance[i])/(distance[i+1]-distance[i])
    return values[i]*(1-u)+values[i+1]*u

def strip_geometry(progress):
    arms=[];fields=[];info=[]
    for index in range(2):
        raw,weights,normal,row=source_arm(index,progress)
        # Source samples are distinct, including at zero bight scale because
        # the two gate positions remain different. Keep field indices aligned.
        distance=[0.]
        for a,b in zip(raw,raw[1:]):distance.append(distance[-1]+(b-a).length)
        payout=INITIAL[index]-distance[-1]
        samples=[INITIAL[index]*i/(ARM_ROWS-1)-(payout if index==0 else 0) for i in range(ARM_ROWS)]
        arms.append([at(raw,distance,s) for s in samples])
        fields.append([normal*field_at(distance,weights,s) for s in samples])
        info.append(dict(row,payout=payout,materialLength=INITIAL[index],curveLength=distance[-1]))
    centers=arms[0]+[at(BACK,BACK_DISTANCE,BACK_DISTANCE[-1]*i/(BACK_ROWS-1)) for i in range(1,BACK_ROWS-1)]+arms[1]
    loop_fields=fields[0]+[Vector((0,0,0)) for _ in range(BACK_ROWS-2)]+fields[1]
    pull=22*smooth(.50,.81,progress)
    if pull:
        distance=[0.]
        for a,b in zip(centers,centers[1:]):distance.append(distance[-1]+(b-a).length)
        new_centers=[at(centers,distance,s-pull) for s in MATERIAL]
        loop_fields=[field_at(distance,loop_fields,s-pull) for s in MATERIAL]
        centers=new_centers
    fall=13*smooth(.84,1,progress)
    centers=[p+Vector((0,0,-fall)) for p in centers]
    n=len(centers);tangents=[(centers[min(n-1,i+1)]-centers[max(0,i-1)]).normalized() for i in range(n)]
    verts=[];previous=Vector((0,0,1));gathers=[]
    release=smooth(.665,.79,progress)
    for p,tangent,field in zip(centers,tangents,loop_fields):
        camera_width=tangent.cross(VIEW)
        if camera_width.length<1e-7:camera_width=previous-tangent*previous.dot(tangent)
        camera_width.normalize()
        weight=min(1.,field.length)
        loop_width=field.normalized() if weight else camera_width
        if camera_width.dot(previous)<0:camera_width=-camera_width
        if loop_width.dot(camera_width)<0:loop_width=-loop_width
        width=camera_width*(1-weight)+loop_width*weight
        width=(width-tangent*width.dot(tangent)).normalized()
        if width.dot(previous)<0:width=-width
        previous=width
        normal=tangent.cross(width).normalized()
        if normal.dot(VIEW)<0:normal=-normal
        radius=math.sqrt(p.x*p.x+(p.z+fall)**2)
        gather=math.exp(-(radius/.79)**4)*(1-release)
        angle=1.25*gather
        gathers.append(gather)
        # Each half of this V has exact arclength WIDTH/2. Narrowing is a
        # physical fold in depth, never deletion of width near the knot.
        for j in range(ACROSS):
            s=(j/(ACROSS-1)-.5)*WIDTH
            verts.append(p+width*(math.cos(angle)*s)+normal*(math.sin(angle)*abs(s)))
    faces=[]
    for i in range(n-1):
        for j in range(ACROSS-1):
            k=i*ACROSS+j;faces.extend([(k,k+1,k+ACROSS+1),(k,k+ACROSS+1,k+ACROSS)])
    widths=[sum((verts[i*ACROSS+j+1]-verts[i*ACROSS+j]).length for j in range(ACROSS-1)) for i in range(n)]
    return verts,faces,centers,{'progress':progress,'arms':info,'postReleasePull':pull,'fall':fall,
        'crossSectionArclengthMin':min(widths),'crossSectionArclengthMax':max(widths),
        'sampledCenterlineLength':sum((b-a).length for a,b in zip(centers,centers[1:])),
        'freeStart':list(centers[0]),'freeEnd':list(centers[-1])}

def fold_geometry(progress):
    verts,faces,centers,row=strip_geometry(progress)
    release=smooth(.665,.79,progress);fall=row['fall']
    for i,p in enumerate(centers):
        radius=math.sqrt(p.x*p.x+(p.z+fall)**2)
        gather=math.exp(-(radius/.79)**4)*(1-release)
        front=smooth(.45,.78,-p.y)
        if front*gather<1e-6:continue
        start=i*ACROSS;edge0=verts[start];edge1=verts[start+ACROSS-1]
        width=(edge1-edge0).normalized();normal=((edge0+edge1)*.5-p).normalized()
        angle=1.25*gather*(1-.35*front)
        for j in range(ACROSS):
            s=(j/(ACROSS-1)-.5)*WIDTH
            verts[start+j]=p+width*(math.cos(angle)*s)+normal*(math.sin(angle)*abs(s))
    widths=[sum((verts[i*ACROSS+j+1]-verts[i*ACROSS+j]).length for j in range(ACROSS-1)) for i in range(len(centers))]
    row['crossSectionArclengthMin']=min(widths);row['crossSectionArclengthMax']=max(widths)
    return verts,faces,centers,row

def geometry(progress):
    verts,faces,centers,row=fold_geometry(progress)
    slack=smooth(.79,.90,progress)
    if progress>.79:
        old=centers
        old_distance=[0.]
        for a,b in zip(old,old[1:]):old_distance.append(old_distance[-1]+(b-a).length)
        warped=[]
        for p in old:
            lag=math.tanh(p.x/3.5)
            descent=13*smooth(.835+.004*lag,.995+.003*lag,progress)
            window=math.exp(-(p.x/6.)**4)
            sag=-.32*slack*math.exp(-(p.x/3.1)**2)
            wave=.10*slack*math.sin(.82*p.x+3.5*(progress-.79))*window
            depth=.16*slack*math.sin(.72*p.x-4*(progress-.79))*window
            warped.append(p+Vector((0,depth,row['fall']-descent+sag+wave)))
        distance=[0.]
        for a,b in zip(warped,warped[1:]):distance.append(distance[-1]+(b-a).length)
        # Keep the prior material arclength coordinates on the bent path.
        # Any added geometric length is paid out at the free end instead of
        # stretching all longitudinal rows when the strip sags.
        centers=[at(warped,distance,s) for s in old_distance]
        n=len(old)
        for i,(before,after) in enumerate(zip(old,centers)):
            old_tangent=(old[min(n-1,i+1)]-old[max(0,i-1)]).normalized()
            new_tangent=(centers[min(n-1,i+1)]-centers[max(0,i-1)]).normalized()
            bend=old_tangent.rotation_difference(new_tangent)
            twist_angle=.24*slack*math.sin(.92*after.x+4.8*(progress-.79))*math.exp(-(after.x/6.)**4)
            twist=Quaternion(new_tangent,twist_angle)
            # A rigid rotation per cross section preserves its full V-fold
            # arclength while allowing the now-loose cloth to turn in depth.
            for j in range(ACROSS):
                k=i*ACROSS+j
                verts[k]=after+twist@(bend@(verts[k]-before))
        row['sampledCenterlineLength']=sum((b-a).length for a,b in zip(centers,centers[1:]))
        row['freeStart']=list(centers[0]);row['freeEnd']=list(centers[-1])
    widths=[sum((verts[i*ACROSS+j+1]-verts[i*ACROSS+j]).length for j in range(ACROSS-1)) for i in range(len(centers))]
    row['crossSectionArclengthMin']=min(widths);row['crossSectionArclengthMax']=max(widths)
    row['releasedClothSlack']=slack
    row['maximumVertexZ']=max(v.z for v in verts)
    row['minimumVertexZ']=min(v.z for v in verts)
    return verts,faces,centers,row


def scene_contract():
    scene = bpy.context.scene
    bpy.context.view_layer.update()
    camera, paper = scene.camera, bpy.data.objects[PAPER]
    return {
        'frameRange': [scene.frame_start, scene.frame_end],
        'fps': scene.render.fps,
        'canvas': [scene.render.resolution_x, scene.render.resolution_y],
        'resolutionPercent': scene.render.resolution_percentage,
        'cameraName': camera.name,
        'cameraType': camera.data.type,
        'cameraOrthoScale': camera.data.ortho_scale,
        'cameraMatrix': [value for row in camera.matrix_world for value in row],
        'paperName': paper.name,
        'paperMatrix': [value for row in paper.matrix_world for value in row],
        'paperVertices': [list(vertex.co) for vertex in paper.data.vertices],
        'paperFaces': [list(face.vertices) for face in paper.data.polygons],
    }


def compare_reference(path):
    """Read the approved artifact without embedded scripts and compare geometry."""
    bpy.context.preferences.filepaths.use_scripts_auto_execute = False
    bpy.ops.wm.open_mainfile(filepath=str(path), load_ui=False, use_scripts=False)
    scene = bpy.context.scene
    ribbon = bpy.data.objects.get(RIBBON)
    if not ribbon or ribbon.type != 'MESH' or not scene.camera or PAPER not in bpy.data.objects:
        raise ValueError('Reference must contain the baked ribbon, camera and paper.')
    rows = []
    for frame in VERIFY_FRAMES:
        scene.frame_set(frame)
        expected, faces, _, _ = geometry(frame/(FRAME_COUNT-1))
        evaluated = ribbon.evaluated_get(bpy.context.evaluated_depsgraph_get())
        actual = evaluated.to_mesh()
        topology_matches = (
            len(actual.vertices) == len(expected)
            and len(actual.polygons) == len(faces)
            and all(tuple(face.vertices) == indices for face, indices in zip(actual.polygons, faces))
        )
        error = max((vertex.co-point).length for vertex, point in zip(actual.vertices, expected))
        evaluated.to_mesh_clear()
        rows.append({'frame': frame, 'topologyMatches': topology_matches,
                     'maximumVertexError': error})
    scene.frame_set(0)
    return {
        'referenceSha256': hashlib.sha256(path.read_bytes()).hexdigest(),
        'embeddedScriptsEnabled': False, 'embeddedTextCount': len(bpy.data.texts),
        'toleranceSceneUnits': .0001, 'frames': rows,
        'sceneContract': scene_contract(),
        'geometryPassed': all(row['topologyMatches'] and row['maximumVertexError'] <= .0001 for row in rows),
    }


def build_scene():
    """Bake the same geometry and scene registration; deliberately do not render."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = 'BLENDER_EEVEE_NEXT'
    scene.render.resolution_x, scene.render.resolution_y = CANVAS
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    scene.render.film_transparent = True
    scene.render.fps = FPS
    vertices, faces, _, _ = geometry(0)
    mesh = bpy.data.meshes.new(RIBBON)
    mesh.from_pydata(vertices, [], faces)
    ribbon = bpy.data.objects.new(RIBBON, mesh)
    scene.collection.objects.link(ribbon)
    palette = [(.87, .12, .10, 1), (.95, .58, .12, 1), (.20, .65, .28, 1), (.14, .49, .84, 1)]
    for index, color in enumerate(palette):
        material = bpy.data.materials.new(f'Material position {index}')
        material.use_nodes = True
        nodes = material.node_tree.nodes
        nodes.clear()
        shader = nodes.new('ShaderNodeEmission')
        shader.inputs[0].default_value = color
        output = nodes.new('ShaderNodeOutputMaterial')
        material.node_tree.links.new(shader.outputs[0], output.inputs[0])
        mesh.materials.append(material)
    for face in mesh.polygons:
        face.material_index = (min(face.vertices)//ACROSS//20) % 4
        face.use_smooth = True
    data = bpy.data.cameras.new(CAMERA)
    data.type, data.ortho_scale = 'ORTHO', 15
    camera = bpy.data.objects.new(CAMERA, data)
    scene.collection.objects.link(camera)
    camera.location = (0, -25, -.65)
    camera.rotation_euler = (math.pi/2, 0, 0)
    scene.camera = camera
    paper_mesh = bpy.data.meshes.new(PAPER)
    paper_mesh.from_pydata([(-7.2, 1.3, -10), (7.2, 1.3, -10), (7.2, 1.3, 10), (-7.2, 1.3, 10)], [], [(0, 1, 2, 3)])
    paper = bpy.data.objects.new(PAPER, paper_mesh)
    scene.collection.objects.link(paper)
    material = bpy.data.materials.new('Paper holdout')
    material.use_nodes = True
    nodes = material.node_tree.nodes
    nodes.clear()
    shader = nodes.new('ShaderNodeHoldout')
    output = nodes.new('ShaderNodeOutputMaterial')
    material.node_tree.links.new(shader.outputs[0], output.inputs[0])
    paper_mesh.materials.append(material)
    ribbon.shape_key_add(name='Basis')
    ribbon.data.shape_keys.use_relative = False
    rows = []
    for frame in range(FRAME_COUNT):
        vertices, _, _, row = geometry(frame/(FRAME_COUNT-1))
        key = ribbon.shape_key_add(name=f'Frame {frame:03d}')
        key.data.foreach_set('co', [value for point in vertices for value in point])
        key.interpolation = 'KEY_LINEAR'
        ribbon.data.shape_keys.eval_time = key.frame
        ribbon.data.shape_keys.keyframe_insert(data_path='eval_time', frame=frame)
        rows.append(row)
    for curve in ribbon.data.shape_keys.animation_data.action.fcurves:
        for point in curve.keyframe_points:
            point.interpolation = 'LINEAR'
    scene.frame_start, scene.frame_end = 0, FRAME_COUNT-1
    scene.frame_set(0)
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', required=True, help='New or empty output directory; never overwritten.')
    parser.add_argument('--compare-reference', type=Path, help='Optional approved baked .blend to compare before saving.')
    args = parser.parse_args()
    output = Path(args.out).resolve()
    if output.exists() and (not output.is_dir() or any(output.iterdir())):
        parser.error('Output must be a new or empty directory; existing files are never overwritten.')
    if bpy.app.version != (4, 5, 13):
        parser.error(f'Pinned authoring runtime is bpy 4.5.13; found {bpy.app.version_string}.')
    reference = args.compare_reference.resolve() if args.compare_reference else None
    if reference and not reference.is_file():
        parser.error('Reference blend does not exist.')
    output.mkdir(parents=True, exist_ok=True)
    comparison = compare_reference(reference) if reference else None
    if comparison and not comparison['geometryPassed']:
        (output/'reference-comparison.json').write_text(json.dumps(comparison, indent=2), encoding='utf-8')
        raise ValueError('Canonical geometry differs from the supplied reference; no blend saved.')
    rows = build_scene()
    contract = scene_contract()
    if comparison:
        comparison['sceneContractMatches'] = comparison['sceneContract'] == contract
        comparison['passed'] = comparison['geometryPassed'] and comparison['sceneContractMatches']
        (output/'reference-comparison.json').write_text(json.dumps(comparison, indent=2), encoding='utf-8')
        if not comparison['passed']:
            raise ValueError('Camera, paper or frame registration differs; no blend saved.')
    destination = output/'ribbon.blend'
    bpy.ops.wm.save_as_mainfile(filepath=str(destination))
    evidence = {
        'bpyVersion': bpy.app.version_string,
        'authorSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        'sourceDataSha256': hashlib.sha256(DATA_PATH.read_bytes()).hexdigest(),
        'blendSha256': hashlib.sha256(destination.read_bytes()).hexdigest(),
        'sourceProvenance': SOURCE_DATA['provenance'],
        'frameCount': FRAME_COUNT, 'vertices': (2*ARM_ROWS+BACK_ROWS-2)*ACROSS,
        'singleConnectedRibbonMesh': True, 'crossSectionArclength': WIDTH,
        'materialLength': sum(INITIAL)+BACK_DISTANCE[-1], 'sceneContract': contract,
        'frames': rows, 'referenceCompared': bool(comparison),
        'referenceComparisonPassed': comparison['passed'] if comparison else None,
        'renderedFrames': 0, 'visualAdmission': 'separate-studio-and-playback-review',
        'limitations': ['Authored material-path motion, not a contact-constrained cloth simulation.'],
    }
    (output/'authoring-evidence.json').write_text(json.dumps(evidence, indent=2), encoding='utf-8')
    shutil.copy2(Path(__file__), output/'author_ribbon.py')
    shutil.copy2(DATA_PATH, output/'source-knot.json')
    print(json.dumps({'bakedFrames': FRAME_COUNT, 'renderedFrames': 0,
                      'referenceComparisonPassed': evidence['referenceComparisonPassed'],
                      'blend': str(destination)}), flush=True)


if __name__ == '__main__':
    main()
