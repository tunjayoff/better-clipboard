import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

const FILE_VERSION = 1;
const SAVE_DELAY_MS = 800;
const SESSION_MARKER = 'better-clipboard-session';

function loadContents(file) {
    return new Promise((resolve, reject) => {
        file.load_contents_async(null, (f, res) => {
            try {
                const [, contents] = f.load_contents_finish(res);
                resolve(contents);
            } catch (e) {
                reject(e);
            }
        });
    });
}

function replaceContents(file, bytes) {
    return new Promise((resolve, reject) => {
        file.replace_contents_bytes_async(bytes, null, false,
            Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null, (f, res) => {
                try {
                    f.replace_contents_finish(res);
                    resolve();
                } catch (e) {
                    reject(e);
                }
            });
    });
}

/**
 * Holds the clipboard history, newest first. Sensitive items live in memory
 * only and expire on their own; everything else is saved as JSON next to the
 * cached images.
 *
 * Emits 'changed' whenever the list or an item changes.
 */
export class History extends EventEmitter {
    constructor(settings, dataDir) {
        super();
        this._settings = settings;
        this._dir = Gio.File.new_for_path(dataDir);
        this._file = this._dir.get_child('history.json');
        this._imageDir = this._dir.get_child('images');
        this._items = [];
        this._saveId = 0;
        this._expiryIds = new Map();
        this._loaded = false;

        GLib.mkdir_with_parents(this._imageDir.get_path(), 0o700);

        this._settings.connectObject('changed::history-size', () => this._trim(), this);
    }

    get items() {
        return this._items;
    }

    get imageDir() {
        return this._imageDir;
    }

    async load() {
        let stored = [];
        try {
            const contents = await loadContents(this._file);
            const data = JSON.parse(new TextDecoder().decode(contents));
            if (data?.version === FILE_VERSION && Array.isArray(data.items))
                stored = data.items;
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                console.warn(`[better-clipboard] Could not read history: ${e.message}`);
        }

        if (this._settings.get_boolean('clear-on-logout') && this._isNewSession())
            stored = stored.filter(it => it.pinned);
        this._markSession();

        // Items copied while loading are already in the list; keep them on top.
        const known = new Set(this._items.map(it => it.hash));
        this._items.push(...stored.filter(it => !known.has(it.hash)));
        this._loaded = true;
        this._trim();
        this.emit('changed');
    }

    findByHash(hash) {
        return this._items.find(it => it.hash === hash) ?? null;
    }

    /**
     * Adds a new entry or, when the same content is already known, moves the
     * existing one to the top and refreshes where it came from.
     */
    add(entry) {
        const existing = this.findByHash(entry.hash);
        if (existing) {
            existing.time = entry.time;
            existing.source = entry.source;
            this._moveToTop(existing);
            this._changed(existing.sensitive);
            return existing;
        }

        const item = {
            id: GLib.uuid_string_random(),
            pinned: false,
            sensitive: false,
            ...entry,
        };
        this._items.unshift(item);

        if (item.sensitive)
            this._scheduleExpiry(item);

        this._trim();
        this._changed(item.sensitive);
        return item;
    }

    update(id, fields) {
        const item = this._get(id);
        if (!item)
            return;
        Object.assign(item, fields);
        this._changed(item.sensitive);
    }

    touch(id) {
        const item = this._get(id);
        if (!item)
            return;
        item.time = Date.now();
        this._moveToTop(item);
        this._changed(item.sensitive);
    }

    togglePin(id) {
        const item = this._get(id);
        if (!item || item.sensitive)
            return;
        item.pinned = !item.pinned;
        this._trim();
        this._changed();
    }

    remove(id) {
        const index = this._items.findIndex(it => it.id === id);
        if (index < 0)
            return;
        const [item] = this._items.splice(index, 1);
        this._forget(item);
        this._changed(item.sensitive);
    }

    clear({keepPinned = true} = {}) {
        const removed = this._items.filter(it => !keepPinned || !it.pinned);
        this._items = keepPinned ? this._items.filter(it => it.pinned) : [];
        removed.forEach(it => this._forget(it));
        this._changed();
    }

    /** Writes pending changes right away; used on disable. */
    flush() {
        if (!this._saveId)
            return;
        GLib.source_remove(this._saveId);
        this._saveId = 0;
        try {
            this._file.replace_contents(this._serialize(), null, false,
                Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {
            console.warn(`[better-clipboard] Could not save history: ${e.message}`);
        }
    }

    destroy() {
        this.flush();
        for (const id of this._expiryIds.values())
            GLib.source_remove(id);
        this._expiryIds.clear();
        this._settings.disconnectObject(this);
    }

    _get(id) {
        return this._items.find(it => it.id === id) ?? null;
    }

    _moveToTop(item) {
        const index = this._items.indexOf(item);
        if (index > 0) {
            this._items.splice(index, 1);
            this._items.unshift(item);
        }
    }

    _trim() {
        const limit = this._settings.get_int('history-size');
        let unpinned = 0;
        const keep = [];
        for (const item of this._items) {
            if (item.pinned || item.sensitive || ++unpinned <= limit)
                keep.push(item);
            else
                this._forget(item);
        }
        if (keep.length !== this._items.length) {
            this._items = keep;
            this._changed();
        }
    }

    _forget(item) {
        const expiry = this._expiryIds.get(item.id);
        if (expiry) {
            GLib.source_remove(expiry);
            this._expiryIds.delete(item.id);
        }
        if (item.image?.path) {
            const file = Gio.File.new_for_path(item.image.path);
            file.delete_async(GLib.PRIORITY_LOW, null, (f, res) => {
                try {
                    f.delete_finish(res);
                } catch {
                    // Already gone.
                }
            });
        }
    }

    _scheduleExpiry(item) {
        const seconds = this._settings.get_int('sensitive-timeout');
        item.expiresAt = Date.now() + seconds * 1000;
        const id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._expiryIds.delete(item.id);
            this.remove(item.id);
            return GLib.SOURCE_REMOVE;
        });
        this._expiryIds.set(item.id, id);
    }

    _changed(memoryOnly = false) {
        if (!memoryOnly)
            this._scheduleSave();
        this.emit('changed');
    }

    _scheduleSave() {
        if (!this._loaded || this._saveId)
            return;
        this._saveId = GLib.timeout_add(GLib.PRIORITY_LOW, SAVE_DELAY_MS, () => {
            this._saveId = 0;
            replaceContents(this._file, new GLib.Bytes(this._serialize())).catch(e =>
                console.warn(`[better-clipboard] Could not save history: ${e.message}`));
            return GLib.SOURCE_REMOVE;
        });
    }

    _serialize() {
        const items = this._items
            .filter(it => !it.sensitive)
            .map(({expiresAt: _e, ...rest}) => rest);
        return new TextEncoder().encode(JSON.stringify({version: FILE_VERSION, items}));
    }

    // The runtime dir is wiped when the user's last session ends, so a missing
    // marker means this is a fresh login rather than an unlock or a re-enable.
    _sessionMarker() {
        return Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_runtime_dir(), SESSION_MARKER]));
    }

    _isNewSession() {
        return !this._sessionMarker().query_exists(null);
    }

    _markSession() {
        try {
            this._sessionMarker().replace_contents('1', null, false, Gio.FileCreateFlags.NONE, null);
        } catch {
            // Not fatal: worst case history is cleared again next time.
        }
    }
}
