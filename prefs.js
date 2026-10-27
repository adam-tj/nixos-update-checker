/*
 * NixOS Update Checker — a GNOME Shell extension
 *
 * Copyright (C) 2026 Adam Tjörnhammar (@adam-tj)
 *
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program; if not, write to the Free Software
 * Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {parseLock, unknownOrderNames, parseClock, formatClock} from './lock.js';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

function colorRow(settings, key, title, subtitle = '') {
    const row = new Adw.ActionRow({title, subtitle});
    const button = new Gtk.ColorDialogButton({
        dialog: new Gtk.ColorDialog(),
        valign: Gtk.Align.CENTER,
    });

    // The button has to follow the setting, not just write to it, or a reset
    // would change the stored colour while the swatch kept the old one.
    let updating = false;
    const fromSettings = () => {
        const rgba = new Gdk.RGBA();
        if (rgba.parse(settings.get_string(key))) {
            updating = true;
            button.set_rgba(rgba);
            updating = false;
        }
    };
    fromSettings();

    button.connect('notify::rgba', () => {
        if (!updating)
            settings.set_string(key, button.get_rgba().to_string());
    });
    settings.connect(`changed::${key}`, fromSettings);

    row.add_suffix(button);
    row.add_suffix(resetButton(settings, key));
    row.activatable_widget = button;
    return row;
}

/** A revert suffix button, enabled only while the key differs from its default. */
function resetButton(settings, key) {
    const button = new Gtk.Button({
        icon_name: 'edit-clear-symbolic',
        valign: Gtk.Align.CENTER,
        tooltip_text: 'Reset to default value',
    });
    button.add_css_class('flat');

    const sync = () => {
        // Compare as text: avoids relying on GVariant equality bindings.
        button.sensitive = settings.get_value(key).print(true) !==
            settings.get_default_value(key).print(true);
    };
    settings.connect(`changed::${key}`, sync);
    sync();

    button.connect('clicked', () => settings.reset(key));
    return button;
}

/** A folder-picker suffix that writes the chosen path into `entry`. */
function folderButton(window, entry, title) {
    const button = new Gtk.Button({
        icon_name: 'folder-symbolic',
        valign: Gtk.Align.CENTER,
        tooltip_text: 'Choose folder',
    });
    button.add_css_class('flat');
    button.connect('clicked', () => {
        const dialog = new Gtk.FileDialog({title});
        dialog.select_folder(window, null, (d, res) => {
            try {
                const folder = d.select_folder_finish(res);
                if (folder?.get_path())
                    entry.text = folder.get_path();
            } catch (e) {
                // dialog cancelled
            }
        });
    });
    return button;
}

function caption() {
    const label = new Gtk.Label({wrap: true, xalign: 0, margin_start: 12, margin_bottom: 6});
    label.add_css_class('dim-label');
    label.add_css_class('caption');
    return label;
}

