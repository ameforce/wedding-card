import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('packager', Path(__file__).resolve().parents[1] / 'scripts/ribbon/package_sequence.py')
packager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packager)


class RenderLineageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.png = self.root / 'frame-000.png'
        self.png.write_bytes(b'fixture PNG bytes')
        self.root_bytes = b'{"rootYPx":[0]}'
        self.record = {'frameCount': 1, 'frames': [{'frame': 0, 'sha256': hashlib.sha256(self.png.read_bytes()).hexdigest()}],
                       'rootTrackSha256': hashlib.sha256(self.root_bytes).hexdigest(),
                       'certifiedSurface': {'parts': [{'file': 'part-0000.npz'}], 'surfaceVerificationSha256': 'fixture'},
                       'sceneSha256': 'fixture', 'rendererSha256': 'fixture', 'width': 480, 'height': 1920,
                       'fps': 30, 'registration': {'x': 240, 'y': 960}, 'releaseCompleteFrame': 61}
        self.manifest = self.root / 'render-manifest.json'
        self.save()

    def save(self):
        self.manifest.write_text(json.dumps(self.record))

    def test_conversion_uses_frozen_verified_bytes(self):
        frames, binding = packager.load_render_inputs(self.root, 1, self.root_bytes, self.manifest)
        self.png.write_bytes(b'replaced')
        self.assertEqual(frames, [b'fixture PNG bytes'])
        self.assertEqual(binding['sha256'], hashlib.sha256(self.manifest.read_bytes()).hexdigest())

    def test_changed_png_rejected(self):
        self.png.write_bytes(b'replaced')
        with self.assertRaisesRegex(ValueError, 'PNG hash'):
            packager.load_render_inputs(self.root, 1, self.root_bytes, self.manifest)

    def test_changed_root_track_rejected(self):
        with self.assertRaisesRegex(ValueError, 'root track hash'):
            packager.load_render_inputs(self.root, 1, b'changed', self.manifest)

    def test_missing_terminal_record_rejected(self):
        self.record['frames'] = []
        self.save()
        with self.assertRaisesRegex(ValueError, 'frame count'):
            packager.load_render_inputs(self.root, 1, self.root_bytes, self.manifest)

    def test_absent_surface_lineage_rejected(self):
        self.record.pop('certifiedSurface')
        self.save()
        with self.assertRaisesRegex(ValueError, 'surface lineage'):
            packager.load_render_inputs(self.root, 1, self.root_bytes, self.manifest)


if __name__ == '__main__':
    unittest.main()
