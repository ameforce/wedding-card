"""Magnify exact intersecting material patches for diagnostic inspection only."""
import argparse
import json
from pathlib import Path
import bpy
import numpy as np
from mathutils import Vector
from PIL import Image,ImageDraw
from cloth_study import intersections,material


def main():
    p=argparse.ArgumentParser();p.add_argument('--study',type=Path,required=True);p.add_argument('--out',type=Path,required=True);p.add_argument('--frame',type=int,default=90)
    args=p.parse_args();args.out.mkdir(parents=True,exist_ok=True)
    data=np.load(args.study/'simulated-vertices.npz');v=data['vertices'][args.frame-1];faces=data['faces'];across=9
    pairs=intersections(v,faces.tolist(),across);rows=sorted(set(int(min(faces[i])//across) for pair in pairs for i in pair))
    evidence=[]
    for a,b in pairs:
        evidence.append({'faces':[a,b],'materialRows':[int(min(faces[a])//across),int(min(faces[b])//across)],
            'columns':[int(min(faces[a])%across),int(min(faces[b])%across)],
            'sharedVertices':list(set(faces[a]).intersection(faces[b])),
            'verticesA':v[faces[a]].tolist(),'verticesB':v[faces[b]].tolist()})
    bpy.ops.wm.open_mainfile(filepath=str(args.study/'cloth-source.blend'),load_ui=False,use_scripts=False)
    scene=bpy.context.scene
    for ob in scene.objects:
        if ob.type not in ['LIGHT','CAMERA']:ob.hide_render=True
    sheet=Image.new('RGB',(640*2,450*max(1,len(rows))),(239,237,231));draw=ImageDraw.Draw(sheet)
    for n,row in enumerate(rows):
        selected=[i for i,f in enumerate(faces) if abs(min(f)//across-row)<=2]
        indices=sorted(set(int(j) for i in selected for j in faces[i]));lookup={old:new for new,old in enumerate(indices)}
        mesh=bpy.data.meshes.new(f'Material row {row} exact patch');mesh.from_pydata(v[indices].tolist(),[],[[lookup[int(j)] for j in faces[i]] for i in selected])
        ob=bpy.data.objects.new(f'Material row {row} exact patch',mesh);scene.collection.objects.link(ob)
        for name,color in [('Context',(.62,.62,.60)),('Intersecting face A',(.9,.03,.03)),('Intersecting face B',(.03,.15,.9))]:mesh.materials.append(material(name,color))
        for local,i in enumerate(selected):
            mesh.polygons[local].material_index=1 if any(i==a for a,b in pairs) else (2 if any(i==b for a,b in pairs) else 0)
        target=Vector(v[row*across:(row+1)*across].mean(axis=0));scene.camera.data.ortho_scale=1.65
        for light in [item for item in scene.objects if item.type=='LIGHT']:
            light.location=target+Vector((-2,-4,4))
            light.rotation_euler=(target-light.location).to_track_quat('-Z','Y').to_euler()
        for k,direction in enumerate([Vector((0,-1,.2)),Vector((1,-.4,.3))]):
            scene.camera.location=target+direction.normalized()*8
            scene.camera.rotation_euler=(target-scene.camera.location).to_track_quat('-Z','Y').to_euler()
            path=args.out/f'row-{row}-view-{k}.png';scene.render.filepath=str(path);bpy.ops.render.render(write_still=True)
            src=Image.open(path).convert('RGBA');bg=Image.new('RGBA',src.size,(239,237,231,255));bg.alpha_composite(src)
            sheet.paste(bg.convert('RGB').resize((640,427)),(640*k,450*n));draw.text((640*k+8,450*n+430),f'F{args.frame}; material row {row}; exact faces red/blue',(20,20,20))
        ob.hide_render=True
    sheet.save(args.out/'contact-patches.jpg',quality=95)
    (args.out/'contact-patches.json').write_text(json.dumps({'frame':args.frame,'pairs':evidence,
        'inspectionOnly':True,'cameraPolicy':'Static diagnostic magnification; never a product motion frame or crop-normalization source.'},indent=2))


if __name__=='__main__':main()
