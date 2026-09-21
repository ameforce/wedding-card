"""LEGACY REJECTED width probe; never use its filtered counts for admission.

Its historical material-row exemption misses local fold intersections. Current
admission uses cloth_study.py, cloth_verify.py and cloth_clearance.py instead.
No time-dependent geometry is authored here.
"""
import argparse
import importlib.util
import json
from pathlib import Path

import bpy
from mathutils.bvhtree import BVHTree


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, required=True)
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location('legacy_initial', args.source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    for width in [.05, .2, .45, .85]:
        module.WIDTH = width
        verts, faces, centers, _ = module.geometry(0)
        tree = BVHTree.FromPolygons(verts, faces)
        pairs = [(a,b) for a,b in tree.overlap(tree) if a<b and abs(min(faces[a])//9-min(faces[b])//9)>8]
        sample = [{'rows':[min(faces[a])//9,min(faces[b])//9],
                   'centers':[list(centers[min(faces[a])//9]),list(centers[min(faces[b])//9])]}
                  for a,b in pairs[::max(1,len(pairs)//5)][:5]]
        print(json.dumps({'legacyRejectedDiagnostic':True,'admissionAllowed':False,
                          'width':width,'intersectionPairs':len(pairs),'samples':sample}), flush=True)


if __name__ == '__main__':
    main()
