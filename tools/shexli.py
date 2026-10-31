"""Runs shexli, the extensions.gnome.org review checker, on a packed zip.

Fails on any finding not listed in ALLOWED, so a new issue is caught before
upload rather than by the reviewers.
"""

import json
import subprocess
import sys
from pathlib import Path

# Findings that are expected, with the reason. Keep this list short.
ALLOWED = {
    'EGO-A-005': 'reading the clipboard is the point of the extension; '
                 'metadata.json declares it',
    'EGO-M-004': 'shexli 0.2.1 counts every shell-version above 50 as a '
                 'future release; drop this once a newer shexli knows 51',
}


def main():
    zip_path = sys.argv[1]
    shexli = Path(sys.executable).with_name('shexli')
    out = subprocess.run([shexli, '--format', 'json', zip_path],
                         capture_output=True, text=True)
    if out.returncode != 0:
        sys.stderr.write(out.stderr)
        sys.exit(f'shexli failed with exit code {out.returncode}')

    unexpected = 0
    for f in json.loads(out.stdout)['findings']:
        where = ', '.join(
            f"{e['path'].split(':', 1)[-1]}{':' + str(e['line']) if e.get('line') else ''}"
            for e in f['evidence'])
        if f['rule_id'] in ALLOWED:
            print(f"shexli: ok   {f['rule_id']} ({ALLOWED[f['rule_id']]})")
        else:
            unexpected += 1
            print(f"shexli: FAIL {f['rule_id']} {f['severity']}: {f['message']}\n"
                  f"        at {where}\n        see {f['source_url']}")

    if unexpected:
        sys.exit(f'shexli: {unexpected} new finding(s); fix them before uploading')
    print('shexli: no new findings')


if __name__ == '__main__':
    main()
