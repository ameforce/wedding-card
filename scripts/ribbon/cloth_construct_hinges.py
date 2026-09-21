"""Bounded static fabrication of a rectangular ribbon by rigid triangle hinges.

This is an INITIAL GEOMETRY experiment, not a tying/untying animation. Every
triangle is congruent to its flat counterpart. Optimization steps have no CCD;
only the reported final static surface is tested for intersections.
"""
import argparse
import hashlib
import json
import time
from pathlib import Path

import numpy as np


def unit(v):
    return v / max(float(np.linalg.norm(v)), 1e-14)


def guide(pitch):
    # Newly authored loose spatial ports. These are soft fabrication targets,
    # not a swept surface, a uniformly enlarged source knot, or animation poses.
    # Material order: tail A, right bight, collar, paper bridge, left bight, tail B.
    ports = np.array([
        [-3.6,-1.6,-3.5],[-.2,-1.55,-.8],[2.,-1.7,.8],
        [4.25,-1.75,2.1],[4.7,-1.75,.55],[2.7,-1.8,-.15],
        [1.35,-1.1,.12],[-.65,-.8,-.9],[-1.,-2.5,.3],
        [.6,-2.2,.3],[1.8,-2.,.05],[6.6,-1.3,.05],
        [7.2,1.0,.05],[6.5,2.6,.05],[-6.5,2.6,.05],
        [-7.2,1.,.05],[-6.6,-.1,.05],[-1.4,-.1,.05],
        [-.75,1.,-.2],[1.1,.65,.8],[1.25,-1.3,-.7],
        [-1.1,-.65,-.1],[-2.65,-1.1,.8],[-4.45,-1.2,1.95],
        [-4.65,-1.3,.35],[-2.8,-1.4,-.55],[-.9,-1.6,-.75],
        [3.75,-2.,-3.5],
    ], dtype=float)
    points=[]; params=[]
    extended=np.vstack([2*ports[0]-ports[1],ports,2*ports[-1]-ports[-2]])
    for i in range(len(ports)-1):
        a,b,c,d=extended[i:i+4]
        for t in np.linspace(0,1,60,endpoint=False):
            points.append(.5*((2*b)+(-a+c)*t+(2*a-5*b+4*c-d)*t*t+(-a+3*b-3*c+d)*t**3))
            params.append(i+t)
    points.append(ports[-1]);params.append(len(ports)-1)
    points=np.asarray(points)
    arc=np.r_[0,np.linalg.norm(np.diff(points,axis=0),axis=1).cumsum()]
    # Exact fixed rest pitch is chosen once; never changed by the optimizer.
    samples=np.linspace(0,arc[-1],int(np.ceil(arc[-1]/pitch))+1)
    centers=np.stack([np.interp(samples,arc,points[:,k]) for k in range(3)],axis=1)
    material=np.interp(samples,arc,params)
    tangent=np.gradient(centers,axis=0)
    widths=np.cross(tangent,np.array([0.,-1.,0.]))
    widths/=np.linalg.norm(widths,axis=1)[:,None]
    # Keep the director sign continuous. Both faces of cloth are visible.
    for i in range(1,len(widths)):
        if np.dot(widths[i],widths[i-1])<0:widths[i]*=-1
    return centers,widths,samples,material,ports


