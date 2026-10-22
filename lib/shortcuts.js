import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const SHELL_KEYBINDINGS = 'org.gnome.shell.keybindings';
const MESSAGE_TRAY_KEY = 'toggle-message-tray';
const KEYS = ['shortcut-toggle', 'shortcut-cursor'];

const normalize = accel => accel.toLowerCase().replace(/<primary>|<ctrl>/g, '<control>');

/**
 * Registers the two shortcuts. GNOME ships Super+V as one of the shortcuts
 * for the notification list, so when ours collides we borrow it and give it
 * back on disable.
 */
export class Shortcuts {
    constructor(settings, handlers) {
        this._settings = settings;
        this._handlers = handlers;
        this._shellSettings = new Gio.Settings({schema_id: SHELL_KEYBINDINGS});

        this._resolveConflicts();
        this._settings.connectObject(
            'changed::shortcut-toggle', () => this._resolveConflicts(),
            'changed::shortcut-cursor', () => this._resolveConflicts(),
            this);

        const mode = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP;
        Main.wm.addKeybinding('shortcut-toggle', this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, mode, () => this._handlers.toggle());
        Main.wm.addKeybinding('shortcut-cursor', this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, mode, () => this._handlers.atCursor());
    }

    destroy() {
        for (const key of KEYS)
            Main.wm.removeKeybinding(key);
        this._settings.disconnectObject(this);
        this._restore();
    }

    _ours() {
        return new Set(KEYS.flatMap(k => this._settings.get_strv(k)).map(normalize));
    }

    _resolveConflicts() {
        // Start from the user's original list so a changed shortcut gives
        // back what it no longer needs.
        this._restore();

        const ours = this._ours();
        const current = this._shellSettings.get_strv(MESSAGE_TRAY_KEY);
        const taken = current.filter(a => ours.has(normalize(a)));
        if (taken.length === 0)
            return;

        this._shellSettings.set_strv(MESSAGE_TRAY_KEY, current.filter(a => !taken.includes(a)));
        this._settings.set_strv('message-tray-accels-backup', taken);
    }

    _restore() {
        const backup = this._settings.get_strv('message-tray-accels-backup');
        if (backup.length === 0)
            return;
        const current = this._shellSettings.get_strv(MESSAGE_TRAY_KEY);
        this._shellSettings.set_strv(MESSAGE_TRAY_KEY,
            [...current, ...backup.filter(a => !current.includes(a))]);
        this._settings.set_strv('message-tray-accels-backup', []);
    }
}
