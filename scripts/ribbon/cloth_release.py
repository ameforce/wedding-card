"""Locate the first sustained frame where the ribbon no longer constrains the paper."""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--simulation', type=Path, required=True)
    parser.add_argument('--evidence', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--consecutive', type=int, default=6)
    parser.add_argument('--paper-half-width', type=float, default=7.)
    parser.add_argument('--paper-half-height', type=float, default=4.5)
    parser.add_argument('--paper-front-y', type=float, default=1.6)
    args = parser.parse_args()
    if args.consecutive < 1:
        parser.error('consecutive must be positive')

    simulation = np.load(args.simulation)
    frames = simulation['vertices']
    evidence = json.loads(args.evidence.read_text())
    evidence_frames = evidence['frames']
    if len(frames) != len(evidence_frames):
        parser.error('Simulation and evidence frame counts differ')

    rows = []
    qualifying = []
    for index, vertices in enumerate(frames):
        footprint = ((np.abs(vertices[:, 0]) < args.paper_half_width) &
                     (np.abs(vertices[:, 2]) < args.paper_half_height))
        constraining = footprint & (vertices[:, 1] >= args.paper_front_y)
        paper_intersections = int(evidence_frames[index]['paperFaceIntersections'])
        row = {
            'simulationFrame': index + 1,
            'paperFootprintVertices': int(footprint.sum()),
            'constrainingVertices': int(constraining.sum()),
            'paperFaceIntersections': paper_intersections,
            'maximumFootprintY': float(vertices[footprint, 1].max()) if footprint.any() else None,
        }
        rows.append(row)
        qualifying.append(row['constrainingVertices'] == 0 and paper_intersections == 0)

    candidate = None
    for index in range(len(rows) - args.consecutive + 1):
        if all(qualifying[index:index + args.consecutive]):
            candidate = rows[index]['simulationFrame']
            break

    report = {
        'schemaVersion': 1,
        'simulationSha256': hashlib.sha256(args.simulation.read_bytes()).hexdigest(),
        'evidenceSha256': hashlib.sha256(args.evidence.read_bytes()).hexdigest(),
        'paper': {
            'halfWidth': args.paper_half_width,
            'halfHeight': args.paper_half_height,
            'frontY': args.paper_front_y,
        },
        'criterion': (
            f'{args.consecutive} consecutive frames with no ribbon vertex at or behind the paper front '
            'inside its X/Z footprint and no paper-face intersection'
        ),
        'releaseCandidateFrame': candidate,
        'releaseCompleteFrame': None,
        'visualAdmission': False,
        'frames': rows,
    }
    args.out.write_text(json.dumps(report, indent=2))
    print(json.dumps({
        'releaseCandidateFrame': candidate,
        'tail': rows[max(0, (candidate or len(rows)) - 4):min(len(rows), (candidate or len(rows)) + 8)],
    }), flush=True)


if __name__ == '__main__':
    main()