export default class Prefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        // Big enough to show the Settings tab without scrolling. GTK shrinks
        // this to fit if the display is smaller.
        window.set_default_size(660, 940);

        window.add(this._settingsPage(settings, window));
        window.add(this._flakePage(settings, window));
        window.add(this._appearancePage(settings));
        window.add(this._aboutPage(settings));
    }

    _settingsPage(settings, window) {
        const page = new Adw.PreferencesPage({
            title: 'Settings',
            icon_name: 'preferences-system-symbolic',
        });

        // --- System -------------------------------------------------------
        const sys = new Adw.PreferencesGroup({
            title: 'System',
            description: 'Compares nixos-version --hash with the latest revision of a channel.',
        });
        page.add(sys);

        // Empty means "follow the detected channel", which is shown as ghost
        // text. A Gtk.Entry is used because Adw.EntryRow has no placeholder.
        const channelRow = new Adw.ActionRow({
            title: 'Channel',
            subtitle: 'Leave empty to follow the detected channel',
        });

        const ghost = () => settings.get_string('detected-channel') || 'detecting…';
        const channelEntry = new Gtk.Entry({
            text: settings.get_string('channel'),
            placeholder_text: ghost(),
            valign: Gtk.Align.CENTER,
            hexpand: true,
            width_chars: 20,
        });

        const applyBtn = new Gtk.Button({label: 'Apply', valign: Gtk.Align.CENTER});
        const clearBtn = new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Reset to default value',
        });
        clearBtn.add_css_class('flat');

        const syncButtons = () => {
            const stored = settings.get_string('channel');
            applyBtn.sensitive = channelEntry.text.trim() !== stored;
            clearBtn.sensitive = stored !== '' || channelEntry.text !== '';
        };
        const applyChannel = () => {
            settings.set_string('channel', channelEntry.text.trim());
            syncButtons();
        };

        applyBtn.connect('clicked', applyChannel);
        channelEntry.connect('activate', applyChannel);        // Enter applies too
        channelEntry.connect('notify::text', syncButtons);
        clearBtn.connect('clicked', () => {
            channelEntry.text = '';
            settings.reset('channel');
            syncButtons();
        });
        settings.connect('changed::channel', syncButtons);
        settings.connect('changed::detected-channel', () => {
            channelEntry.placeholder_text = ghost();
        });
        syncButtons();

        channelRow.add_suffix(channelEntry);
        channelRow.add_suffix(applyBtn);
        channelRow.add_suffix(clearBtn);
        sys.add(channelRow);

        const reboot = new Adw.SwitchRow({
            title: 'Warn when a reboot is needed',
            subtitle: 'Shows a line in the menu when the booted kernel is older than the current system.',
        });
        settings.bind('check-reboot', reboot, 'active', Gio.SettingsBindFlags.DEFAULT);
        sys.add(reboot);

        // --- Checking ---------------------------------------------------------
        const checking = new Adw.PreferencesGroup({title: 'Checking'});
        page.add(checking);

        const interval = new Adw.SpinRow({
            title: 'Check every (minutes)',
            subtitle: 'Checks also run at login.',
            adjustment: new Gtk.Adjustment({lower: 5, upper: 1440, step_increment: 5}),
        });
        settings.bind('interval-minutes', interval, 'value', Gio.SettingsBindFlags.DEFAULT);
        interval.add_suffix(resetButton(settings, 'interval-minutes'));
        checking.add(interval);

        const recheck = new Adw.SwitchRow({
            title: 'Re-check when the network comes back',
            subtitle: 'Also covers waking from suspend.',
        });
        settings.bind('recheck-on-network', recheck, 'active', Gio.SettingsBindFlags.DEFAULT);
        checking.add(recheck);

        const cache = new Adw.SwitchRow({
            title: 'Remember the last result between sessions',
            subtitle: 'Shows the previous state immediately at login, marked as not yet rechecked.',
        });
        settings.bind('cache-results', cache, 'active', Gio.SettingsBindFlags.DEFAULT);
        checking.add(cache);

        // --- Notifications ----------------------------------------------------
        const notifications = new Adw.PreferencesGroup({title: 'Notifications'});
        page.add(notifications);

        const notify = new Adw.SwitchRow({
            title: 'Notify when something falls behind',
            subtitle: 'Sent only when the state changes, never at every check.',
        });
        settings.bind('notify', notify, 'active', Gio.SettingsBindFlags.DEFAULT);
        notifications.add(notify);

        const perEpisode = new Adw.SwitchRow({
            title: 'Announce each input only once',
            subtitle: 'Stays quiet about an input already reported, until it is up to date again.',
        });
        settings.bind('notify-per-episode', perEpisode, 'active', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('notify', perEpisode, 'sensitive', Gio.SettingsBindFlags.GET);
        notifications.add(perEpisode);

        const quiet = new Adw.SwitchRow({
            title: 'Quiet hours',
            subtitle: 'Notifications are held during this window and delivered after it.',
        });
        settings.bind('quiet-hours', quiet, 'active', Gio.SettingsBindFlags.DEFAULT);
        notifications.add(quiet);

        const quietFrom = new Adw.EntryRow({title: 'Quiet from (HH:MM)'});
        settings.bind('quiet-from', quietFrom, 'text', Gio.SettingsBindFlags.DEFAULT);
        quietFrom.add_suffix(resetButton(settings, 'quiet-from'));
        notifications.add(quietFrom);

        const quietTo = new Adw.EntryRow({title: 'Quiet until (HH:MM)'});
        settings.bind('quiet-to', quietTo, 'text', Gio.SettingsBindFlags.DEFAULT);
        quietTo.add_suffix(resetButton(settings, 'quiet-to'));
        notifications.add(quietTo);

        const quietHint = caption();
        notifications.add(quietHint);

        const syncQuiet = () => {
            const on = settings.get_boolean('quiet-hours');
            quietFrom.sensitive = on;
            quietTo.sensitive = on;
            quietHint.visible = on;

            const from = parseClock(settings.get_string('quiet-from'));
            const to = parseClock(settings.get_string('quiet-to'));
            if (from === null || to === null)
                quietHint.label = 'Times must look like 22:00. Notifications are not held until both are valid.';
            else if (from === to)
                quietHint.label = 'Start and end are the same, so nothing is held.';
            else
                quietHint.label = `Holding notifications ${formatClock(from)} → ${formatClock(to)}${from > to ? ' (overnight)' : ''}.`;
        };
        for (const k of ['quiet-hours', 'quiet-from', 'quiet-to'])
            settings.connect(`changed::${k}`, syncQuiet);
        syncQuiet();

        // --- Reset ------------------------------------------------------------
        const reset = new Adw.PreferencesGroup();
        page.add(reset);

        const resetRow = new Adw.ActionRow({
            title: 'Reset all settings',
            subtitle: 'Returns every setting on every tab to its default.',
        });
        const resetAllBtn = new Gtk.Button({label: 'Reset…', valign: Gtk.Align.CENTER});
        resetAllBtn.add_css_class('destructive-action');
        resetRow.add_suffix(resetAllBtn);
        reset.add(resetRow);

        resetAllBtn.connect('clicked', () => {
            const dialog = new Adw.MessageDialog({
                transient_for: window,
                modal: true,
                heading: 'Reset all settings?',
                body: 'Every setting on every tab returns to its default, ' +
                    'including your flake folders and channel override. ' +
                    'This cannot be undone.',
            });
            dialog.add_response('cancel', 'Cancel');
            dialog.add_response('reset', 'Reset');
            dialog.set_response_appearance('reset', Adw.ResponseAppearance.DESTRUCTIVE);
            dialog.set_default_response('cancel');
            dialog.set_close_response('cancel');
            dialog.connect('response', (_d, response) => {
                if (response !== 'reset')
                    return;
                for (const key of settings.list_keys())
                    settings.reset(key);
                // Bound widgets follow automatically; this entry is manual.
                channelEntry.text = '';
                syncButtons();
            });
            dialog.present();
        });

        return page;
    }

    _flakePage(settings, window) {
        const page = new Adw.PreferencesPage({
            title: 'Flake inputs',
            icon_name: 'package-x-generic-symbolic',
        });

        const flake = new Adw.PreferencesGroup({
            title: 'Flake inputs',
            description: 'Compares each input in your flake.lock with its branch upstream.',
        });
        page.add(flake);

        const enabled = new Adw.SwitchRow({
            title: 'Check flake inputs',
            subtitle: 'Compares the inputs in your flake.lock with their branches upstream.',
        });
        settings.bind('flake-enabled', enabled, 'active', Gio.SettingsBindFlags.DEFAULT);
        flake.add(enabled);

        const path = new Adw.EntryRow({title: 'Flake folder or flake.lock (e.g. ~/nixos-config)'});
        settings.bind('flake-path', path, 'text', Gio.SettingsBindFlags.DEFAULT);
        path.add_suffix(folderButton(window, path, 'Choose your flake folder'));
        flake.add(path);

        const second = new Adw.SwitchRow({
            title: 'Check a second flake',
            subtitle: 'Watches a second flake.lock, listed under its own heading.',
        });
        settings.bind('second-flake-enabled', second, 'active', Gio.SettingsBindFlags.DEFAULT);
        flake.add(second);

        const path2 = new Adw.EntryRow({title: 'Second flake folder or flake.lock'});
        settings.bind('flake-path-2', path2, 'text', Gio.SettingsBindFlags.DEFAULT);
        path2.add_suffix(folderButton(window, path2, 'Choose your second flake folder'));
        flake.add(path2);

        const ignored = new Adw.EntryRow({title: 'Ignored inputs (comma-separated names)'});
        settings.bind('ignored-inputs', ignored, 'text', Gio.SettingsBindFlags.DEFAULT);
        ignored.add_suffix(resetButton(settings, 'ignored-inputs'));
        flake.add(ignored);

        const order = new Adw.EntryRow({
            title: 'Input order (comma-separated names)',
        });
        settings.bind('input-order', order, 'text', Gio.SettingsBindFlags.DEFAULT);
        order.add_suffix(resetButton(settings, 'input-order'));
        flake.add(order);

        // Flag names that match no input, since a typo would otherwise do
        // nothing at all and give no clue why.
        const orderHint = caption();
        flake.add(orderHint);

        const checkOrder = () => {
            let unknown = [];
            try {
                const configured = settings.get_string('flake-path').trim();
                if (configured) {
                    const full = configured.replace(/^~(?=\/|$)/, GLib.get_home_dir());
                    const file = full.endsWith('flake.lock')
                        ? full : GLib.build_filenamev([full, 'flake.lock']);
                    const [ok, bytes] = GLib.file_get_contents(file);
                    if (ok) {
                        unknown = unknownOrderNames(
                            settings.get_string('input-order'),
                            parseLock(new TextDecoder().decode(bytes)));
                    }
                }
            } catch (e) {
                unknown = [];   // no lock file to check against; say nothing
            }
            orderHint.label = unknown.length
                ? `Not found in flake.lock: ${unknown.join(', ')}`
                : '"system" means whichever input built your system. ' +
                  'Unlisted inputs follow alphabetically; use * to place them.';
        };
        settings.connect('changed::input-order', checkOrder);
        settings.connect('changed::flake-path', checkOrder);
        checkOrder();

        // --- Display ----------------------------------------------------------
        // Separate group: these change what the menu shows, not whether the
        // checking happens at all.
        const display = new Adw.PreferencesGroup({
            title: 'Display',
            description: 'What the menu shows. Checking still happens either way.',
        });
        page.add(display);

        const onlyOutdated = new Adw.SwitchRow({
            title: 'Only list inputs that are behind',
            subtitle: 'Up-to-date inputs are left out of the menu.',
        });
        settings.bind('only-outdated', onlyOutdated, 'active', Gio.SettingsBindFlags.DEFAULT);
        display.add(onlyOutdated);

        const hideInputs = new Adw.SwitchRow({
            title: 'Hide the input list entirely',
            subtitle: 'Inputs are still checked, and the icon still changes colour.',
        });
        settings.bind('hide-inputs', hideInputs, 'active', Gio.SettingsBindFlags.DEFAULT);
        display.add(hideInputs);

        // "Only show outdated" has no effect while the whole list is hidden.
        hideInputs.bind_property('active', onlyOutdated, 'sensitive',
            GObject.BindingFlags.SYNC_CREATE | GObject.BindingFlags.INVERT_BOOLEAN);

        // Everything below the master switch depends on it; the second path
        // needs both switches on.
        const syncEnabled = () => {
            const on = settings.get_boolean('flake-enabled');
            for (const row of [path, second, ignored, order])
                row.sensitive = on;
            path2.sensitive = on && settings.get_boolean('second-flake-enabled');
            orderHint.sensitive = on;
            display.sensitive = on;
        };
        settings.connect('changed::flake-enabled', syncEnabled);
        settings.connect('changed::second-flake-enabled', syncEnabled);
        syncEnabled();

        return page;
    }

    _appearancePage(settings) {
        const page = new Adw.PreferencesPage({
            title: 'Appearance',
            icon_name: 'preferences-desktop-appearance-symbolic',
        });

        // The three colours stay together: they are a set, and picking them
        // apart from each other makes them hard to tell apart.
        const icon = new Adw.PreferencesGroup({
            title: 'Panel icon',
            description: 'In order of priority: system, then flake inputs, then reboot.',
        });
        page.add(icon);

        icon.add(colorRow(settings, 'color-system',
            'Icon colour when the system is behind'));
        icon.add(colorRow(settings, 'color-inputs',
            'Icon colour when only flake inputs are behind',
            'One colour for all inputs, shown when the system itself is up to date.'));

        const rebootColor = colorRow(settings, 'color-reboot',
            'Icon colour when a reboot is needed',
            'Only used while "Warn when a reboot is needed" is on.');
        settings.bind('check-reboot', rebootColor, 'sensitive', Gio.SettingsBindFlags.GET);
        icon.add(rebootColor);

        const hide = new Adw.SwitchRow({
            title: 'Hide icon while everything is up to date',
            subtitle: 'The icon returns as soon as anything needs attention.',
        });
        settings.bind('hide-when-current', hide, 'active', Gio.SettingsBindFlags.DEFAULT);
        icon.add(hide);

        // --- Menu -------------------------------------------------------------
        const menu = new Adw.PreferencesGroup({
            title: 'Menu',
            description: 'What appears when you click the icon.',
        });
        page.add(menu);

        const hideLines = new Adw.SwitchRow({
            title: 'Hide the system lines in the menu',
            subtitle: 'The status, installed and latest lines. ' +
                'The status line still appears if a check fails.',
        });
        settings.bind('hide-system-lines', hideLines, 'active', Gio.SettingsBindFlags.DEFAULT);
        menu.add(hideLines);

        const lastChecked = new Adw.SwitchRow({
            title: 'Show the last-checked time in the menu',
            subtitle: 'The small line under Settings.',
        });
        settings.bind('show-last-checked', lastChecked, 'active', Gio.SettingsBindFlags.DEFAULT);
        menu.add(lastChecked);

        return page;
    }

    _aboutPage(settings) {
        const page = new Adw.PreferencesPage({
            title: 'About',
            icon_name: 'help-about-symbolic',
        });

        const version = this.metadata['version-name'] ??
            String(this.metadata.version ?? 'unknown');
        const repo = 'https://github.com/adam-tj/nixos-update-checker';

        // --- Heading: name, author, repository link ---------------------------
        const heading = new Adw.PreferencesGroup();
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            halign: Gtk.Align.CENTER,
            margin_top: 12,
            margin_bottom: 18,
        });

        const name = new Gtk.Label({label: 'NixOS Update Checker'});
        name.add_css_class('title-1');
        box.append(name);

        const author = new Gtk.Label({label: 'Adam Tjörnhammar'});
        author.add_css_class('title-4');
        author.set_margin_top(6);
        box.append(author);

        const handle = new Gtk.Label({label: '@adam-tj'});
        handle.add_css_class('dim-label');
        box.append(handle);

        const link = new Gtk.LinkButton({
            label: 'GitHub Repository',
            uri: repo,
            halign: Gtk.Align.CENTER,
            margin_top: 6,
        });
        box.append(link);

        heading.add(box);
        page.add(heading);

        // --- Version ----------------------------------------------------------
        const info = new Adw.PreferencesGroup();
        const versionRow = new Adw.ActionRow({title: 'Version'});
        const versionLabel = new Gtk.Label({label: version, valign: Gtk.Align.CENTER});
        versionLabel.add_css_class('dim-label');
        versionRow.add_suffix(versionLabel);
        info.add(versionRow);

        const showVersion = new Adw.SwitchRow({
            title: 'Show the version in the menu',
            subtitle: 'The small line under Settings when you click the icon.',
        });
        settings.bind('show-version', showVersion, 'active', Gio.SettingsBindFlags.DEFAULT);
        info.add(showVersion);

        const licenseRow = new Adw.ActionRow({title: 'License'});
        const licenseName = new Gtk.Label({
            label: 'GPL-2.0-or-later',
            valign: Gtk.Align.CENTER,
        });
        licenseName.add_css_class('dim-label');
        licenseRow.add_suffix(licenseName);
        info.add(licenseRow);
        page.add(info);

        // --- License ----------------------------------------------------------
        const licenseGroup = new Adw.PreferencesGroup({title: 'License'});
        const card = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        card.add_css_class('card');
        const licenseLabel = new Gtk.Label({
            label: 'Copyright © 2026 Adam Tjörnhammar\n\n' +
                'This program is free software; you can redistribute it and/or ' +
                'modify it under the terms of the GNU General Public License as ' +
                'published by the Free Software Foundation; either version 2 of ' +
                'the License, or (at your option) any later version.\n\n' +
                'This program is distributed in the hope that it will be useful, ' +
                'but WITHOUT ANY WARRANTY; without even the implied warranty of ' +
                'MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the ' +
                'GNU General Public License for more details.\n\n' +
                'A copy of the licence is included with the extension as the ' +
                'LICENSE.md file.',
            wrap: true,
            xalign: 0,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 12,
            margin_end: 12,
        });
        licenseLabel.add_css_class('dim-label');
        card.append(licenseLabel);

        const licenseLink = new Gtk.LinkButton({
            label: 'Read the full licence',
            uri: 'https://www.gnu.org/licenses/old-licenses/gpl-2.0.html',
            halign: Gtk.Align.CENTER,
            margin_bottom: 6,
        });
        card.append(licenseLink);

        licenseGroup.add(card);
        page.add(licenseGroup);

        return page;
    }
}
