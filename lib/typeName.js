import GLib from 'gi://GLib';

// GObject type names are global to the shell process. Deriving them from where
// the code was loaded lets a copy from another folder be loaded next to the
// old one (see `make dev-reload`) without a name clash.
const SUFFIX = GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, import.meta.url, -1).slice(0, 8);

export function typeName(name) {
    return `BetterClipboard${name}_${SUFFIX}`;
}
