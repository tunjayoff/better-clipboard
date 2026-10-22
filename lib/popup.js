import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';

import {domainOf, firstLine} from './classify.js';
import {formatBytes, formatCountdown, relativeTime} from './format.js';
import {typeName} from './typeName.js';

const FILTERS = [
    {id: 'all', label: 'All'},
    {id: 'text', label: 'Text'},
    {id: 'code', label: 'Code'},
    {id: 'link', label: 'Links'},
    {id: 'file', label: 'Files'},
    {id: 'image', label: 'Images'},
    {id: 'pinned', label: 'Pinned'},
];

const KIND_LABEL = {text: 'Text', code: 'Code', link: 'Link', file: 'File', image: 'Image', secret: 'Sensitive'};

const PAGE_SIZE = 60;
const PREVIEW_MAX_CHARS = 20000;
const PREVIEW_MAX_LINES = 400;
const COMPACT_PREVIEW_LINES = 3;
const SCREEN_MARGIN = 8;
const CURSOR_OFFSET = 12;
const MASK = '••••••••••••';

const PRIVATE_DURATIONS = [
    {label: '15 min', seconds: 15 * 60},
    {label: '1 hour', seconds: 60 * 60},
    {label: 'Until I turn it off', seconds: 0},
];

function displayKind(item) {
    return item.sensitive ? 'secret' : item.kind;
}

function fileName(uri) {
    try {
        return GLib.path_get_basename(GLib.filename_from_uri(uri)[0]);
    } catch {
        return uri;
    }
}

function filePath(uri) {
    try {
        const path = GLib.filename_from_uri(uri)[0];
        const home = GLib.get_home_dir();
        return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
    } catch {
        return uri;
    }
}

function rowLabel(item) {
    switch (displayKind(item)) {
    case 'secret':
        return MASK;
    case 'link':
        return item.title ?? item.text.trim();
    case 'file':
        return item.files.length === 1
            ? fileName(item.files[0])
            : `${item.files.length} files: ${item.files.map(fileName).join(', ')}`;
    case 'image':
        return item.image.width ? `Image · ${item.image.width} × ${item.image.height}` : 'Image';
    case 'code':
        // Code often starts with a lone brace; show the start of the snippet.
        return firstLine(item.text.replace(/\s+/g, ' '));
    default:
        return firstLine(item.text);
    }
}