class Hinges:
    def __init__(self,centers,widths,samples,width=.85):
        self.target=(centers[:,None,:]+np.array([-.5,.5])[None,:,None]*width*widths[:,None,:]).reshape(-1,3)
        self.rest=np.array([[s,t,0.] for s in samples for t in [-width/2,width/2]])
        self.root=np.zeros((3,3))
        self.root[:2]=self.target[:2]
        e=unit(self.root[1]-self.root[0])
        perpendicular=self.target[2]-self.root[0]
        perpendicular-=e*np.dot(e,perpendicular)
        self.root[2]=self.root[0]+(samples[1]-samples[0])*unit(perpendicular)
        self.constants=[]
        self.contacts=[]
        self.contact_owners=set()
        self.whole_faces=False
        self.bend_penalty=0.
        for k in range(3,len(self.rest)):
            a,b,c=self.rest[k-2:k+1]
            length=np.linalg.norm(b-a)
            d0=np.linalg.norm(c-a);d1=np.linalg.norm(c-b)
            x=(d0*d0+length*length-d1*d1)/(2*length)
            self.constants.append((x,np.sqrt(max(0,d0*d0-x*x))))

    def forward(self,angles,greedy=False):
        v=np.empty_like(self.rest);v[:3]=self.root
        axes=[];pivots=[]
        used=[]
        for j,(x,h) in enumerate(self.constants):
            k=j+3;p=v[k-2];e=unit(v[k-1]-p)
            old=v[k-3]-p;base=-unit(old-e*np.dot(e,old))
            cross=np.cross(e,base)
            theta=angles[j]
            if greedy:
                aim=self.target[k]-p-e*x
                theta=np.arctan2(np.dot(aim,cross),np.dot(aim,base))
            v[k]=p+e*x+h*(np.cos(theta)*base+np.sin(theta)*cross)
            axes.append(e);pivots.append(p.copy());used.append(theta)
        return v,np.asarray(axes),np.asarray(pivots),np.asarray(used)

    def objective(self,angles):
        v,axes,pivots,_=self.forward(angles)
        rows=v.reshape(-1,2,3);wanted=self.target.reshape(-1,2,3)
        center_error=rows.mean(axis=1)-wanted.mean(axis=1)
        width_error=(rows[:,1]-rows[:,0])-(wanted[:,1]-wanted[:,0])
        force=np.repeat(center_error[:,None,:]*.5,2,axis=1)
        force[:,0]-=.08*width_error;force[:,1]+=.08*width_error
        force=force.reshape(-1,3)
        value=.5*np.sum(center_error**2)+.04*np.sum(width_error**2)
        if self.contacts:
            ids_a=np.array([c[0] for c in self.contacts]);ids_b=np.array([c[1] for c in self.contacts])
            weights_a=np.array([c[2] for c in self.contacts]);weights_b=np.array([c[3] for c in self.contacts])
            normals=np.array([c[4] for c in self.contacts])
            a=np.sum(v[ids_a]*weights_a[:,:,None],axis=1)
            b=np.sum(v[ids_b]*weights_b[:,:,None],axis=1)
            violation=np.maximum(0,.025-np.sum((a-b)*normals,axis=1))
            value+=100*np.sum(violation**2)
            reaction=-200*violation[:,None]*normals
            np.add.at(force,ids_a.ravel(),(weights_a[:,:,None]*reaction[:,None,:]).reshape(-1,3))
            np.add.at(force,ids_b.ravel(),(-weights_b[:,:,None]*reaction[:,None,:]).reshape(-1,3))
        torque=np.cross(v,force)
        suffix_force=np.cumsum(force[::-1],axis=0)[::-1][3:]
        suffix_torque=np.cumsum(torque[::-1],axis=0)[::-1][3:]
        gradient=np.sum(axes*(suffix_torque-np.cross(pivots,suffix_force)),axis=1)
        # Periodic regularization avoids arbitrary 2pi coordinate dependence.
        value+=.00005*np.sum(1-np.cos(angles));gradient+=.00005*np.sin(angles)
        excess=np.maximum(0,np.abs(angles)-1.2)
        value+=self.bend_penalty*np.sum(excess**2)
        gradient+=2*self.bend_penalty*excess*np.sign(angles)
        return float(value),gradient,v


def optimize(model,angles,iterations,seconds,contact_update=False):
    start=time.monotonic();history=[];trace=[]
    value,gradient,v=model.objective(angles)
    for iteration in range(iterations):
        if time.monotonic()-start>seconds:break
        if contact_update and iteration%100==0:
            added=add_contacts(model,v)
            history=[];value,gradient,v=model.objective(angles)
            print(json.dumps({'contactIteration':iteration,'addedConstraints':added,'constraintCount':len(model.contacts)}),flush=True)
        q=gradient.copy();alpha=[]
        for s,y,rho in reversed(history):
            a=rho*np.dot(s,q);alpha.append(a);q-=a*y
        scale=(np.dot(history[-1][0],history[-1][1])/np.dot(history[-1][1],history[-1][1])) if history else 1e-4
        direction=q*scale
        for (s,y,rho),a in zip(history,reversed(alpha)):
            direction+=s*(a-rho*np.dot(y,direction))
        direction=-direction
        if np.dot(direction,gradient)>=0:direction=-gradient*1e-5
        slope=np.dot(gradient,direction);step=1.
        accepted=False
        for backtrack in range(20):
            proposal=angles+step*direction
            new_value,new_gradient,new_v=model.objective(proposal)
            if new_value<=value+1e-4*step*slope:
                accepted=True;break
            step*=.5
        if not accepted:break
        s=proposal-angles;y=new_gradient-gradient;sy=np.dot(s,y)
        if sy>1e-12:
            history.append((s,y,1/sy));history=history[-10:]
        angles,value,gradient,v=proposal,new_value,new_gradient,new_v
        if iteration%25==0:
            row={'iteration':iteration,'objective':value,'gradientNorm':float(np.linalg.norm(gradient)),'seconds':time.monotonic()-start}
            trace.append(row);print(json.dumps(row),flush=True)
    return angles,v,trace


