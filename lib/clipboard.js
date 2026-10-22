import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {classifyText} from './classify.js';

const CLIPBOARD = St.ClipboardType.CLIPBOARD;

const FILES_MIME = 'x-special/gnome-copied-files';
const URI_LIST_MIME = 'text/uri-list';
const SECRET_HINT_MIME = 'x-kde-passwordManagerHint';
const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp'];
const TEXT_MIMES = ['text/plain;charset=utf-8', 'text/plain', 'UTF8_STRING', 'STRING', 'TEXT'];

// Office suites put a rendered picture of the selection next to the text;
// for them the text is what the user meant to copy.
const PREFER_TEXT_APPS = ['libreoffice', 'soffice', 'onlyoffice', 'wps'];

const TERMINALS = [
    'ptyxis', 'gnome-terminal', 'kgx', 'console', 'kitty', 'alacritty', 'wezterm', 'foot',
    'konsole', 'tilix', 'terminator', 'xterm', 'ghostty', 'blackbox', 'terminal',
];

const MAX_TEXT_LENGTH = 1024 * 1024;

function sha256(data) {
    return typeof data === 'string'
        ? GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, data, -1)
        : GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, data);
}

function filesHash(uris) {
    return sha256(`files:${uris.join('\n')}`);
}

function pngSize(data) {
    if (data.length < 24 || data[0] !== 0x89 || data[1] !== 0x50)
        return null;
    const read = o => ((data[o] << 24) | (data[o + 1] << 16) | (data[o + 2] << 8) | data[o + 3]) >>> 0;
    return {width: read(16), height: read(20)};
}

/** Where the copy came from, read from the window that had focus. */
function focusedSource() {
    const app = Shell.WindowTracker.get_default().focus_app;
    const window = global.display.focus_window;
    return {
        name: app?.get_name() ?? window?.get_title() ?? 'Unknown',
        keys: [app?.get_id(), app?.get_name(), window?.get_wm_class(), window?.get_wm_class_instance()]
            .filter(Boolean)
            .map(s => s.toLowerCase()),
    };
}

/**
 * Watches the clipboard, turns each change into a history entry, and puts
 * entries back on the clipboard when the user picks one.
 */
export class ClipboardMonitor {
    constructor({settings, history, linkTitles, onCaptured}) {
        this._settings = settings;
        this._history = history;
        this._linkTitles = linkTitles;
        this._onCaptured = onCaptured;
        this._clipboard = St.Clipboard.get_default();
        this._selection = global.display.get_selection();
        this._expectedHash = null;
        this._readSerial = 0;
        this._virtualDevice = null;

        this._selection.connectObject('owner-changed', (_sel, type) => {
            if (type === Meta.SelectionType.SELECTION_CLIPBOARD)
                this._read().catch(e => console.warn(`[better-clipboard] ${e.message}`));
        }, this);
    }

    destroy() {
        this._selection.disconnectObject(this);
        this._virtualDevice?.run_dispose();
        this._virtualDevice = null;
    }

    isPrivate() {
        if (!this._settings.get_boolean('private-mode'))
            return false;
        const until = this._settings.get_int64('private-until');
        return until === 0 || Date.now() / 1000 < until;
    }

    // Reading

    _getText() {
        return new Promise(resolve => this._clipboard.get_text(CLIPBOARD, (_c, text) => resolve(text)));
    }

    // St frees the GBytes as soon as the callback returns, so copy it out
    // before leaving the callback.
    _getContent(mime) {
        return new Promise(resolve => this._clipboard.get_content(CLIPBOARD, mime, (_c, bytes) => {
            resolve(bytes && bytes.get_size() > 0 ? new Uint8Array(bytes.toArray()) : null);
        }));
    }

    async _read() {
        // A newer change supersedes one we are still reading.
        const serial = ++this._readSerial;
        const stale = () => serial !== this._readSerial;

        const source = focusedSource();
        const mimes = this._clipboard.get_mimetypes(CLIPBOARD);
        if (mimes.length === 0)
            return;

        let entry = null;

        if (mimes.includes(FILES_MIME) || mimes.includes(URI_LIST_MIME))
            entry = await this._readFiles(mimes);

        const image = IMAGE_MIMES.find(m => mimes.includes(m));
        const hasText = TEXT_MIMES.some(m => mimes.includes(m));
        const preferText = hasText && source.keys.some(k => PREFER_TEXT_APPS.some(a => k.includes(a)));
        if (!entry && image && !preferText)
            entry = await this._readImage(image);

        if (!entry && hasText)
            entry = await this._readText();

        if (!entry || stale())
            return;

        if (entry.hash === this._expectedHash) {
            // Our own write coming back; the history was already updated.
            this._expectedHash = null;
            return;
        }

        if (this.isPrivate())
            return;

        const sensitive = await this._isSensitive(mimes, source);
        if (stale())
            return;
        if (sensitive && this._settings.get_boolean('ignore-password-managers'))
            return;

        if (entry.image && !sensitive)
            entry.image.path = await this._saveImage(entry.hash, entry.image);
        else
            delete entry.image?.bytes;

        const item = this._history.add({
            ...entry,
            source: source.name,
            time: Date.now(),
            sensitive,
        });
        this._onCaptured?.(item);

        if (item.kind === 'link' && !item.title && !sensitive && this._settings.get_boolean('fetch-link-titles')) {
            this._linkTitles.fetch(item.text)
                .then(title => title && this._history.update(item.id, {title}))
                .catch(() => {});
        }
    }

