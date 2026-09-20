"""Measure longitudinal, transverse and shear-diagonal strain independently."""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw


def edge_groups(rows, across):
    return {
        'longitudinal':np.array([(i*across+j,(i+1)*across+j) for i in range(rows-1) for j in range(across)]),
        'transverse':np.array([(i*across+j,i*across+j+1) for i in range(rows) for j in range(across-1)]),
        'diagonal':np.array([(i*across+j,(i+1)*across+j+1) for i in range(rows-1) for j in range(across-1)]
                          +[(i*across+j+1,(i+1)*across+j) for i in range(rows-1) for j in range(across-1)])}


def main():
    p=argparse.ArgumentParser()
    p.add_argument('--source',type=Path,required=True)
    p.add_argument('--out',type=Path,required=True)
    p.add_argument('--across',type=int,default=9)
    p.add_argument('--frames',default='1,40,120')
    args=p.parse_args()
    args.out.mkdir(parents=True,exist_ok=True)
    d=np.load(args.source)
    frames=d['vertices']
    if frames.ndim==2:frames=frames[None,:,:]
    flat=d['flatRest']
    across=int(d['across']) if 'across' in d else args.across
    rows=len(flat)//across
    groups=edge_groups(rows,across)
    selected=[int(x) for x in args.frames.split(',') if int(x)<=len(frames)]
    report={'schemaVersion':1,'sourceSha256':hashlib.sha256(args.source.read_bytes()).hexdigest(),
            'meaning':'edgeLength / corresponding flat-rest edgeLength; not a solver setting claim',
            'frames':[]}
    colors=[(34,88,153),(221,108,37),(84,150,83)]
    image=Image.new('RGB',(1280,760),(248,247,241))
    draw=ImageDraw.Draw(image)
    for group_index,(name,edges) in enumerate(groups.items()):
        y0=40+group_index*240
        draw.text((15,y0),name,fill=(30,30,30))
        draw.line([(100,y0+30),(100,y0+205),(1260,y0+205)],fill=(100,100,100))
        draw.line([(100,y0+150),(1260,y0+150)],fill=(190,190,190))
        draw.text((40,y0+145),'ratio 1',fill=(100,100,100))
        reference=np.linalg.norm(flat[edges[:,1]]-flat[edges[:,0]],axis=1)
        for frame_index,frame in enumerate(selected):
            v=frames[frame-1]
            ratio=np.linalg.norm(v[edges[:,1]]-v[edges[:,0]],axis=1)/reference
            worst=np.argsort(np.abs(ratio-1))[-10:][::-1]
            metrics={'edgeCount':len(edges),'ratioMin':float(ratio.min()),'ratioMax':float(ratio.max()),
                     'quantiles':dict(zip(['p01','p05','p50','p95','p99'],map(float,np.quantile(ratio,[.01,.05,.5,.95,.99])))),
                     'overFivePercentCount':int((ratio>1.05).sum()),'underMinusFivePercentCount':int((ratio<.95).sum()),
                     'worst':[{'vertices':edges[k].tolist(),'rows':(edges[k]//across).tolist(),
                               'acrossIndices':(edges[k]%across).tolist(),'ratio':float(ratio[k]),
                               'positions':[v[j].tolist() for j in edges[k]]} for k in worst]}
            found=next((r for r in report['frames'] if r['simulationFrame']==frame),None)
            if found is None:
                found={'simulationFrame':frame,'groups':{}}
                report['frames'].append(found)
            found['groups'][name]=metrics
            row_max=np.ones(rows)
            for row in range(rows):
                values=ratio[edges[:,0]//across==row]
                if len(values):row_max[row]=values.max()
            points=[(100+i/(rows-1)*1160,y0+205-min(3.5,max(0,r))/3.5*190) for i,r in enumerate(row_max)]
            draw.line(points,fill=colors[frame_index%len(colors)],width=2)
            draw.text((150+frame_index*170,y0),f'frame {frame}',fill=colors[frame_index%len(colors)])
    image.save(args.out/'strain-by-material-row.png')
    (args.out/'strain-evidence.json').write_text(json.dumps(report,indent=2))
    print(json.dumps({r['simulationFrame']:{k:{'min':v['ratioMin'],'max':v['ratioMax'],'p95':v['quantiles']['p95'],'worstRows':v['worst'][0]['rows']}
        for k,v in r['groups'].items()} for r in report['frames']}),flush=True)


if __name__=='__main__':main()