def add_contacts(model,vertices):
    """Static contact repair constraints at exact intersecting material points.

    Direction is selected from the authored soft target and recorded as a design
    choice. This is not a continuous collision certificate or physical force.
    """
    from cloth_study import intersections
    fine,flat,faces,owners=subdivide(vertices,model.rest,4)
    pairs=intersections(fine,faces.tolist(),None)
    added=0
    for a,b in pairs:
        owner_a=int(owners[a]);owner_b=int(owners[b])
        owner_pair=(owner_a,owner_b)
        if model.whole_faces and owner_pair in model.contact_owners:continue
        ids_a=np.array([owner_a,owner_a+1,owner_a+2])
        ids_b=np.array([owner_b,owner_b+1,owner_b+2])
        tri_a=fine[faces[a]];tri_b=fine[faces[b]]
        hits=[]
        for first,second in [(tri_a,tri_b),(tri_b,tri_a)]:
            normal=np.cross(second[1]-second[0],second[2]-second[0])
            for k in range(3):
                p=first[k];delta=first[(k+1)%3]-p
                denominator=np.dot(normal,delta)
                if abs(denominator)<1e-12:continue
                t=np.dot(normal,second[0]-p)/denominator
                if not 0<=t<=1:continue
                hit=p+t*delta
                uv=np.linalg.lstsq((second[1:]-second[0]).T,hit-second[0],rcond=None)[0]
                if min(uv)>=-1e-7 and sum(uv)<=1+1e-7:hits.append(hit)
        if not hits:continue
        hit=np.mean(hits,axis=0)
        weights=[]
        for ids in [ids_a,ids_b]:
            tri=vertices[ids];uv=np.linalg.lstsq((tri[1:]-tri[0]).T,hit-tri[0],rcond=None)[0]
            weights.append(np.r_[1-sum(uv),uv])
        wanted_a=weights[0]@model.target[ids_a];wanted_b=weights[1]@model.target[ids_b]
        wanted_tri=model.target[ids_b]
        normal=unit(np.cross(wanted_tri[1]-wanted_tri[0],wanted_tri[2]-wanted_tri[0]))
        sign=np.dot(normal,wanted_a-wanted_b)
        if abs(sign)<1e-7:
            normal=unit(wanted_a-wanted_b)
        elif sign<0:normal=-normal
        if np.linalg.norm(normal)<.9:continue
        if model.whole_faces:
            # Convex triangles are separated by this plane when every cross
            # vertex projection is ordered. Shared material vertices may touch.
            # Unlike point repair, this cannot merely move the intersection
            # along the same pair of triangles while satisfying the constraint.
            for i in range(3):
                for j in range(3):
                    if ids_a[i]==ids_b[j]:continue
                    model.contacts.append((ids_a,ids_b,np.eye(3)[i],np.eye(3)[j],normal));added+=1
            model.contact_owners.add(owner_pair)
        else:
            model.contacts.append((ids_a,ids_b,weights[0],weights[1],normal));added+=1
    # Keep evidence-bounded work; never silently claim a truncated set is safe.
    if not model.whole_faces and len(model.contacts)>3000:model.contacts=model.contacts[-3000:]
    if model.whole_faces and len(model.contacts)>6000:raise RuntimeError('Static contact constraint budget exceeded; redesign required')
    return added


def subdivide(vertices,rest,subdivisions):
    out=[];flat=[];faces=[];owners=[];lookup={}
    def add(face,i,j):
        weights=np.array([1-(i+j)/subdivisions,i/subdivisions,j/subdivisions])
        uv=weights@rest[face]
        key=tuple(np.round(uv,10))
        if key not in lookup:
            lookup[key]=len(out);out.append(weights@vertices[face]);flat.append(uv)
        return lookup[key]
    for k in range(len(vertices)-2):
        tri=[k,k+1,k+2] if k%2==0 else [k+1,k,k+2]
        for i in range(subdivisions):
            for j in range(subdivisions-i):
                faces.append([add(tri,i,j),add(tri,i+1,j),add(tri,i,j+1)]);owners.append(k)
                if i+j<subdivisions-1:
                    faces.append([add(tri,i+1,j),add(tri,i+1,j+1),add(tri,i,j+1)]);owners.append(k)
    return np.asarray(out),np.asarray(flat),np.asarray(faces),np.asarray(owners)


