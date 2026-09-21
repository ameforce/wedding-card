"""Measure gatefold edges from user-supplied reference, never publish its pixels.

Input is an extracted 540x675, 30 fps paper-001..054 PNG sequence beginning
at reference time 2.2s. Output stores reproducible normalized edge observations.
"""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image


def measure(directory):
    width, height = 540, 675
    previous = [267, 272]
    observations = []
    for number in range(7, 50):
        path = directory / f"paper-{number:03d}.png"
        image = np.asarray(Image.open(path).convert("RGB"), dtype=float)
        if image.shape != (height, width, 3):
            raise ValueError(f"Unexpected reference dimensions: {path}")
        # Median over most of the image rejects texture, figures and flower edges
        # that are not continuous vertically. Track each boundary monotonically.
        strength = np.median(np.linalg.norm(np.diff(image[35:640], axis=1), axis=2), axis=0)
        positions = []
        confidences = []
        for side, old in enumerate(previous):
            if old in (0, width):
                positions.append(old)
                confidences.append(None)
                continue
            # The supplied recording contains repeated frames followed by jumps.
            # A 50px search window includes those recording-cadence jumps.
            start, end = (max(0, old - 50), min(270, old + 3)) if side == 0 else (max(270, old - 3), min(width - 1, old + 51))
            index = int(np.argmax(strength[start:end])) + start
            confidence = float(strength[index])
            if confidence < 25:
                # A boundary is admitted offscreen only near its destination edge.
                if (side == 0 and old > 28) or (side == 1 and old < width - 29):
                    raise ValueError(f"Lost edge away from viewport: frame={number}, side={side}, x={old}")
                index = 0 if side == 0 else width
            index = min(old, index) if side == 0 else max(old, index)
            positions.append(index)
            confidences.append(round(confidence, 3))
        previous = positions
        observations.append({"sourceFrame": 66 + number - 1, "timeSeconds": round(2.2 + (number - 1) / 30, 6),
                             "leftX": positions[0], "rightX": positions[1], "edgeStrength": confidences,
                             "imageSha256": hashlib.sha256(path.read_bytes()).hexdigest()})
    initial_left, initial_right = observations[0]["leftX"], observations[0]["rightX"]
    curve = []
    for i, row in enumerate(observations):
        left = min(1., (initial_left - row["leftX"]) / initial_left)
        right = min(1., (row["rightX"] - initial_right) / (width - initial_right))
        curve.append({"offset": round(i / 42, 8), "progress": round((left + right) / 2, 8),
                      "leftProgress": round(left, 8), "rightProgress": round(right, 8)})
    if curve[0]["progress"] != 0 or curve[-1]["progress"] != 1:
        raise ValueError("Reference must cover both closed and fully open boundaries")
    # Fit the observed motion rather than reproducing duplicated source frames.
    # p(u)=a*u^2+(1-a)*u^3 starts with zero speed and is monotonic for 0<=a<=3.
    # The end is outside the viewport, so its remaining velocity is not visible.
    fits = {}
    times = np.arange(len(curve)) / 30
    for side in ("leftProgress", "rightProgress"):
        observed = np.array([row[side] for row in curve])
        best = None
        for duration in np.linspace(1., 1.25, 251):
            u = np.clip(times / duration, 0, 1)
            basis = u*u-u*u*u
            coefficient = float(np.dot(basis, observed-u**3) / np.dot(basis, basis))
            if not 0 <= coefficient <= 3:
                continue
            fitted = np.clip(coefficient*u*u+(1-coefficient)*u**3, 0, 1)
            error = float(np.mean((fitted-observed)**2))
            if best is None or error < best[0]:
                best = (error, duration, coefficient, fitted)
        error, duration, coefficient, fitted = best
        fits[side] = {"durationSeconds": round(float(duration), 6), "quadraticWeight": round(coefficient, 10),
                      "rmsErrorMeasurementPx": round(error**.5*width/2, 4),
                      "maxErrorMeasurementPx": round(float(np.max(np.abs(fitted-observed)))*width/2, 4)}
    smooth_curve = []
    for i, row in enumerate(curve):
        values = {}
        for side, fit in fits.items():
            u = min(1., (i / 30) / fit["durationSeconds"])
            a = fit["quadraticWeight"]
            values[side] = round(a*u*u+(1-a)*u**3, 8)
        smooth_curve.append({"offset": row["offset"], "progress": round(sum(values.values())/2, 8), **values})
    return {"schemaVersion": 1, "kind": "reference-paper-measurement", "sourceSize": [1080, 1350],
            "measurementSize": [width, height], "sourceFps": 30, "startSeconds": 2.4, "endSeconds": 3.8,
            "panelDurationMs": 1400, "method": "median vertical RGB edge, bounded monotonic tracking; initial seam excluded",
            "observations": observations, "observedPanelCurve": curve, "fit": fits, "panelCurve": smooth_curve}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--frames", type=Path, required=True)
    parser.add_argument("--source-video", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if args.out.exists():
        raise SystemExit("Refusing to overwrite existing measurement evidence")
    result = measure(args.frames)
    result["sourceSha256"] = hashlib.sha256(args.source_video.read_bytes()).hexdigest()
    args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(args.out), "samples": len(result["panelCurve"]),
                      "sourceSha256": result["sourceSha256"],
                      "fullyOpenSeconds": next(r["timeSeconds"] for r in result["observations"] if r["leftX"] == 0 and r["rightX"] == 540)}))
