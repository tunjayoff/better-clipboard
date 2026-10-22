import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {ClipboardMonitor} from './lib/clipboard.js';
import {History} from './lib/history.js';
import {ClipboardIndicator} from './lib/indicator.js';
import {LinkTitleFetcher} from './lib/linkTitle.js';
import {ClipboardPopup} from './lib/popup.js';
import {Shortcuts} from './lib/shortcuts.js';

// Long enough for focus to return to the app after the popup's grab ends.
const PASTE_DELAY_MS = 80;

export default class BetterClipboardExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._history = new History(this._settings, GLib.build_filenamev([GLib.get_user_data_dir(), this.uuid]));
        this._linkTitles = new LinkTitleFetcher();
        this._monitor = new ClipboardMonitor({
            settings: this._settings,
            history: this._history,
            linkTitles: this._linkTitles,
            onCaptured: () => this._indicator?.pulse(),
        });
        this._history.load().catch(e => console.warn(`[better-clipboard] ${e.message}`));

        this._indicator = new ClipboardIndicator(() => this._toggle('panel'));
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._shortcuts = new Shortcuts(this._settings, {
            toggle: () => this._toggle('panel'),
            atCursor: () => this._toggle('cursor'),
        });

        this._popup = null;
        this._pasteId = 0;
        this._privateTickId = 0;
        this._lastClearRequest = this._settings.get_int('clear-history-request');

        this._settings.connectObject(
            'changed::private-mode', () => this._syncPrivate(),
            'changed::private-until', () => this._syncPrivate(),
            'changed::clear-history-request', () => this._onClearRequest(),
            this);
        this._syncPrivate();
    }

    disable() {
        this._settings.disconnectObject(this);
        this._popup?.destroy();
        this._popup = null;
        for (const id of [this._pasteId, this._privateTickId]) {
            if (id)
                GLib.source_remove(id);
        }
        this._pasteId = this._privateTickId = 0;

        this._shortcuts.destroy();
        this._shortcuts = null;
        this._indicator.destroy();
        this._indicator = null;
        this._monitor.destroy();
        this._monitor = null;
        this._linkTitles.destroy();
        this._linkTitles = null;
        this._history.destroy();
        this._history = null;
        this._settings = null;
    }

    _toggle(mode) {
        if (this._popup) {
            const sameMode = this._popup.mode === mode;
            this._popup.close();
            if (sameMode)
                return;
        }

        const popup = new ClipboardPopup({
            mode,
            anchor: this._indicator,
            history: this._history,
            settings: this._settings,
            extensionPath: this.path,
            actions: {
                paste: (item, opts) => this._paste(item, opts),
                copy: item => this._copy(item),
                isPrivate: () => this._monitor.isPrivate(),
                startPrivate: seconds => this._startPrivate(seconds),
                openPreferences: () => this.openPreferences(),
            },
        });
        popup.mode = mode;
        popup.connect('closed', () => {
            if (this._popup === popup)
                this._popup = null;
            this._indicator?.setOpen(false);
        });

        this._popup = popup;
        if (popup.open())
            this._indicator.setOpen(mode === 'panel');
        else
            this._popup = null;
    }

    _copy(item, opts = {}) {
        if (!this._monitor.setItem(item, opts))
            return false;
        if (this._settings.get_boolean('move-to-top-on-paste'))
            this._history.touch(item.id);
        return true;
    }

    _paste(item, opts) {
        if (!this._copy(item, opts))
            return;
        if (this._pasteId)
            GLib.source_remove(this._pasteId);
        this._pasteId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PASTE_DELAY_MS, () => {
            this._pasteId = 0;
            this._monitor.sendPasteKeys();
            return GLib.SOURCE_REMOVE;
        });
    }

    _startPrivate(seconds) {
        const until = seconds > 0 ? Math.floor(Date.now() / 1000) + seconds : 0;
        this._settings.set_int64('private-until', until);
        this._settings.set_boolean('private-mode', true);
    }

    _syncPrivate() {
        if (this._privateTickId) {
            GLib.source_remove(this._privateTickId);
            this._privateTickId = 0;
        }

        const active = this._settings.get_boolean('private-mode');
        const until = this._settings.get_int64('private-until');
        if (!active) {
            this._indicator.setPrivate(false);
            return;
        }
        if (until === 0) {
            this._indicator.setPrivate(true, null);
            return;
        }

        const tick = () => {
            const remaining = until - Date.now() / 1000;
            if (remaining <= 0) {
                this._privateTickId = 0;
                this._settings.set_boolean('private-mode', false);
                return GLib.SOURCE_REMOVE;
            }
            this._indicator.setPrivate(true, remaining);
            return GLib.SOURCE_CONTINUE;
        };
        if (tick() === GLib.SOURCE_CONTINUE)
            this._privateTickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, tick);
    }

    _onClearRequest() {
        const request = this._settings.get_int('clear-history-request');
        if (request === this._lastClearRequest)
            return;
        this._lastClearRequest = request;
        this._history.clear({keepPinned: true});
    }
}