def crossing_ledger(centers,samples):
    result=[]
    for i in range(len(centers)-1):
        p=centers[i];u=centers[i+1]-p
        for j in range(i+2,len(centers)-1):
            q=centers[j];v=centers[j+1]-q
            mat=np.array([[u[0],-v[0]],[u[2],-v[2]]])
            determinant=np.linalg.det(mat)
            if abs(determinant)<1e-10:continue
            t,r=np.linalg.solve(mat,(q-p)[[0,2]])
            if 0<=t<1 and 0<=r<1:
                a=p+t*u;b=q+r*v
                result.append({'firstS':float(samples[i]+t*(samples[i+1]-samples[i])),
                               'secondS':float(samples[j]+r*(samples[j+1]-samples[j])),
                               'deltaY':float(a[1]-b[1]),'firstOver':bool(a[1]<b[1]),
                               'projectedTangentSign':int(np.sign(u[0]*v[2]-u[2]*v[0]))})
    return result


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out',type=Path,required=True)
    parser.add_argument('--iterations',type=int,default=500)
    parser.add_argument('--seconds',type=float,default=150)
    parser.add_argument('--pitch',type=float,default=.425)
    parser.add_argument('--repair-from',type=Path,help='Same approach bounded contact-constraint adjustment')
    parser.add_argument('--whole-faces',action='store_true',help='Last bounded adjustment: separating-plane constraints on complete coarse triangles')
    args=parser.parse_args()
    if args.pitch<=0 or args.seconds<=0 or args.iterations<1:parser.error('Positive pitch, time and iteration limits are required')
    if args.out.exists() and any(args.out.iterdir()):parser.error('Use a new empty output directory')
    args.out.mkdir(parents=True,exist_ok=True)
    source_bytes=Path(__file__).read_bytes()
    (args.out/'construction-source.py').write_bytes(source_bytes)
    centers,widths,samples,params,ports=guide(args.pitch)
    model=Hinges(centers,widths,samples)
    model.whole_faces=args.whole_faces
    zeros=np.zeros(len(model.constants))
    flat_fold=model.forward(zeros)[0]
    _,_,_,angles=model.forward(zeros,greedy=True)
    if args.repair_from:
        previous=np.load(args.repair_from)
        if len(previous['angles'])!=len(angles):raise ValueError('Rest grid changed')
        angles=previous['angles'].copy();model.bend_penalty=.03
    # Independent finite-difference checks of the revolute-chain derivative.
    value,grad,_=model.objective(angles)
    checks=[]
    for index in np.linspace(0,len(angles)-1,7,dtype=int):
        plus=angles.copy();minus=angles.copy();plus[index]+=1e-6;minus[index]-=1e-6
        numeric=(model.objective(plus)[0]-model.objective(minus)[0])/2e-6
        checks.append({'index':int(index),'analytic':float(grad[index]),'numeric':numeric,'error':abs(grad[index]-numeric)})
    assert max(x['error'] for x in checks)<.01,'Hinge gradient regression failed'
    angles,v,trace=optimize(model,angles,args.iterations,args.seconds,bool(args.repair_from))
    vertices,rest,faces,owners=subdivide(v,model.rest,4)
    edges=np.unique(np.sort(np.concatenate([faces[:,[0,1]],faces[:,[1,2]],faces[:,[2,0]]]),axis=1),axis=0)
    ratios=np.linalg.norm(vertices[edges[:,0]]-vertices[edges[:,1]],axis=1)/np.linalg.norm(rest[edges[:,0]]-rest[edges[:,1]],axis=1)
    assert np.max(np.abs(ratios-1))<1e-8,'Rigid triangle metric regression failed'
    # Equal-rest-distance identity catches a wrong sign in the zero-angle chain.
    assert np.max(np.abs(np.linalg.norm(flat_fold-flat_fold[0],axis=1)-np.linalg.norm(model.rest-model.rest[0],axis=1)))<1e-8
    np.savez_compressed(args.out/'candidate.npz',vertices=vertices,flatRest=rest,faces=faces,
                        materialCoordinates=rest[:,:2],coarseVertices=v,coarseFlatRest=model.rest,
                        triangleOwner=owners,angles=angles,guideCenters=centers,guidePorts=ports,
                        materialGuideParameters=params,restWidth=np.array(.85))
    import bpy
    from mathutils import Vector
    from cloth_study import intersections,render_setup
    from PIL import Image,ImageDraw
    pairs=intersections(vertices,faces.tolist(),None)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene=bpy.context.scene
    mesh=bpy.data.meshes.new('Exact flat-metric hinged strip')
    mesh.from_pydata(vertices.tolist(),[],faces.tolist());mesh.update()
    ribbon=bpy.data.objects.new('Static hinged fabrication candidate',mesh);scene.collection.objects.link(ribbon)
    ribbon.shape_key_add(name='Basis');key=ribbon.shape_key_add(name='Flat material rest')
    key.data.foreach_set('co',rest.ravel());key.value=0
    render_setup(scene,ribbon,2)
    for polygon in mesh.polygons:
        s=float(rest[list(polygon.vertices),0].mean());stripe=int(s/.85)
        polygon.material_index=0 if s/.85-stripe>.18 else 1+stripe%3
    scene.frame_set(1);bpy.context.view_layer.update()
    evaluated=ribbon.evaluated_get(bpy.context.evaluated_depsgraph_get())
    eval_mesh=evaluated.to_mesh();actual=np.array([v.co[:] for v in eval_mesh.vertices]);evaluated.to_mesh_clear()
    f1_max=float(np.linalg.norm(actual-vertices,axis=1).max())
    f1_pairs=intersections(actual,faces.tolist(),None)
    bpy.ops.wm.save_as_mainfile(filepath=str(args.out/'hinged-initial.blend'))
    entries=[]
    for view in ['front','side']:
        if view=='side':
            scene.camera.location=(25,-8,3)
            scene.camera.rotation_euler=(Vector((0,1,0))-scene.camera.location).to_track_quat('-Z','Y').to_euler()
        scene.render.filepath=str(args.out/f'{view}-001.png');bpy.ops.render.render(write_still=True)
        entries.append(args.out/f'{view}-001.png')
    sheet=Image.new('RGB',(960,680),(239,237,231));draw=ImageDraw.Draw(sheet)
    for i,path in enumerate(entries):
        im=Image.open(path).convert('RGBA');tile=Image.new('RGBA',im.size,(239,237,231,255));tile.alpha_composite(im)
        sheet.paste(tile.convert('RGB').resize((480,320)),(i*480,0));draw.text((i*480+10,328),path.stem,fill=(20,20,20))
    draw.text((10,360),f'STATIC FABRICATION ONLY / width .85 / intersections {len(f1_pairs)} / metric error {max(abs(ratios-1)):.2g}',fill=(20,20,20))
    sheet=sheet.crop((0,0,960,400));sheet.save(args.out/'front-side-contact-sheet.jpg',quality=94)
    exact_fiber=[];exact_s=[]
    for row in range(len(v)//2):
        exact_fiber.append(v[2*row:2*row+2].mean(axis=0));exact_s.append(samples[row])
        if row<len(v)//2-1:
            exact_fiber.append(v[2*row+1:2*row+3].mean(axis=0));exact_s.append((samples[row]+samples[row+1])/2)
    evidence={'schemaVersion':1,'construction':'rigid triangle hinge chain with barycentric subdivision',
              'sourceSha256':hashlib.sha256(source_bytes).hexdigest(),
              'restWidth':.85,'restLength':float(samples[-1]),'coarseTriangles':len(v)-2,'vertices':len(vertices),'faces':len(faces),
              'triangleEdgeRatioMin':float(ratios.min()),'triangleEdgeRatioMax':float(ratios.max()),
              'rawIntersections':len(pairs),'evaluatedF1Intersections':len(f1_pairs),'intersectionFaces':f1_pairs,
              'evaluatedF1MaxDisplacement':f1_max,'finite':bool(np.isfinite(actual).all()),
              'bounds':[vertices.min(axis=0).tolist(),vertices.max(axis=0).tolist()],
              'gradientChecks':checks,'optimization':trace,'crossingLedger':crossing_ledger(np.asarray(exact_fiber),np.asarray(exact_s)),
              'crossingLedgerFiber':'Exact material t=0, including every coarse triangle diagonal midpoint',
              'staticContactConstraints':len(model.contacts),'staticExcessBendPenalty':model.bend_penalty,
              'wholeTriangleSeparationConstraints':model.whole_faces,
              'constructionPathCCD':False,'topologyEquivalenceProved':False,'physicsRun':False,
              'visualAdmission':False,'releaseCompleteFrame':None,'cameraCanvas':[960,640],'registration':[480,320],
              'formatNote':'Triangle mesh; materialCoordinates=(flat longitudinal s, transverse t). Not a regular across-grid. Use an explicit adapter.'}
    (args.out/'construction-evidence.json').write_text(json.dumps(evidence,indent=2))
    print(json.dumps({k:evidence[k] for k in ['triangleEdgeRatioMin','triangleEdgeRatioMax','rawIntersections','evaluatedF1Intersections','evaluatedF1MaxDisplacement']}),flush=True)


if __name__=='__main__':main()