function plural(n, word) {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function searchableText(item) {
    if (item.sensitive)
        return `${item.source} sensitive`;
    return [item.text, item.title, item.source, ...(item.files ?? []).map(fileName)]
        .filter(Boolean).join(' ').toLocaleLowerCase();
}

function makeLabel(text, styleClass, params = {}) {
    return new St.Label({text, style_class: styleClass, ...params});
}

function wrapLabel(label) {
    label.clutter_text.line_wrap = true;
    label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return label;
}

function makeButton(label, styleClass, onClick, params = {}) {
    const button = new St.Button({
        style_class: `bc-button ${styleClass}`.trim(),
        can_focus: true,
        track_hover: true,
        ...params,
    });
    if (label !== null)
        button.child = makeLabel(label, 'bc-button-label', {y_align: Clutter.ActorAlign.CENTER});
    button.connect('clicked', () => onClick());
    return button;
}

function kbd(text) {
    return makeLabel(text, 'bc-kbd', {y_align: Clutter.ActorAlign.CENTER});
}

const ItemRow = GObject.registerClass({
    GTypeName: typeName('ItemRow'),
}, class ItemRow extends St.Button {
    _init(item, hint, {compact, icons}) {
        super._init({
            style_class: 'bc-row',
            can_focus: false,
            track_hover: true,
            x_expand: true,
        });
        this.item = item;
        this._compact = compact;
        this._hintText = hint;

        const outer = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        const box = new St.BoxLayout({style_class: 'bc-row-box', x_expand: true});

        const kind = displayKind(item);
        const tile = new St.Bin({style_class: 'bc-tile', y_align: Clutter.ActorAlign.CENTER});
        tile.child = new St.Icon({gicon: icons[kind], style_class: 'bc-tile-icon'});
        box.add_child(tile);

        const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'bc-row-text', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const title = makeLabel(rowLabel(item), kind === 'code' ? 'bc-row-title mono' : 'bc-row-title', {x_expand: true});
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        text.add_child(title);
        const meta = item.kind === 'link' && item.title && !item.sensitive
            ? `${domainOf(item.text)} · ${relativeTime(item.time)}`
            : `${item.source} · ${relativeTime(item.time)}`;
        text.add_child(makeLabel(meta, 'bc-row-meta'));
        box.add_child(text);

        if (item.pinned)
            box.add_child(new St.Icon({icon_name: 'view-pin-symbolic', style_class: 'bc-row-pin', y_align: Clutter.ActorAlign.CENTER}));

        this._hint = kbd(hint);
        box.add_child(this._hint);
        outer.add_child(box);

        if (compact && (kind === 'text' || kind === 'code') && item.text.trim().includes('\n')) {
            const lines = item.text.split('\n').slice(0, COMPACT_PREVIEW_LINES).join('\n');
            this._preview = makeLabel(lines.slice(0, 600), kind === 'code' ? 'bc-row-preview mono' : 'bc-row-preview', {visible: false});
            this._preview.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            outer.add_child(this._preview);
        }
        this.child = outer;
    }

    setSelected(selected) {
        if (selected)
            this.add_style_class_name('selected');
        else
            this.remove_style_class_name('selected');
        if (this._preview)
            this._preview.visible = selected;
        this._hint.text = this._compact && selected ? 'Enter' : this._hintText;
    }

    set hintText(text) {
        this._hintText = text;
        this._hint.text = text;
    }
});

/**
 * The clipboard panel. Created for each opening and destroyed on close.
 * `mode` is 'panel' (under the top bar icon, with a preview pane) or
 * 'cursor' (compact, at the mouse pointer).
 */
export const ClipboardPopup = GObject.registerClass({
    GTypeName: typeName('Popup'),
}, class ClipboardPopup extends St.Widget {
    _init({mode, anchor, history, settings, extensionPath, actions}) {
        super._init({reactive: true, visible: false});
        this._mode = mode;
        this._anchor = anchor;
        this._history = history;
        this._settings = settings;
        this._actions = actions;
        this._compact = mode === 'cursor';
        this._withPreview = !this._compact && settings.get_boolean('show-preview');

        this._filter = 'all';
        this._query = '';
        this._matches = [];
        this._rows = [];
        this._selected = 0;
        this._rendered = 0;
        this._revealed = false;
        this._choosingPrivate = false;
        this._pointerAtKeyNav = null;
        this._grab = null;
        this._tickId = 0;

        const icon = name => Gio.icon_new_for_string(`${extensionPath}/icons/${name}.svg`);
        this._icons = {
            text: icon('bc-text-symbolic'),
            code: icon('bc-code-symbolic'),
            link: icon('bc-link-symbolic'),
            file: Gio.ThemedIcon.new('x-office-document-symbolic'),
            image: Gio.ThemedIcon.new('image-x-generic-symbolic'),
            secret: Gio.ThemedIcon.new('changes-prevent-symbolic'),
        };

        this.add_constraint(new Clutter.BindConstraint({source: global.stage, coordinate: Clutter.BindCoordinate.ALL}));

        this._panel = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: `bc-panel ${this._compact ? 'compact' : this._withPreview ? 'full' : 'narrow'}`,
            reactive: true,
        });
        this.add_child(this._panel);
        this._build();

        const outside = new Clutter.LongPressGesture({long_press_duration_ms: 0});
        outside.connect('may-recognize', () => {
            const coords = outside.get_coords_abs();
            const actor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, coords.x, coords.y);
            return !this._panel.contains(actor);
        });
        outside.connect('recognize', () => this.close());
        this.add_action(outside);

        this._keys = new Clutter.KeyController();
        this._keys.connect('key-press', () => this._onKeyPress());
        this.add_action_full('better-clipboard-keys', Clutter.EventPhase.CAPTURE, this._keys);

        this._history.connectObject('changed', () => this._refresh({keepSelection: true}), this);
        this._settings.connectObject(
            'changed::private-mode', () => this._updatePrivateBanner(),
            'changed::private-until', () => this._updatePrivateBanner(),
            this);

        this.connect('destroy', () => this._onDestroy());
    }

    open() {
        Main.uiGroup.add_child(this);
        this._refresh();

        this._grab = Main.pushModal(this, {actionMode: Shell.ActionMode.POPUP});

        this.show();
        this._place();
        this._entry.grab_key_focus();

        this._panel.opacity = 0;
        this._panel.set_pivot_point(this._compact ? 0 : 0.9, 0);
        this._panel.scale_x = this._panel.scale_y = 0.98;
        this._panel.ease({opacity: 255, scale_x: 1, scale_y: 1, duration: 120, mode: Clutter.AnimationMode.EASE_OUT_QUAD});

        // Keeps relative times and the sensitive-item countdown current.
        this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._updatePrivateBanner();
            if (this._current()?.sensitive)
                this._updatePreview();
            return GLib.SOURCE_CONTINUE;
        });
        return true;
    }

    close() {
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this._actions.closed();
        this.destroy();
    }

    _onDestroy() {
        if (this._tickId)
            GLib.source_remove(this._tickId);
        this._tickId = 0;
        if (this._grab)
            Main.popModal(this._grab);
        this._grab = null;
        this._history.disconnectObject(this);
        this._settings.disconnectObject(this);
    }

    // Layout

    _build() {
        const header = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'bc-header'});

        const top = new St.BoxLayout({style_class: 'bc-header-row'});
        this._entry = new St.Entry({
            style_class: 'bc-search',
            hint_text: 'Search clipboard…',
            can_focus: true,
            x_expand: true,
        });
        this._entry.set_primary_icon(new St.Icon({icon_name: 'edit-find-symbolic', style_class: 'bc-search-icon'}));
        this._clearIcon = new St.Icon({icon_name: 'edit-clear-symbolic', style_class: 'bc-search-icon'});
        this._entry.connect('secondary-icon-clicked', () => this._entry.set_text(''));
        this._entry.clutter_text.connect('text-changed', () => {
            this._query = this._entry.get_text().trim().toLocaleLowerCase();
            this._entry.set_secondary_icon(this._query ? this._clearIcon : null);
            this._refresh();
        });
        top.add_child(this._entry);

        if (this._compact) {
            this._resultCount = makeLabel('', 'bc-result-count', {y_align: Clutter.ActorAlign.CENTER});
            top.add_child(this._resultCount);
        } else {
            this._privateButton = new St.Button({
                style_class: 'bc-icon-button',
                can_focus: true,
                track_hover: true,
                accessible_name: 'Private mode',
                child: new St.Icon({icon_name: 'view-conceal-symbolic', style_class: 'bc-icon-button-icon'}),
            });
            this._privateButton.connect('clicked', () => this._onPrivateClicked());
            top.add_child(this._privateButton);

            const prefs = new St.Button({
                style_class: 'bc-icon-button',
                can_focus: true,
                track_hover: true,
                accessible_name: 'Settings',
                child: new St.Icon({icon_name: 'preferences-system-symbolic', style_class: 'bc-icon-button-icon'}),
            });
            prefs.connect('clicked', () => {
                this.close();
                this._actions.openPreferences();
            });
            top.add_child(prefs);
        }
        header.add_child(top);

        this._banner = new St.BoxLayout({style_class: 'bc-banner', visible: false});
        header.add_child(this._banner);

        if (!this._compact) {
            this._chips = new St.BoxLayout({style_class: 'bc-chips'});
            this._chipButtons = FILTERS.map(f => {
                const chip = new St.Button({style_class: 'bc-chip', can_focus: true, track_hover: true});
                const box = new St.BoxLayout({style_class: 'bc-chip-box'});
                box.add_child(makeLabel(f.label, 'bc-chip-label'));
                // The single-column panel has no room for counts.
                chip._count = makeLabel('', 'bc-chip-count', {visible: this._withPreview});
                box.add_child(chip._count);
                chip.child = box;
                chip.connect('clicked', () => this._setFilter(f.id));
                this._chips.add_child(chip);
                return chip;
            });
            header.add_child(this._chips);
        }
        this._panel.add_child(header);

        const body = new St.BoxLayout({style_class: 'bc-body', y_expand: true});
        this._list = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'bc-list'});
        this._scroll = new St.ScrollView({
            style_class: 'bc-list-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: !this._withPreview,
            y_expand: true,
            child: this._list,
        });
        this._scroll.vadjustment.connect('notify::value', () => this._maybeRenderMore());
        body.add_child(this._scroll);

        if (this._withPreview) {
            // Fixed width (see stylesheet) so long lines scroll instead of
            // widening the panel.
            this._preview = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                style_class: 'bc-preview',
                x_expand: true,
                y_expand: true,
                clip_to_allocation: true,
            });
            body.add_child(this._preview);
        }
        this._panel.add_child(body);

        const footer = new St.BoxLayout({style_class: 'bc-footer'});
        let hints = [['↑↓', 'move'], ['Enter', 'paste'], ['Shift+Enter', 'plain text'], ['Ctrl+P', 'pin'], ['Del', 'delete']];
        if (this._compact)
            hints = [['Enter', 'paste'], ['Alt+1–9', 'quick paste'], ['Esc', 'close']];
        else if (!this._withPreview)
            hints = [['Enter', 'paste'], ['Ctrl+P', 'pin'], ['Del', 'delete'], ['Tab', 'filter']];
        for (const [key, action] of hints) {
            const hint = new St.BoxLayout({style_class: 'bc-hint'});
            hint.add_child(kbd(key));
            hint.add_child(makeLabel(action, 'bc-hint-label', {y_align: Clutter.ActorAlign.CENTER}));
            footer.add_child(hint);
        }
        footer.add_child(new St.Widget({x_expand: true}));
        this._countLabel = makeLabel('', 'bc-hint-label', {y_align: Clutter.ActorAlign.CENTER});
        footer.add_child(this._countLabel);
        this._panel.add_child(footer);
    }

    _place() {
        const [, natW] = this._panel.get_preferred_width(-1);
        const [, natH] = this._panel.get_preferred_height(natW);
        const monitors = Main.layoutManager.monitors;

        let x, y, monitorIndex;
        if (this._mode === 'cursor') {
            const [px, py] = global.get_pointer();
            monitorIndex = Math.max(0, monitors.findIndex(m =>
                px >= m.x && px < m.x + m.width && py >= m.y && py < m.y + m.height));
            const area = Main.layoutManager.getWorkAreaForMonitor(monitorIndex);
            const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            const offset = CURSOR_OFFSET * scale;
            x = px + offset;
            y = py + offset;
            // Flip to the other side of the pointer instead of covering it.
            if (x + natW > area.x + area.width - SCREEN_MARGIN)
                x = px - natW - offset;
            if (y + natH > area.y + area.height - SCREEN_MARGIN)
                y = py - natH - offset;
            [x, y] = this._clamp(x, y, natW, natH, area);
        } else {
            const [ax, ay] = this._anchor.get_transformed_position();
            const [aw, ah] = this._anchor.get_transformed_size();
            monitorIndex = Main.layoutManager.findIndexForActor(this._anchor);
            const area = Main.layoutManager.getWorkAreaForMonitor(monitorIndex);
            x = ax + aw / 2 - natW * 0.9;
            y = Math.max(ay + ah, area.y) + 6;
            [x, y] = this._clamp(x, y, natW, natH, area);
        }
        this._panel.set_position(Math.round(x), Math.round(y));
    }

    _clamp(x, y, w, h, area) {
        const m = SCREEN_MARGIN;
        return [
            Math.min(Math.max(x, area.x + m), area.x + area.width - w - m),
            Math.min(Math.max(y, area.y + m), area.y + area.height - h - m),
        ];
    }

    // Data

    _refresh({keepSelection = false} = {}) {
        const previousId = keepSelection ? this._current()?.id : null;
        const items = this._history.items;
        const inFilter = (item, f) => f === 'all' || (f === 'pinned' ? item.pinned : item.kind === f);

        this._matches = items.filter(item =>
            inFilter(item, this._filter) && (!this._query || searchableText(item).includes(this._query)));
        // Pinned first, then everything else, both newest first.
        this._matches.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));

        if (this._chipButtons) {
            FILTERS.forEach((f, i) => {
                const chip = this._chipButtons[i];
                chip._count.text = String(items.filter(item => inFilter(item, f.id)).length);
                if (f.id === this._filter)
                    chip.add_style_class_name('active');
                else
                    chip.remove_style_class_name('active');
            });
        }

        const index = previousId ? this._matches.findIndex(it => it.id === previousId) : -1;
        this._selected = index >= 0 ? index : 0;
        this._revealed = false;

        this._list.destroy_all_children();
        this._rows = [];
        this._rendered = 0;
        this._sectionsShown = {pinned: false, recent: false};
        this._renderMore(Math.max(PAGE_SIZE, this._selected + 1));

        if (this._matches.length === 0)
            this._list.add_child(this._emptyState(items.length === 0));

        this._countLabel.text = plural(items.length, 'item');
        if (this._resultCount)
            this._resultCount.text = this._query ? plural(this._matches.length, 'result') : '';

        this._updateSelection();
        this._updatePrivateBanner();
    }

    _renderMore(count = PAGE_SIZE) {
        const end = Math.min(this._matches.length, this._rendered + count);
        for (let i = this._rendered; i < end; i++) {
            const item = this._matches[i];
            if (!this._compact) {
                const section = item.pinned ? 'pinned' : 'recent';
                if (!this._sectionsShown[section]) {
                    this._sectionsShown[section] = true;
                    this._list.add_child(makeLabel(item.pinned ? 'Pinned' : 'Recent', 'bc-section'));
                }
            }
            const row = new ItemRow(item, '', {compact: this._compact, icons: this._icons});
            row.hintText = i < 9 ? String(i + 1) : '';
            row.connect('clicked', () => this._activate(i));
            row.connect('notify::hover', () => {
                if (row.hover && this._pointerMoved())
                    this._select(i, {scroll: false});
            });
            this._list.add_child(row);
            this._rows.push(row);
        }
        this._rendered = end;
    }

    _maybeRenderMore() {
        if (this._rendered >= this._matches.length)
            return;
        const adj = this._scroll.vadjustment;
        if (adj.value + adj.page_size > adj.upper - 200)
            this._renderMore();
    }

    _emptyState(historyEmpty) {
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'bc-empty', x_expand: true, y_expand: true, y_align: Clutter.ActorAlign.CENTER});
        if (historyEmpty) {
            const tile = new St.Bin({style_class: 'bc-empty-tile', x_align: Clutter.ActorAlign.CENTER});
            tile.child = new St.Icon({icon_name: 'edit-paste-symbolic', style_class: 'bc-empty-icon'});
            box.add_child(tile);
            box.add_child(makeLabel('Nothing copied yet', 'bc-empty-title', {x_align: Clutter.ActorAlign.CENTER}));
            box.add_child(wrapLabel(makeLabel('Text, links, files and images you copy with Ctrl+C will collect here.', 'bc-empty-body', {x_align: Clutter.ActorAlign.CENTER})));
        } else {
            box.add_child(makeLabel('No matches', 'bc-empty-title', {x_align: Clutter.ActorAlign.CENTER}));
            box.add_child(wrapLabel(makeLabel('Try another word, or switch the filter to All.', 'bc-empty-body', {x_align: Clutter.ActorAlign.CENTER})));
        }
        return box;
    }

    _current() {
        return this._matches[this._selected] ?? null;
    }

    _select(index, {scroll = true} = {}) {
        if (this._matches.length === 0)
            return;
        const clamped = Math.max(0, Math.min(this._matches.length - 1, index));
        if (clamped >= this._rendered)
            this._renderMore(clamped - this._rendered + PAGE_SIZE);
        if (clamped !== this._selected)
            this._revealed = false;
        this._selected = clamped;
        this._updateSelection();
        if (scroll && this._rows[clamped])
            ensureActorVisibleInScrollView(this._scroll, this._rows[clamped]);
    }

    _updateSelection() {
        this._rows.forEach((row, i) => row.setSelected(i === this._selected));
        this._updatePreview();
    }

    _pointerMoved() {
        if (!this._pointerAtKeyNav)
            return true;
        const [x, y] = global.get_pointer();
        if (x === this._pointerAtKeyNav[0] && y === this._pointerAtKeyNav[1])
            return false;
        this._pointerAtKeyNav = null;
        return true;
    }

    _setFilter(id) {
        if (id === this._filter)
            return;
        this._filter = id;
        this._refresh();
    }

    // Preview

    _updatePreview() {
        if (!this._preview)
            return;
        this._preview.destroy_all_children();
        const item = this._current();
        if (!item)
            return;
        const kind = displayKind(item);

        const head = new St.BoxLayout({style_class: 'bc-preview-head'});
        head.add_child(makeLabel(KIND_LABEL[kind], 'bc-badge', {y_align: Clutter.ActorAlign.CENTER}));
        head.add_child(makeLabel(`${item.source} · ${relativeTime(item.time)}`, 'bc-preview-meta', {y_align: Clutter.ActorAlign.CENTER}));
        this._preview.add_child(head);

        const content = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'bc-preview-content', y_expand: true});
        content.add_child(this._previewContent(item, kind));
        this._preview.add_child(content);

        this._preview.add_child(makeLabel(this._previewMeta(item, kind), 'bc-preview-meta'));

        const actions = new St.BoxLayout({style_class: 'bc-actions'});
        const paste = new St.Button({style_class: 'bc-button primary', can_focus: true, track_hover: true});
        const pasteBox = new St.BoxLayout({style_class: 'bc-button-box'});
        pasteBox.add_child(new St.Icon({icon_name: 'edit-paste-symbolic', style_class: 'bc-button-icon'}));
        pasteBox.add_child(makeLabel('Paste', 'bc-button-label', {y_align: Clutter.ActorAlign.CENTER}));
        pasteBox.add_child(makeLabel('Enter', 'bc-button-kbd', {y_align: Clutter.ActorAlign.CENTER}));
        paste.child = pasteBox;
        paste.connect('clicked', () => this._activate(this._selected));
        actions.add_child(paste);
        actions.add_child(makeButton('Copy', '', () => this._copy(item)));
        if (!item.sensitive)
            actions.add_child(makeButton(item.pinned ? 'Unpin' : 'Pin', '', () => this._history.togglePin(item.id)));
        actions.add_child(new St.Widget({x_expand: true}));
        const remove = makeButton(null, 'danger icon-only', () => this._history.remove(item.id), {accessible_name: 'Delete from history'});
        remove.child = new St.Icon({icon_name: 'user-trash-symbolic', style_class: 'bc-button-icon'});
        actions.add_child(remove);
        this._preview.add_child(actions);
    }

    _previewContent(item, kind) {
        switch (kind) {
        case 'code': {
            const text = item.text.slice(0, PREVIEW_MAX_CHARS);
            const lines = text.split('\n').slice(0, PREVIEW_MAX_LINES);
            const row = new St.BoxLayout({style_class: 'bc-code'});
            row.add_child(makeLabel(lines.map((_l, i) => String(i + 1)).join('\n'), 'bc-code-gutter'));
            const code = makeLabel(lines.join('\n'), 'bc-code-text', {x_expand: true});
            code.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            row.add_child(code);
            const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL});
            box.add_child(row);
            return new St.ScrollView({
                style_class: 'bc-code-scroll',
                hscrollbar_policy: St.PolicyType.AUTOMATIC,
                overlay_scrollbars: true,
                y_expand: true,
                child: box,
            });
        }
        case 'text': {
            const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL});
            box.add_child(wrapLabel(makeLabel(item.text.slice(0, PREVIEW_MAX_CHARS), 'bc-text')));
            return new St.ScrollView({hscrollbar_policy: St.PolicyType.NEVER, overlay_scrollbars: true, y_expand: true, child: box});
        }
        case 'link': {
            const card = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'bc-card'});
            const top = new St.BoxLayout({style_class: 'bc-card-row'});
            const domain = domainOf(item.text.trim());
            top.add_child(new St.Bin({style_class: 'bc-initial', child: makeLabel(domain.charAt(0).toUpperCase(), 'bc-initial-label', {x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER})}));
            const names = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
            names.add_child(wrapLabel(makeLabel(item.title ?? domain, 'bc-card-title')));
            names.add_child(makeLabel(domain, 'bc-preview-meta'));
            top.add_child(names);
            card.add_child(top);
            card.add_child(wrapLabel(makeLabel(item.text.trim(), 'bc-mono-small')));
            return card;
        }
        case 'image': {
            const frame = new St.Widget({style_class: 'bc-image', x_expand: true, y_expand: true});
            frame.style = `background-image: url("file://${encodeURI(item.image.path)}");`;
            return frame;
        }
        case 'file': {
            const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'bc-file-list'});
            for (const uri of item.files.slice(0, 6)) {
                const card = new St.BoxLayout({style_class: 'bc-card bc-card-row'});
                card.add_child(new St.Bin({style_class: 'bc-file-tile', child: new St.Icon({gicon: this._icons.file, style_class: 'bc-file-icon'})}));
                const names = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
                names.add_child(makeLabel(fileName(uri), 'bc-card-title'));
                names.add_child(makeLabel(filePath(uri), 'bc-mono-small'));
                card.add_child(names);
                box.add_child(card);
            }
            if (item.files.length > 6)
                box.add_child(makeLabel(`and ${item.files.length - 6} more`, 'bc-preview-meta'));
            return box;
        }
        case 'secret': {
            const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'bc-secret'});
            const card = new St.BoxLayout({style_class: 'bc-card bc-card-row'});
            card.add_child(makeLabel(this._revealed ? firstLine(item.text, 80) : MASK, 'bc-secret-value', {x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
            card.add_child(makeButton(this._revealed ? 'Hide' : 'Show', 'small', () => {
                this._revealed = !this._revealed;
                this._updatePreview();
            }));
            box.add_child(card);
            const note = new St.BoxLayout({style_class: 'bc-note'});
            note.add_child(new St.Icon({icon_name: 'changes-prevent-symbolic', style_class: 'bc-note-icon'}));
            note.add_child(wrapLabel(makeLabel('Marked as sensitive. It is never written to disk and leaves the history on its own.', 'bc-note-label', {x_expand: true})));
            box.add_child(note);
            return box;
        }
        }
        return new St.Widget();
    }

    _previewMeta(item, kind) {
        switch (kind) {
        case 'text':
        case 'code':
            return `${plural(item.text.length, 'character')} · ${plural(item.text.split('\n').length, 'line')}`;
        case 'link':
            return `Link · ${domainOf(item.text.trim())}`;
        case 'image': {
            const {width, height, mime, size} = item.image;
            const dims = width ? `${width} × ${height} · ` : '';
            return `${dims}${mime.split('/')[1].toUpperCase()} · ${formatBytes(size)}`;
        }
        case 'file':
            return plural(item.files.length, 'file');
        case 'secret':
            return `Leaves the history in ${Math.max(0, Math.ceil(((item.expiresAt ?? Date.now()) - Date.now()) / 1000))} s`;
        }
        return '';
    }

    // Private mode

    _onPrivateClicked() {
        if (this._settings.get_boolean('private-mode')) {
            this._settings.set_boolean('private-mode', false);
            return;
        }
        this._choosingPrivate = !this._choosingPrivate;
        this._updatePrivateBanner();
    }

    _updatePrivateBanner() {
        const active = this._actions.isPrivate();
        if (this._privateButton) {
            if (active)
                this._privateButton.add_style_class_name('active');
            else
                this._privateButton.remove_style_class_name('active');
        }

        const state = active ? 'active' : this._choosingPrivate ? 'choose' : 'off';
        const until = this._settings.get_int64('private-until');
        const remaining = until > 0 ? until - Date.now() / 1000 : null;
        const key = `${state}:${remaining === null ? '' : formatCountdown(remaining)}`;
        if (key === this._bannerKey)
            return;
        this._bannerKey = key;

        this._banner.destroy_all_children();
        this._banner.visible = state !== 'off';
        if (state === 'off')
            return;

        this._banner.add_child(new St.Icon({
            icon_name: active ? 'changes-prevent-symbolic' : 'view-conceal-symbolic',
            style_class: 'bc-banner-icon',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        if (active) {
            const text = remaining === null
                ? 'Private mode is on. New copies aren’t saved.'
                : `Private mode is on for ${formatCountdown(remaining)}. New copies aren’t saved.`;
            this._banner.add_child(makeLabel(text, 'bc-banner-label', {x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
            this._banner.add_child(makeButton('Turn off', 'small', () => this._settings.set_boolean('private-mode', false)));
        } else {
            this._banner.add_child(makeLabel('Pause history for', 'bc-banner-label', {x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
            for (const d of PRIVATE_DURATIONS) {
                this._banner.add_child(makeButton(d.label, 'small', () => {
                    this._choosingPrivate = false;
                    this._actions.startPrivate(d.seconds);
                }));
            }
        }
    }

    // Actions

    _activate(index, {plain = false} = {}) {
        const item = this._matches[index];
        if (!item)
            return;
        this.close();
        this._actions.paste(item, {plain});
    }

    _copy(item) {
        this.close();
        this._actions.copy(item);
    }

    _onKeyPress() {
        const [, keysym] = this._keys.get_key();
        const [, pressed, latched, locked] = this._keys.get_state();
        const mods = pressed | latched | locked;
        const ctrl = (mods & Clutter.ModifierType.CONTROL_MASK) !== 0;
        const shift = (mods & Clutter.ModifierType.SHIFT_MASK) !== 0;
        const alt = (mods & Clutter.ModifierType.MOD1_MASK) !== 0;
        const item = this._current();

        const keyNav = index => {
            this._pointerAtKeyNav = global.get_pointer().slice(0, 2);
            this._select(index);
            return Clutter.EVENT_STOP;
        };

        switch (keysym) {
        case Clutter.KEY_Escape:
            if (this._choosingPrivate) {
                this._choosingPrivate = false;
                this._updatePrivateBanner();
            } else if (this._entry.get_text()) {
                this._entry.set_text('');
            } else {
                this.close();
            }
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Down:
        case Clutter.KEY_KP_Down:
            return keyNav(this._selected + 1);
        case Clutter.KEY_Up:
        case Clutter.KEY_KP_Up:
            return keyNav(this._selected - 1);
        case Clutter.KEY_Page_Down:
            return keyNav(this._selected + 8);
        case Clutter.KEY_Page_Up:
            return keyNav(this._selected - 8);
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
        case Clutter.KEY_ISO_Enter:
            this._activate(this._selected, {plain: shift});
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Tab:
        case Clutter.KEY_ISO_Left_Tab: {
            if (this._compact)
                return Clutter.EVENT_STOP;
            const i = FILTERS.findIndex(f => f.id === this._filter);
            const step = keysym === Clutter.KEY_ISO_Left_Tab || shift ? -1 : 1;
            this._setFilter(FILTERS[(i + step + FILTERS.length) % FILTERS.length].id);
            return Clutter.EVENT_STOP;
        }
        case Clutter.KEY_Delete:
        case Clutter.KEY_KP_Delete:
            if (item && (shift || !this._entry.get_text())) {
                this._history.remove(item.id);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }

        if (ctrl && (keysym === Clutter.KEY_p || keysym === Clutter.KEY_P)) {
            if (item)
                this._history.togglePin(item.id);
            return Clutter.EVENT_STOP;
        }
        if (ctrl && (keysym === Clutter.KEY_c || keysym === Clutter.KEY_C) && item && !this._entry.clutter_text.get_selection()) {
            this._copy(item);
            return Clutter.EVENT_STOP;
        }
        if (alt && keysym >= Clutter.KEY_1 && keysym <= Clutter.KEY_9) {
            this._activate(keysym - Clutter.KEY_1);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }
});
