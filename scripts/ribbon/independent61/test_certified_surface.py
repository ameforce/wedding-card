import io
import json
from pathlib import Path
import tempfile
import unittest
import numpy as np
from certified_surface import load_certified_surface, sha256


class CertifiedSurfaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.surface = self.root / 'surface'
        (self.surface / 'path-parts').mkdir(parents=True)
        source = b'physical-source'
        (self.root / 'continuous-path.npz').write_bytes(source)
        part = io.BytesIO()
        np.savez(part, times=np.array([0., 1.]), vertices=np.array([[[0., 0., 0.], [1., 0., 0.], [0., 1., 0.]], [[0., 0., 1.], [1., 0., 1.], [0., 1., 1.]]]), faces=np.array([[0, 1, 2]]))
        self.part = self.surface / 'path-parts/part-0000.npz'
        self.part.write_bytes(part.getvalue())
        self.complete = {'sourceSha256': sha256(source), 'sourceSteps': 2, 'insertedContinuityPoints': 0,
                         'parts': [{'file': self.part.name, 'sha256': sha256(part.getvalue()), 'count': 2, 'start': 0., 'end': 1.}]}
        self.write_complete()
        self.verification = {'completeRecordSha256': sha256((self.surface / 'complete.json').read_bytes()),
                             'checkedSamples': 2, 'checkedContinuousSegments': 1, 'violations': []}
        self.write_verification()

    def write_complete(self):
        (self.surface / 'complete.json').write_text(json.dumps(self.complete))

    def write_verification(self):
        (self.surface / 'independent-verification.json').write_text(json.dumps(self.verification))

    def test_valid_source_is_frozen_before_later_path_mutation(self):
        t, vertices, faces, lineage = load_certified_surface(self.surface)
        self.part.write_bytes(b'changed after loading')
        self.assertEqual(t.tolist(), [0., 1.])
        self.assertEqual(vertices[1, 0].tolist(), [0., 0., 1.])
        self.assertEqual(faces.tolist(), [[0, 1, 2]])
        self.assertEqual(lineage['checkedContinuousSegments'], 1)

    def test_changed_part_rejected(self):
        self.part.write_bytes(b'changed before loading')
        with self.assertRaisesRegex(ValueError, 'part hash'):
            load_certified_surface(self.surface)

    def test_changed_complete_rejected(self):
        self.complete['sourceSteps'] = 3
        self.write_complete()
        with self.assertRaisesRegex(ValueError, 'verification'):
            load_certified_surface(self.surface)

    def test_failed_verification_rejected(self):
        self.verification['violations'] = [{'sample': 1}]
        self.write_verification()
        with self.assertRaisesRegex(ValueError, 'verification'):
            load_certified_surface(self.surface)

    def test_incomplete_verification_rejected(self):
        self.verification['checkedContinuousSegments'] = 0
        self.write_verification()
        with self.assertRaisesRegex(ValueError, 'sample count'):
            load_certified_surface(self.surface)

    def test_changed_physical_source_rejected(self):
        (self.root / 'continuous-path.npz').write_bytes(b'other simulation')
        with self.assertRaisesRegex(ValueError, 'Physical source hash'):
            load_certified_surface(self.surface)


if __name__ == '__main__':
    unittest.main()
