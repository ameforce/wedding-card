"""Read the original CC0 Beziers directly; preserve the core by a rigid map.

This is a static centerline diagnostic, not a ribbon animation or a broad-cloth
admission. The paper bridge joins A[8] to B[0] outside the protected knot core.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import bpy
import numpy as np
from mathutils import Vector
from cloth_study import render_setup, material


def sample(points,steps,scale):
    rows=[];parameters=[]
    for i in range(len(points)-1):
        controls=np.array([points[i]['co'],points[i]['right'],points[i+1]['left'],points[i+1]['co']])
        for k in range(steps):
            t=k/steps;u=1-t
            p=controls[0]*u**3+3*controls[1]*u*u*t+3*controls[2]*u*t*t+controls[3]*t**3
            rows.append([p[0]*scale,-p[2]*scale,p[1]*scale]);parameters.append(i+t)
    p=points[-1]['co'];rows.append([p[0]*scale,-p[2]*scale,p[1]*scale]);parameters.append(len(points)-1.)
    return np.array(rows),np.array(parameters)


def main():
    p=argparse.ArgumentParser();p.add_argument('--source',type=Path,required=True);p.add_argument('--out',type=Path,required=True)
    p.add_argument('--steps',type=int,default=64);p.add_argument('--scale',type=float,default=1.)
    args=p.parse_args()
    if args.out.exists() and any(args.out.iterdir()):p.error('Output must be new or empty')
    args.out.mkdir(parents=True,exist_ok=True)
    source=json.loads(args.source.read_text(encoding='utf-8'))
    a,pa=sample(source['splines'][0]['bezierPoints'],args.steps,args.scale)
    b,pb=sample(source['splines'][1]['bezierPoints'],args.steps,args.scale)
    # A polygonal bridge is diagnostic geometry only. All new edges lie outside
    # the protected |x|<2 core, or behind the paper. Core Beziers are untouched.
    waypoints=[a[-1],np.array([7.7,a[-1,1],a[-1,2]]),np.array([7.7,2.65,.0276]),
               np.array([-7.7,2.65,.0276]),np.array([-7.7,b[0,1],b[0,2]]),b[0]]
    bridge=[]
    for start,end in zip(waypoints,waypoints[1:]):
        for t in np.linspace(0,1,max(2,math.ceil(np.linalg.norm(end-start)/.06)),endpoint=False):bridge.append(start*(1-t)+end*t)
    bridge=np.array(bridge+[b[0]])
    centers=np.concatenate([a,bridge[1:-1],b])
    np.savez_compressed(args.out/'source-centerline.npz',centers=centers,sourceA=a,sourceB=b,parametersA=pa,parametersB=pb,bridge=bridge)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene=bpy.context.scene
    mesh=bpy.data.meshes.new('Centerline diagnostic registration mesh');mesh.from_pydata([],[],[])
    dummy=bpy.data.objects.new('Diagnostic studio setup',mesh);scene.collection.objects.link(dummy)
    render_setup(scene,dummy,9)
    colors=[(.12,.35,.75),(.72,.72,.68),(.8,.22,.09)]
    for name,points,color in [('Original A',a,colors[0]),('External paper bridge',bridge,colors[1]),('Original B',b,colors[2])]:
        data=bpy.data.curves.new(name,'CURVE');data.dimensions='3D';data.resolution_u=1;data.bevel_depth=.027;data.bevel_resolution=2
        spline=data.splines.new('POLY');spline.points.add(len(points)-1)
        for target,point in zip(spline.points,points):target.co=(*point,1)
        ob=bpy.data.objects.new(name,data);scene.collection.objects.link(ob);data.materials.append(material(name,color))
    bpy.ops.mesh.primitive_cube_add(size=1,location=(0,1.95,0));paper=bpy.context.object
    paper.name='Paper spatial reference';paper.dimensions=(14,.675,9);paper.hide_render=True
    bpy.ops.wm.save_as_mainfile(filepath=str(args.out/'source-centerline.blend'))
    front=scene.camera.matrix_world.copy()
    for view in ['front','side']:
        if view=='side':
            scene.camera.location=(25,-8,3)
            scene.camera.rotation_euler=(Vector((0,1,0))-scene.camera.location).to_track_quat('-Z','Y').to_euler()
        scene.render.filepath=str(args.out/f'{view}-centerline.png');bpy.ops.render.render(write_still=True)
    report={'sourceSha256':hashlib.sha256(args.source.read_bytes()).hexdigest(),'scriptSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            'sourceProvenance':source['provenance'],'map':'uniform scale * (x,-z,y), determinant +1; no handles or core points changed',
            'uniformScale':args.scale,'connection':'free A[0] -> A[8] -> paper bridge -> B[0] -> free B[8]',
            'coreSamplesA':len(a),'coreSamplesB':len(b),'bridgeSamples':len(bridge),'ribbonWidthAuthored':False,
            'visualAdmission':False,'physicsRun':False,'sourceArmsUnmodified':True,'paperHiddenForDiagnostic':True}
    (args.out/'source-baseline-evidence.json').write_text(json.dumps(report,indent=2))
    print(json.dumps(report))


if __name__=='__main__':main()
