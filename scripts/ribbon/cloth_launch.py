"""Launch the pinned bpy process hidden, preserving independent raw streams."""
import argparse
import hashlib
import json
import subprocess
import time
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--python', type=Path, required=True)
    parser.add_argument('--logs', type=Path, required=True)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    args.logs.mkdir(parents=True, exist_ok=True)
    rest = args.command[1:] if args.command[:1] == ['--'] else args.command
    command = [str(args.python), '-u', *rest]
    startup = subprocess.STARTUPINFO()
    startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    startup.wShowWindow = subprocess.SW_HIDE
    started = time.monotonic()
    with (args.logs/'stdout.bin').open('wb') as stdout, (args.logs/'stderr.bin').open('wb') as stderr:
        process = subprocess.Popen(command, stdout=stdout, stderr=stderr,
                                   startupinfo=startup, creationflags=subprocess.CREATE_NO_WINDOW)
        code = process.wait()
    evidence = {'command': command, 'expandedCommandLength': len(subprocess.list2cmdline(command)),
                'stdoutEncoding': 'raw-bytes', 'stderrEncoding': 'raw-bytes', 'pid': process.pid,
                'exitCode': code, 'seconds': time.monotonic()-started}
    for name in ['stdout', 'stderr']:
        evidence[name+'Sha256'] = hashlib.sha256((args.logs/(name+'.bin')).read_bytes()).hexdigest()
    (args.logs/'process.json').write_text(json.dumps(evidence, indent=2))
    print(json.dumps(evidence), flush=True)
    raise SystemExit(code)


if __name__ == '__main__':
    main()
