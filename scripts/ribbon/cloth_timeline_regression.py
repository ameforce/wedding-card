"""Regression for short diagnostic evaluation overwriting the F1 pull key."""
import argparse
import json
import unittest
from pathlib import Path
from types import SimpleNamespace
import numpy as np
from cloth_study import validate_timeline,validate_pull_path


def settings(**overrides):
    defaults=dict(frames=180,settle=12,initial_only=False,fall_after=None,settle_after=0,
                  single_tail=False,release_opposite_frame=13,release_pull_frame=None,evaluate_through=None)
    return SimpleNamespace(**(defaults|overrides))


class TimelineRegression(unittest.TestCase):
    def test_initial_only_preserves_authored_end(self):
        self.assertEqual(validate_timeline(settings(frames=1,initial_only=True)),(180,1))
    def test_normal_short_motion_rejected(self):
        for frames in [1,12]:
            with self.subTest(frames=frames),self.assertRaises(ValueError):validate_timeline(settings(frames=frames))
    def test_preroll_evaluation_does_not_move_pull_key(self):
        self.assertEqual(validate_timeline(settings(settle=120,evaluate_through=90)),(180,90))
    def test_colliding_fall_key_rejected(self):
        with self.assertRaises(ValueError):validate_timeline(settings(fall_after=1))
    def test_explicit_path_cannot_force_initial_pull(self):
        with self.assertRaises(ValueError):validate_pull_path([{'frame':1,'offset':[-14,-1.2,2]}])
        with self.assertRaises(ValueError):validate_pull_path([{'frame':1,'offset':[0,0,0]},{'frame':1,'offset':[-14,0,0]}])
        validate_pull_path([{'frame':1,'offset':[0,0,0]},{'frame':180,'offset':[-14,-1.2,2]}])


def main():
    p=argparse.ArgumentParser();p.add_argument('--raw',type=Path,required=True);p.add_argument('--old',type=Path,required=True);p.add_argument('--out',type=Path,required=True)
    p.add_argument('--corrected',type=Path)
    args=p.parse_args();raw=np.load(args.raw);old=np.load(args.old);a=int(raw['across']);v=raw['vertices'];f1=old['vertices'][0]
    tip={}
    for side,sl,expected in [('left',slice(None,2*a),[-14,-1.2,2]),('right',slice(-2*a,None),[14,-1.2,2])]:
        delta=f1[sl]-v[sl]
        tip[side]={'meanDelta':delta.mean(axis=0).tolist(),'maxExpectedError':float(np.abs(delta-np.array(expected)).max())}
    result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(TimelineRegression))
    corrected=None
    if args.corrected:
        corrected=json.loads((args.corrected/'simulation-evidence.json').read_text())
        f=corrected['frames'][0]
        assert corrected['authoredFrameEnd']>corrected['settings']['settle']
        assert corrected['evaluationFrameEnd']==1 and not corrected['freshCacheBaked']
        assert corrected['beforeCloth']['sceneFrame']==1 and not corrected['beforeCloth']['clothAlreadyPresent']
        for hook in corrected['beforeCloth']['hooks'].values():
            assert hook['location']==[0.,0.,0.]
            assert np.array_equal(hook['matrixWorld'],np.eye(4))
            assert all(curve['keys'][0]==[1.,0.] for curve in hook['curves'])
        assert f['inputDisplacementMax']<5e-6 and f['inputDisplacementRms']<1e-6
        assert np.max(np.abs(f['initialLeftTipDelta']))<5e-6 and np.max(np.abs(f['initialRightTipDelta']))<5e-6
        assert f['nonAdjacentFaceIntersections']==0 and f['effectivePinnedVertices']==4*a
        corrected={'assertionsPassed':True,'inputDisplacementMax':f['inputDisplacementMax'],'inputDisplacementRms':f['inputDisplacementRms']}
    args.out.parent.mkdir(parents=True,exist_ok=True)
    args.out.write_text(json.dumps({'historicalF1TipDelta':tip,'regressionTests':result.testsRun,'passed':result.wasSuccessful(),'correctedActualF1':corrected,
        'invalidatedClaim':'Historical source-final-initial self28 is not evidence of unforced F1 Rest/Cloth failure.'},indent=2))
    print(json.dumps(tip));raise SystemExit(0 if result.wasSuccessful() else 1)


if __name__=='__main__':main()
