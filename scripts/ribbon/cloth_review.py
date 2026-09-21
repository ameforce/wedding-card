"""Render immutable physical snapshots from fixed front and side cameras."""
import argparse
import hashlib
import json
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector
from PIL import Image, ImageDraw
from cloth_study import material


def main():
    p=argparse.ArgumentParser()
    p.add_argument('--study',type=Path,required=True)
    p.add_argument('--out',type=Path,required=True)
    p.add_argument('--frames',help='Exact one-based simulated frames for read-back')
    p.add_argument('--strain',action='store_true')
    p.add_argument('--highlight-faces',help='Comma-separated exact diagnostic face indices')
    args=p.parse_args()
    if args.out.exists() and any(args.out.iterdir()):
        p.error('Output must be new or empty')
    args.out.mkdir(parents=True,exist_ok=True)
    source=args.study/'simulated-vertices.npz'
    data=np.load(source)
    frames=data['vertices']
    bpy.context.preferences.filepaths.use_scripts_auto_execute=False
    bpy.ops.wm.open_mainfile(filepath=str(args.study/'cloth-source.blend'),load_ui=False,use_scripts=False)
    scene=bpy.context.scene
    ribbon=bpy.data.objects['One locally sliding bow strip']
    ribbon.modifiers.clear()
    ribbon.shape_key_clear()
    if args.highlight_faces:
        highlighted=set(int(x) for x in args.highlight_faces.split(','))
        mat_index=len(ribbon.data.materials)
        ribbon.data.materials.append(material('Measured sub-thickness fold faces',(1.,.01,.01)))
        for face in ribbon.data.polygons:
            if face.index in highlighted:face.material_index=mat_index
    scene.frame_set(1)
    selected=sorted(set([int(x)-1 for x in args.frames.split(',')])) if args.frames else sorted(set([0,len(frames)//3,2*len(frames)//3,len(frames)-1]))
    if any(index<0 or index>=len(frames) for index in selected):
        p.error('Requested snapshot is outside the recorded simulation')
    if args.strain:
        offset=len(ribbon.data.materials)
        for name,color in [('Within 5 percent',(.65,.65,.61)),('Stretched 5 to 20 percent',(1.,.45,.08)),
                           ('Stretched over 20 percent',(.86,.025,.025)),('Compressed over 5 percent',(.05,.25,.85))]:
            ribbon.data.materials.append(material(name,color))
    ribbon.data.vertices.foreach_set('co',frames[0].ravel())
    ribbon.shape_key_add(name='Basis')
    ribbon.data.shape_keys.use_relative=False
    # Store exact simulated samples. No pose fitting, normalization or root extraction.
    for index in range(0,len(frames),max(1,len(frames)//60)):
        key=ribbon.shape_key_add(name=f'Simulated frame {index+1:03d}')
        key.data.foreach_set('co',frames[index].ravel())
        key.interpolation='KEY_LINEAR'
        ribbon.data.shape_keys.eval_time=key.frame
        ribbon.data.shape_keys.keyframe_insert(data_path='eval_time',frame=index+1)
    for curve in ribbon.data.shape_keys.animation_data.action.fcurves:
        for key in curve.keyframe_points:key.interpolation='LINEAR'
    bpy.ops.wm.save_as_mainfile(filepath=str(args.out/'cloth-snapshot-review.blend'))
    ribbon.shape_key_clear()
    paper=bpy.data.objects['Actual card back occlusion']
    camera=scene.camera
    frontMatrix=camera.matrix_world.copy()
    sideLoc=Vector((25,-8,3))
    sideTarget=Vector((0,1,0))
    entries=[]
    for view in ['front','side']:
        if view=='side':
            camera.location=sideLoc
            camera.rotation_euler=(sideTarget-sideLoc).to_track_quat('-Z','Y').to_euler()
            camera.data.ortho_scale=16
            # Show the entire ribbon in the side diagnostic; paper bounds are recorded.
            paper.hide_render=True
        for index in selected:
            ribbon.data.vertices.foreach_set('co',frames[index].ravel())
            ribbon.data.update()
            if args.strain:
                v=frames[index]
                flat=data['flatRest']
                for face in ribbon.data.polygons:
                    ids=list(face.vertices)
                    pairs=list(zip(ids,ids[1:]+ids[:1]))+[(ids[0],ids[2]),(ids[1],ids[3])]
                    ratios=[np.linalg.norm(v[a]-v[b])/np.linalg.norm(flat[a]-flat[b]) for a,b in pairs]
                    face.material_index=offset+(2 if max(ratios)>1.2 else 1 if max(ratios)>1.05 else 3 if min(ratios)<.95 else 0)
            path=args.out/f'{view}-{index+1:03d}.png'
            scene.render.filepath=str(path)
            bpy.ops.render.render(write_still=True)
            entries.append({'view':view,'simulationFrame':index+1,'path':path.name,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()})
    columns=len(selected)
    sheet=Image.new('RGB',(columns*320,2*248),(239,237,231))
    draw=ImageDraw.Draw(sheet)
    for i,row in enumerate(entries):
        im=Image.open(args.out/row['path']).convert('RGBA')
        tile=Image.new('RGBA',im.size,(239,237,231,255))
        tile.alpha_composite(im)
        tile=tile.convert('RGB').resize((320,214),Image.Resampling.LANCZOS)
        x=(i%columns)*320;y=(i//columns)*248
        sheet.paste(tile,(x,y))
        draw.text((x+10,y+218),f"{row['view']} / simulation frame {row['simulationFrame']}",fill=(30,30,30))
    sheet.save(args.out/'front-side-contact-sheet.jpg',quality=94)
    report={'schemaVersion':1,'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),
            'visualAdmission':False,'releaseCompleteFrame':None,
            'frontCameraMatrix':[x for row in frontMatrix for x in row],
            'sideCameraPosition':list(sideLoc),'sideCameraTarget':list(sideTarget),
            'sidePaperHiddenForInspection':True,'dimensions':[960,640],'frames':entries}
    report['strainColors']=('red >20% stretch; orange >5% stretch; blue >5% compression; gray otherwise' if args.strain else None)
    (args.out/'review-evidence.json').write_text(json.dumps(report,indent=2))
    print(str(args.out/'front-side-contact-sheet.jpg'),flush=True)


if __name__=='__main__':main()
