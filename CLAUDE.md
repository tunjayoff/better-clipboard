# Better Clipboard

## Rule: check every update with shexli first

Run `make lint` and `make zip` after every change, before you commit, push,
reload the extension with `make dev-reload`, or hand over a zip for upload.
`make zip` runs shexli, the checker extensions.gnome.org runs on uploads, and
fails on any finding not listed in `tools/shexli.py`.

- Fix new findings in the code. Don't add them to `ALLOWED` to get past the check.
- Only add a finding to `ALLOWED` if it is a confirmed false positive, with
  the reason, and tell the user.
- If the check can't run (no network, shexli crashes), say so and don't
  report the change as checked.
