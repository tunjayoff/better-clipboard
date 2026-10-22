import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const TIMEOUTS = [
    {seconds: 10, label: '10 seconds'},
    {seconds: 30, label: '30 seconds'},
    {seconds: 60, label: '1 minute'},
    {seconds: 300, label: '5 minutes'},
];

function switchRow(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

/** Shows a shortcut and records a new one when activated. */
function shortcutRow(window, settings, key, title, subtitle) {
    const label = new Adw.ShortcutLabel({disabled_text: 'Disabled', valign: Gtk.Align.CENTER});
    const sync = () => {
        label.accelerator = settings.get_strv(key)[0] ?? '';
    };
    sync();
    settings.connect(`changed::${key}`, sync);

    const row = new Adw.ActionRow({title, subtitle, activatable: true});
    row.add_suffix(label);
    row.connect('activated', () => captureShortcut(window, title, accel => settings.set_strv(key, accel ? [accel] : [])));
    return row;
}

function captureShortcut(window, title, done) {
    const status = new Adw.StatusPage({
        icon_name: 'preferences-desktop-keyboard-shortcuts-symbolic',
        title: 'Press a new shortcut',
        description: 'Esc cancels · Backspace disables the shortcut',
    });
    const dialog = new Adw.Dialog({title, content_width: 420, content_height: 300});
    const view = new Adw.ToolbarView({content: status});
    view.add_top_bar(new Adw.HeaderBar());
    dialog.child = view;

    const keys = new Gtk.EventControllerKey();
    keys.connect('key-pressed', (_c, keyval, keycode, state) => {
        const mask = state & Gtk.accelerator_get_default_mod_mask();
        const key = Gdk.keyval_to_lower(keyval);

        if (mask === 0 && key === Gdk.KEY_Escape) {
            dialog.close();
            return Gdk.EVENT_STOP;
        }
        if (mask === 0 && key === Gdk.KEY_BackSpace) {
            done(null);
            dialog.close();
            return Gdk.EVENT_STOP;
        }

        const isFunctionKey = key >= Gdk.KEY_F1 && key <= Gdk.KEY_F35;
        if ((mask === 0 && !isFunctionKey) || !Gtk.accelerator_valid(key, mask))
            return Gdk.EVENT_STOP;

        done(Gtk.accelerator_name_with_keycode(null, key, keycode, mask));
        dialog.close();
        return Gdk.EVENT_STOP;
    });
    dialog.add_controller(keys);
    dialog.present(window);
}

function buildGeneralPage(window, settings) {
    const page = new Adw.PreferencesPage({title: 'General', icon_name: 'preferences-system-symbolic'});

    const shortcuts = new Adw.PreferencesGroup({title: 'Shortcuts and history'});
    shortcuts.add(shortcutRow(window, settings, 'shortcut-cursor', 'Open at pointer', 'Compact panel where your mouse is'));
    shortcuts.add(shortcutRow(window, settings, 'shortcut-toggle', 'Open under the top bar icon',
        'Same as clicking the icon; off unless you set one'));

    const size = new Adw.SpinRow({
        title: 'History length',
        subtitle: 'Pinned items don’t count toward this',
        adjustment: new Gtk.Adjustment({lower: 10, upper: 2000, step_increment: 10, page_increment: 100}),
    });
    settings.bind('history-size', size, 'value', Gio.SettingsBindFlags.DEFAULT);
    shortcuts.add(size);
    shortcuts.add(switchRow(settings, 'move-to-top-on-paste', 'Move pasted item to the top'));

    const imageSize = new Adw.SpinRow({
        title: 'Largest image to keep',
        subtitle: 'In megabytes',
        adjustment: new Gtk.Adjustment({lower: 1, upper: 100, step_increment: 1, page_increment: 10}),
    });
    settings.bind('max-image-size-mb', imageSize, 'value', Gio.SettingsBindFlags.DEFAULT);
    shortcuts.add(imageSize);
    page.add(shortcuts);

    const danger = new Adw.PreferencesGroup();
    const clear = new Adw.ButtonRow({title: 'Clear history…'});
    clear.add_css_class('destructive-action');
    clear.connect('activated', () => {
        const dialog = new Adw.AlertDialog({
            heading: 'Clear clipboard history?',
            body: 'Everything except pinned items is removed. This can’t be undone.',
        });
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('clear', 'Clear history');
        dialog.set_response_appearance('clear', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.set_default_response('cancel');
        dialog.set_close_response('cancel');
        dialog.connect('response', (_d, response) => {
            if (response === 'clear')
                settings.set_int('clear-history-request', settings.get_int('clear-history-request') + 1);
        });
        dialog.present(window);
    });
    danger.add(clear);
    page.add(danger);

    return page;
}

function buildPrivacyPage(settings) {
    const page = new Adw.PreferencesPage({title: 'Privacy', icon_name: 'changes-prevent-symbolic'});

    const general = new Adw.PreferencesGroup({title: 'Privacy'});
    general.add(switchRow(settings, 'ignore-password-managers', 'Ignore password managers',
        'Content marked as secret, or copied from the apps below, is never saved'));

    const timeout = new Adw.ComboRow({
        title: 'Remove sensitive items after',
        subtitle: 'Used when the option above is off',
    });
    const options = [...TIMEOUTS];
    const current = settings.get_int('sensitive-timeout');
    if (!options.some(o => o.seconds === current))
        options.push({seconds: current, label: `${current} seconds`});
    timeout.model = Gtk.StringList.new(options.map(o => o.label));
    timeout.selected = options.findIndex(o => o.seconds === current);
    timeout.connect('notify::selected', () => settings.set_int('sensitive-timeout', options[timeout.selected].seconds));
    general.add(timeout);

    general.add(switchRow(settings, 'clear-on-logout', 'Clear history after logging out', 'Pinned items are kept'));
    page.add(general);

    const apps = new Adw.PreferencesGroup({
        title: 'Ignored apps',
        description: 'Matched against the app name, app ID and window class, ignoring case.',
    });
    const rows = [];
    const add = new Adw.EntryRow({title: 'Add app', show_apply_button: true});

    const render = () => {
        rows.splice(0).forEach(r => apps.remove(r));
        apps.remove(add);
        for (const name of settings.get_strv('ignored-apps')) {
            const row = new Adw.ActionRow({title: name});
            const remove = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                valign: Gtk.Align.CENTER,
                tooltip_text: `Remove ${name}`,
                css_classes: ['flat'],
            });
            remove.connect('clicked', () =>
                settings.set_strv('ignored-apps', settings.get_strv('ignored-apps').filter(n => n !== name)));
            row.add_suffix(remove);
            apps.add(row);
            rows.push(row);
        }
        apps.add(add);
    };
    add.connect('apply', () => {
        const name = add.text.trim().toLowerCase();
        const list = settings.get_strv('ignored-apps');
        if (name && !list.includes(name))
            settings.set_strv('ignored-apps', [...list, name]);
        add.text = '';
    });
    settings.connect('changed::ignored-apps', render);
    render();
    page.add(apps);

    return page;
}

function buildAppearancePage(settings) {
    const page = new Adw.PreferencesPage({title: 'Appearance', icon_name: 'applications-graphics-symbolic'});
    const group = new Adw.PreferencesGroup({title: 'Appearance'});
    group.add(switchRow(settings, 'show-preview', 'Preview pane', 'When off, the top bar panel is a single column'));
    group.add(switchRow(settings, 'fetch-link-titles', 'Fetch link titles', 'Requests each copied page once; needs internet'));
    page.add(group);
    return page;
}

export default class BetterClipboardPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;
        window.set_default_size(640, 640);
        window.add(buildGeneralPage(window, settings));
        window.add(buildPrivacyPage(settings));
        window.add(buildAppearancePage(settings));
    }
}
