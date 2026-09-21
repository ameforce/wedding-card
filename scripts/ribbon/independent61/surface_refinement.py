"""Fixed-topology Loop refinement constrained against cloth and fixed paper."""
import numpy as np,scipy.sparse as sp,ipctk
from scipy.sparse.linalg import spsolve

class SurfaceRefinement:
    def __init__(self, faces, count):
        edge_faces={};near=[set() for _ in range(count)]
        for tri in faces:
            for i,j,k in ((tri[0],tri[1],tri[2]),(tri[1],tri[2],tri[0]),(tri[2],tri[0],tri[1])):
                edge_faces.setdefault(tuple(sorted((i,j))),[]).append(k);near[i].add(j);near[j].add(i)
        edges=np.array(list(edge_faces),dtype=np.int32);ids={tuple(e):i+count for i,e in enumerate(edges)};boundary={};total=count+len(edges)
        pr=list(range(count));pc=list(range(count));pv=[1.]*count;gr=[];gc=[];gv=[]
        for (i,j),op in edge_faces.items():
            row=ids[(i,j)];pr.extend([row,row]);pc.extend([i,j]);pv.extend([.5,.5])
            if len(op)==2:gr.extend([row]*4);gc.extend([i,j,*op]);gv.extend([.375,.375,.125,.125])
            else:
                gr.extend([row,row]);gc.extend([i,j]);gv.extend([.5,.5]);boundary.setdefault(i,[]).append(j);boundary.setdefault(j,[]).append(i)
        for i in range(count):
            if i in boundary:cols=[i,*boundary[i]];weights=[.75,.125,.125]
            else:
                neighbors=list(near[i]);beta=3/(8*len(neighbors)) if len(neighbors)>3 else 3/16;cols=[i,*neighbors];weights=[1-len(neighbors)*beta]+[beta]*len(neighbors)
            gr.extend([i]*len(cols));gc.extend(cols);gv.extend(weights)
        self.seed_map=sp.coo_matrix((pv,(pr,pc)),shape=(total,count)).tocsr();self.goal_map=sp.coo_matrix((gv,(gr,gc)),shape=(total,count)).tocsr()
        fine=[]
        for i,j,k in faces:
            ij=ids[tuple(sorted((i,j)))];jk=ids[tuple(sorted((j,k)))];ki=ids[tuple(sorted((k,i)))];fine.extend([(i,ij,ki),(j,jk,ij),(k,ki,jk),(ij,jk,ki)])
        self.faces=np.array(fine,dtype=np.int32);self.count=total;self.size=total*3
        self.paper=np.array([[i,j,k] for i in (-5.95,5.95) for j in (2.2,2.76) for k in (-22.,22.)])
        pf=np.array([(0,1,3),(0,3,2),(4,6,7),(4,7,5),(0,4,5),(0,5,1),(2,3,7),(2,7,6),(0,2,6),(0,6,4),(1,5,7),(1,7,3)],dtype=np.int32)
        self.all_faces=np.vstack([self.faces,pf+total]);af=self.all_faces
        self.edges=np.unique(np.sort(np.vstack([af[:,[0,1]],af[:,[1,2]],af[:,[2,0]]]),axis=1),axis=0).astype(np.int32)
        self.barrier=ipctk.BarrierPotential(.003,1e8);self.identity=sp.eye(self.size,format='csc');self.mesh=None
    def full(self,vertices):return np.vstack([vertices,self.paper])
    def refine(self,coarse):
        seed=self.seed_map@coarse;target=self.goal_map@coarse;x=seed.copy()
        if self.mesh is None:self.mesh=ipctk.CollisionMesh(self.full(seed),self.edges,self.all_faces)
        if ipctk.has_intersections(self.mesh,self.full(seed)):raise ValueError('Exact source subdivision intersects')
        def objective(y,derivatives=False):
            c=ipctk.NormalCollisions();c.build(self.mesh,self.full(y),.003);delta=y-target;value=.5*np.sum(delta*delta)+self.barrier(c,self.mesh,self.full(y))
            if not derivatives:return value
            return value,delta.ravel()+self.barrier.gradient(c,self.mesh,self.full(y))[:self.size],self.identity+self.barrier.hessian(c,self.mesh,self.full(y),ipctk.PSDProjectionMethod.CLAMP)[:self.size,:self.size]
        for iteration in range(121):
            value,g,h=objective(x,True);residual=float(abs(g).max())
            if residual<1e-5:break
            direction=spsolve(h,-g).reshape(-1,3);alpha=min(1,ipctk.compute_collision_free_stepsize(self.mesh,self.full(x),self.full(x+direction)));slope=np.dot(g,direction.ravel());accepted=False
            for _ in range(30):
                candidate=x+alpha*direction
                if objective(candidate)<=value+1e-4*alpha*slope:accepted=True;break
                alpha*=.5
            if not accepted or alpha<1e-10:raise ValueError('Surface refinement stalled')
            x=candidate
        if ipctk.has_intersections(self.mesh,self.full(x)):raise ValueError('Refined surface intersects')
        return x,{'iterations':iteration+1,'residual':residual,'maxDisplacement':float(np.linalg.norm(x-seed,axis=1).max())}
    def ccd(self,previous,current):return float(ipctk.compute_collision_free_stepsize(self.mesh,self.full(previous),self.full(current)))
