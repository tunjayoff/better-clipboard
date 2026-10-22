import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {formatCountdown} from './format.js';

const PULSE_MS = 1200;

/** The top bar button: plain icon, private-mode state and a brief dot on new copies. */
export const ClipboardIndicator = GObject.registerClass(
class ClipboardIndicator extends PanelMenu.Button {
    _init(onActivate) {
        super._init(0.5, 'Better Clipboard', true);
        this.add_style_class_name('better-clipboard-indicator');

        const box = new St.BoxLayout({style_class: 'bc-indicator-box', y_align: Clutter.ActorAlign.CENTER});

        const iconWrap = new St.Widget({layout_manager: new Clutter.BinLayout(), y_align: Clutter.ActorAlign.CENTER});
        this._icon = new St.Icon({icon_name: 'edit-paste-symbolic', style_class: 'system-status-icon'});
        this._dot = new St.Widget({
            style_class: 'bc-indicator-dot',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
            opacity: 0,
        });
        iconWrap.add_child(this._icon);
        iconWrap.add_child(this._dot);
        box.add_child(iconWrap);

        this._timer = new St.Label({style_class: 'bc-indicator-timer', y_align: Clutter.ActorAlign.CENTER, visible: false});
        box.add_child(this._timer);
        this.add_child(box);

        this._pulseId = 0;

        const click = new Clutter.ClickGesture();
        click.set_recognize_on_press(true);
        click.connect('recognize', () => onActivate());
        this.add_action(click);

        this.connect('destroy', () => {
            if (this._pulseId)
                GLib.source_remove(this._pulseId);
            this._pulseId = 0;
        });
    }

    setOpen(open) {
        if (open)
            this.add_style_pseudo_class('active');
        else
            this.remove_style_pseudo_class('active');
    }

    /** @param {number|null} remaining seconds left, null when it never ends */
    setPrivate(active, remaining = null) {
        this._icon.icon_name = active ? 'view-conceal-symbolic' : 'edit-paste-symbolic';
        if (active)
            this.add_style_class_name('private');
        else
            this.remove_style_class_name('private');
        this._timer.visible = active && remaining !== null;
        if (this._timer.visible)
            this._timer.text = formatCountdown(remaining);
    }

    pulse() {
        this._dot.remove_all_transitions();
        this._dot.opacity = 255;
        if (this._pulseId)
            GLib.source_remove(this._pulseId);
        this._pulseId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PULSE_MS, () => {
            this._pulseId = 0;
            this._dot.ease({opacity: 0, duration: 300, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            return GLib.SOURCE_REMOVE;
        });
    }
});
