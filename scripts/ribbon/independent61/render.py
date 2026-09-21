"""Render uniform samples of the certified fine trajectory with one fixed camera.

The physical trajectory is sampled at 2.5x time, then shown at 30fps. Root
translation is extracted only once the entire ribbon has cleared the paper.
"""
from pathlib import Path
import sys,json,time,hashlib
import bpy,numpy as np
from certified_surface import load_certified_surface
sys.stdout.reconfigure(encoding='utf-8')
import argparse
HERE=Path(__file__).resolve().parent
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--surface',required=True);p.add_argument('--out',required=True);args=p.parse_args()
surface=Path(args.surface).resolve();OUT=Path(args.out).resolve();OUT.mkdir(parents=True,exist_ok=False);frames_dir=OUT/'frames';frames_dir.mkdir();(OUT/'source.py').write_bytes(Path(__file__).read_bytes())
path_times,path_vertices,checked_faces,lineage=load_certified_surface(surface)
scene_bytes=(HERE/'render-scene.blend').read_bytes();scene_hash=hashlib.sha256(scene_bytes).hexdigest()
scene_path=OUT/'render-scene.blend';scene_path.write_bytes(scene_bytes)
bpy.ops.wm.open_mainfile(filepath=str(scene_path),load_ui=False,use_scripts=False)
scene=bpy.context.scene;ob=bpy.data.objects['Independent ivory ribbon'];mesh=ob.data
if len(mesh.vertices)!=path_vertices.shape[1] or not np.array_equal(np.array([tuple(p.vertices) for p in mesh.polygons]),checked_faces):raise ValueError('Scene mesh differs from certified topology')
root=[];records=[];release=None;release_top=None;last_shift=0.;started=time.monotonic()
def sample(t):
    if t<path_times[0] or t>path_times[-1]:raise ValueError('Render sample outside certified path')
    hi=int(np.searchsorted(path_times,t))
    if hi>=len(path_times):hi=len(path_times)-1
    if abs(path_times[hi]-t)<1e-8:return path_vertices[hi].copy()
    lo=hi-1;u=(t-path_times[lo])/(path_times[hi]-path_times[lo])
    return path_vertices[lo]*(1-u)+path_vertices[hi]*u
for frame in range(72):
    t=frame/12;v=sample(t);top=float(v[:,2].max())
    if release is None and top<-22.003:release=frame;release_top=top
    shift=0.
    if release is not None and frame>release:
        shift=max(last_shift,release_top-top,0);v[:,2]+=shift
    last_shift=shift;root.append(shift*480/14)
    mesh.vertices.foreach_set('co',v.ravel());mesh.update();scene.render.filepath=str(frames_dir/f'frame-{frame:03d}.png');bpy.ops.render.render(write_still=True)
    p=Path(scene.render.filepath);row={'frame':frame,'simulationSeconds':t,'unshiftedMaxZ':top,'rootYPx':root[-1],'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'seconds':time.monotonic()-started};records.append(row);print(json.dumps(row),flush=True)
    (OUT/'progress.json').write_text(json.dumps({'frames':records,'releaseCompleteFrame':release,'admitted':False},indent=2))
if release is None:raise RuntimeError('The full ribbon never cleared the fixed paper')
ob.hide_render=True;scene.render.filepath=str(frames_dir/'frame-072.png');bpy.ops.render.render(write_still=True);root.append(root[-1])
records.append({'frame':72,'terminal':True,'rootYPx':root[-1],'sha256':hashlib.sha256(Path(scene.render.filepath).read_bytes()).hexdigest()})
(OUT/'root-track.json').write_text(json.dumps({'rootYPx':root,'releaseCompleteFrame':release,'sourceTimeScale':2.5,'pixelsPerUnit':480/14,'rootExtraction':'maximum vertical coordinate after complete paper clearance'},indent=2))
if hashlib.sha256(scene_path.read_bytes()).hexdigest()!=scene_hash:raise ValueError('Frozen render scene changed during rendering')
result={'frames':records,'frameCount':73,'fps':30,'sourceTimeScale':2.5,'width':480,'height':1920,'registration':{'x':240,'y':960},'releaseCompleteFrame':release,'sceneSha256':scene_hash,'certifiedSurface':lineage,'rootTrackSha256':hashlib.sha256((OUT/'root-track.json').read_bytes()).hexdigest(),'rendererSha256':hashlib.sha256((OUT/'source.py').read_bytes()).hexdigest(),'seconds':time.monotonic()-started,'admitted':False}
(OUT/'render-manifest.json').write_text(json.dumps(result,indent=2));print(json.dumps({k:v for k,v in result.items() if k!='frames'}),flush=True)
