"""Load exactly the independently checked bytes once, before Blender renders."""
import hashlib
import io
import json
import re
from pathlib import Path
import numpy as np


def sha256(blob):
    return hashlib.sha256(blob).hexdigest()


def load_certified_surface(directory):
    directory = Path(directory).resolve()
    complete_bytes = (directory / 'complete.json').read_bytes()
    verification_bytes = (directory / 'independent-verification.json').read_bytes()
    complete = json.loads(complete_bytes)
    verification = json.loads(verification_bytes)
    complete_hash = sha256(complete_bytes)
    if verification.get('completeRecordSha256') != complete_hash or verification.get('violations') != []:
        raise ValueError('Surface verification does not certify this complete record')
    if sha256((directory.parent / 'continuous-path.npz').read_bytes()) != complete['sourceSha256']:
        raise ValueError('Physical source hash differs from the certified surface')
    times, vertices, faces, records = [], [], None, []
    for index, part in enumerate(complete['parts']):
        name = part['file']
        if not re.fullmatch(r'part-\d{4}\.npz', name) or name != f'part-{index:04d}.npz':
            raise ValueError('Invalid certified part name or order')
        blob = (directory / 'path-parts' / name).read_bytes()
        if sha256(blob) != part['sha256']:
            raise ValueError('Certified path part hash differs')
        # Decode these exact checked bytes, never reopen a mutable path later.
        with np.load(io.BytesIO(blob), allow_pickle=False) as data:
            v, t, f = data['vertices'], data['times'], data['faces']
        if len(v) != part['count'] or len(t) != len(v) or not len(t):
            raise ValueError('Certified part count differs')
        if not np.isfinite(v).all() or not np.isfinite(t).all() or not np.all(np.diff(t) > 0):
            raise ValueError('Invalid certified positions or times')
        if times and t[0] <= times[-1][-1]:
            raise ValueError('Certified part time is not monotonic')
        if float(t[0]) != part['start'] or float(t[-1]) != part['end']:
            raise ValueError('Certified part time bounds differ')
        if faces is None:
            faces = f.copy()
        elif not np.array_equal(faces, f):
            raise ValueError('Certified topology changes between parts')
        times.append(t); vertices.append(v)
        records.append({'file': name, 'sha256': sha256(blob), 'count': len(t)})
    if not times:
        raise ValueError('Certified surface is empty')
    times, vertices = np.concatenate(times), np.concatenate(vertices)
    if verification.get('checkedSamples') != len(times) or verification.get('checkedContinuousSegments') != len(times) - 1:
        raise ValueError('Surface verification sample count differs')
    if len(times) != complete['sourceSteps'] + complete['insertedContinuityPoints']:
        raise ValueError('Complete record sample count differs')
    lineage = {'completeRecordSha256': complete_hash, 'surfaceVerificationSha256': sha256(verification_bytes),
               'physicalSourceSha256': complete['sourceSha256'], 'checkedSamples': len(times),
               'checkedContinuousSegments': len(times) - 1, 'parts': records}
    return times, vertices, faces, lineage