    async _isSensitive(mimes, source) {
        if (mimes.includes(SECRET_HINT_MIME)) {
            const hint = await this._getContent(SECRET_HINT_MIME);
            const value = hint ? new TextDecoder().decode(hint).trim() : 'secret';
            if (value === 'secret')
                return true;
        }
        const ignored = this._settings.get_strv('ignored-apps').map(s => s.trim().toLowerCase()).filter(Boolean);
        return source.keys.some(k => ignored.some(i => k.includes(i)));
    }

    async _readText() {
        const text = await this._getText();
        if (!text || text.trim().length === 0 || text.length > MAX_TEXT_LENGTH)
            return null;
        return {kind: classifyText(text), text, hash: sha256(text)};
    }

    async _readFiles(mimes) {
        const mime = mimes.includes(FILES_MIME) ? FILES_MIME : URI_LIST_MIME;
        const data = await this._getContent(mime);
        if (!data)
            return null;
        const lines = new TextDecoder().decode(data)
            .split(/\r?\n/)
            .map(l => l.trim())
            .filter(l => l.length > 0 && !l.startsWith('#'));
        // gnome-copied-files starts with the operation ("copy" or "cut").
        const uris = lines.filter(l => l.startsWith('file://'));
        if (uris.length === 0)
            return null;
        return {kind: 'file', files: uris, hash: filesHash(uris)};
    }

    async _readImage(mime) {
        const data = await this._getContent(mime);
        if (!data || data.length > this._settings.get_int('max-image-size-mb') * 1024 * 1024)
            return null;
        const bytes = new GLib.Bytes(data);
        const size = mime === 'image/png' ? pngSize(data) : null;
        return {
            kind: 'image',
            hash: sha256(bytes),
            image: {mime, bytes, size: data.length, width: size?.width ?? 0, height: size?.height ?? 0},
        };
    }

    async _saveImage(hash, image) {
        const ext = image.mime.split('/')[1];
        const file = this._history.imageDir.get_child(`${hash}.${ext}`);
        const {bytes} = image;
        delete image.bytes;
        if (file.query_exists(null))
            return file.get_path();
        await new Promise((resolve, reject) => {
            file.replace_contents_bytes_async(bytes, null, false, Gio.FileCreateFlags.PRIVATE, null, (f, res) => {
                try {
                    f.replace_contents_finish(res);
                    resolve();
                } catch (e) {
                    reject(e);
                }
            });
        });
        return file.get_path();
    }

    // Writing

    /**
     * Puts an item back on the clipboard. With `plain`, rich items fall back
     * to their text form (file paths for files).
     */
    setItem(item, {plain = false} = {}) {
        if (item.kind === 'image' && !plain) {
            const file = Gio.File.new_for_path(item.image.path);
            let contents;
            try {
                [, contents] = file.load_contents(null);
            } catch (e) {
                console.warn(`[better-clipboard] Image is gone: ${e.message}`);
                return false;
            }
            const bytes = new GLib.Bytes(contents);
            this._expectedHash = item.hash;
            this._clipboard.set_content(CLIPBOARD, item.image.mime, bytes);
        } else if (item.kind === 'file' && !plain) {
            const payload = `copy\n${item.files.join('\n')}`;
            this._expectedHash = item.hash;
            this._clipboard.set_content(CLIPBOARD, FILES_MIME, new GLib.Bytes(new TextEncoder().encode(payload)));
        } else {
            const text = item.kind === 'file'
                ? item.files.map(uri => GLib.filename_from_uri(uri)[0]).join('\n')
                : item.text ?? '';
            if (!text)
                return false;
            this._expectedHash = sha256(text) === item.hash ? item.hash : null;
            this._clipboard.set_text(CLIPBOARD, text);
        }
        return true;
    }

    /** Sends Ctrl+V (Ctrl+Shift+V in terminals) to the focused window. */
    sendPasteKeys() {
        if (!this._virtualDevice) {
            const seat = global.stage.context.get_backend().get_default_seat();
            this._virtualDevice = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        }
        const wmClass = global.display.focus_window?.get_wm_class()?.toLowerCase() ?? '';
        const terminal = TERMINALS.some(t => wmClass.includes(t));

        const keys = [Clutter.KEY_Control_L, ...terminal ? [Clutter.KEY_Shift_L] : [], Clutter.KEY_v];
        const time = GLib.get_monotonic_time();
        for (const key of keys)
            this._virtualDevice.notify_keyval(time, key, Clutter.KeyState.PRESSED);
        for (const key of keys.reverse())
            this._virtualDevice.notify_keyval(time, key, Clutter.KeyState.RELEASED);
    }
}
