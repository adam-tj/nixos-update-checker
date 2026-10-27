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

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {
    parseLock, uncheckableReason, gitUrlFor, compareUrl, pickRef, gitErrorMessage,
    ageDays, formatAgo, splitList, orderInputs, parseClock, withinWindow,
} from './lock.js';

const GIT_TIMEOUT_SECONDS = 20;

const ICON_NAMES = ['current', 'outdated', 'unknown', 'checking', 'reboot'];

// Run a command and return trimmed stdout.
function run(argv) {
    return new Promise((resolve, reject) => {
        try {
            const proc = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            proc.communicate_utf8_async(null, null, (p, res) => {
                try {
                    const [, out, err] = p.communicate_utf8_finish(res);
                    if (!p.get_successful())
                        reject(new Error(err?.trim() || `${argv[0]} failed`));
                    else
                        resolve((out ?? '').trim());
                } catch (e) {
                    reject(e);
                }
            });
        } catch (e) {
            reject(e);
        }
    });
}

/**
 * Ask a git server for the revisions matching `pattern`, without cloning.
 * No GitHub API quota is involved, and it works for any git host.
 */
function gitLsRemote(url, pattern) {
    return new Promise((resolve, reject) => {
        let proc;
        try {
            const launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
            });
            // Never block waiting for credentials on a private repo.
            launcher.setenv('GIT_TERMINAL_PROMPT', '0', true);
            launcher.setenv('GIT_ASKPASS', '', true);
            launcher.setenv('SSH_ASKPASS', '', true);
            launcher.setenv('GCM_INTERACTIVE', 'never', true);
            proc = launcher.spawnv(['git', 'ls-remote', '--exit-code', url, pattern]);
        } catch (e) {
            reject(new Error('git could not be run'));
            return;
        }

        let timedOut = false;
        const timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, GIT_TIMEOUT_SECONDS, () => {
            timedOut = true;
            proc.force_exit();
            return GLib.SOURCE_REMOVE;
        });

        proc.communicate_utf8_async(null, null, (p, res) => {
            if (!timedOut)
                GLib.source_remove(timeoutId);
            try {
                const [, out, err] = p.communicate_utf8_finish(res);
                if (timedOut) {
                    reject(new Error('timed out'));
                } else if (!p.get_successful()) {
                    reject(new Error(gitErrorMessage(err, p.get_exit_status())));
                } else {
                    resolve(out ?? '');
                }
            } catch (e) {
                reject(e);
            }
        });
    });
}

/** "14:32" for today, "26 Oct 20:15" for anything older. */
function formatStamp(unixSeconds) {
    const when = GLib.DateTime.new_from_unix_local(unixSeconds);
    const now = GLib.DateTime.new_now_local();
    const sameDay = when.get_year() === now.get_year() &&
        when.get_day_of_year() === now.get_day_of_year();
    return when.format(sameDay ? '%H:%M' : '%e %b %H:%M').trim();
}

function readLink(path) {
    try {
        return GLib.file_read_link(path);
    } catch (e) {
        return null;
    }
}

/**
 * Compare the booted system with the current one.
 * A plain rebuild is applied live, so only a changed kernel, initrd or module
 * set actually calls for a reboot.
 */
function rebootStatus() {
    const parts = ['kernel', 'initrd', 'kernel-modules'];
    const booted = parts.map(p => readLink(`/run/booted-system/${p}`));
    const current = parts.map(p => readLink(`/run/current-system/${p}`));
    if (booted.includes(null) || current.includes(null))
        return null;   // not a NixOS layout we understand

    return {
        kernelChanged: parts.some((_, i) => booted[i] !== current[i]),
        systemChanged: readLink('/run/booted-system') !== readLink('/run/current-system'),
    };
}

function readFile(path) {
    return new Promise((resolve, reject) => {
        Gio.File.new_for_path(path).load_contents_async(null, (f, res) => {
            try {
                const [, bytes] = f.load_contents_finish(res);
                resolve(new TextDecoder().decode(bytes));
            } catch (e) {
                reject(e);
            }
        });
    });
}

function expandPath(p) {
    p = p.trim();
    if (p === '~')
        return GLib.get_home_dir();
    if (p.startsWith('~/'))
        return GLib.build_filenamev([GLib.get_home_dir(), p.slice(2)]);
    return p;
}

function lockPathFor(setting) {
    const p = expandPath(setting);
    return p.endsWith('flake.lock') ? p : GLib.build_filenamev([p, 'flake.lock']);
}

/** Short name for a flake, taken from the folder holding its flake.lock. */
function flakeLabel(lockPath) {
    return GLib.path_get_basename(GLib.path_get_dirname(lockPath)) || 'flake';
}

/** Unique across flakes: two flakes may both have an input called nixpkgs. */
function rowKey(row) {
    return row.source ? `${row.source}/${row.name}` : row.name;
}

/**
 * Accept both the current grouped shape and the flat array written by caches
 * from before second-flake support, so an old cache still renders.
 */
function asGroups(value) {
    if (!Array.isArray(value))
        return value ?? null;
    if (value.length && value[0] && !('rows' in value[0]))
        return [{label: null, path: null, rows: value, error: null}];
    return value;
}

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(ext) {
        // 0.5 centres the menu on the icon, as the shell's own indicators do.
        super._init(0.5, 'NixOS Update Checker');
        this._ext = ext;
        this._settings = ext.getSettings();
        this._session = new Soup.Session({timeout: 20, user_agent: 'gnome-nixos-update-checker'});
        this._shaCache = new Map();   // owner/repo@ref -> {sha, etag}
        this._pending = new Map();    // in-flight dedupe
        this._rateLimitedUntil = 0;
        this._lastSystemState = null;
        this._lastInputsKey = '';
        this._notified = new Set();   // inputs already announced while behind
        this._held = [];              // notifications waiting for quiet time to end
        this._overall = 'checking';

        this._icons = {};
        for (const n of ICON_NAMES) {
            this._icons[n] = Gio.FileIcon.new(
                Gio.File.new_for_path(`${ext.path}/icons/${n}-symbolic.svg`));
        }
        this._icon = new St.Icon({gicon: this._icons.checking, style_class: 'system-status-icon'});
        this.add_child(this._icon);

        this._status = new PopupMenu.PopupMenuItem('Checking…', {reactive: false});
        this._local = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._remote = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._checked = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._reboot = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._reboot.visible = false;
        for (const i of [this._status, this._local, this._remote, this._reboot])
            this.menu.addMenuItem(i);

        // Supporting detail, dimmed so the eye lands on the status line.
        // Opacity rather than a colour keeps it right in light and dark themes.
        for (const i of [this._local, this._remote])
            i.label.opacity = 150;

        // Footer styling, matching the version line below it.
        this._checked.label.style = 'font-size: 0.8em;';
        this._checked.label.opacity = 150;


        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._inputsSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._inputsSection);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._compareItem = this.menu.addAction('Show new system commits on GitHub', () => {
            if (this._localHash && this._remoteHash) {
                Gio.AppInfo.launch_default_for_uri(
                    `https://github.com/NixOS/nixpkgs/compare/${this._localHash}...${this._remoteHash}`, null);
            }
        });
        this._compareItem.visible = false;
        this.menu.addAction('Check now', () => this._checkSafely());
        this.menu.addAction('Settings', () => {
            // openPreferences() rejects asynchronously when prefs.js throws;
            // without this the shell logs an unhandled rejection instead.
            try {
                const p = ext.openPreferences();
                if (p?.catch)
                    p.catch(e => console.error(`nixos-update-checker: could not open preferences: ${e}`));
            } catch (e) {
                console.error(`nixos-update-checker: could not open preferences: ${e}`);
            }
        });

        this.menu.addMenuItem(this._checked);
        this._applyFooterVisibility();

        const version = ext.metadata['version-name'] ?? String(ext.metadata.version ?? '');
        if (version) {
            this._versionItem = new PopupMenu.PopupMenuItem(`Version ${version}`, {reactive: false});
            this._versionItem.label.style = 'font-size: 0.8em;';
            this._versionItem.label.opacity = 150;
            this.menu.addMenuItem(this._versionItem);
            this._applyVersionVisibility();
        }

        this._settingsIds = [
            this._settings.connect('changed::interval-minutes', () => this._schedule()),
            this._settings.connect('changed::channel', () => this._checkSoon()),
            this._settings.connect('changed::flake-path', () => this._checkSoon()),
            this._settings.connect('changed::flake-enabled', () => this._checkSoon()),
            this._settings.connect('changed::second-flake-enabled', () => this._checkSoon()),
            this._settings.connect('changed::flake-path-2', () => this._checkSoon()),
            this._settings.connect('changed::ignored-inputs', () => this._checkSoon()),
            this._settings.connect('changed::hide-when-current', () => this._applyVisibility()),
            this._settings.connect('changed::hide-inputs', () => this._rerenderInputs()),
            this._settings.connect('changed::input-order', () => this._rerenderInputs()),
            this._settings.connect('changed::check-reboot', () => {
                this._updateReboot();
                this._rerenderAll();
            }),
            this._settings.connect('changed::color-reboot', () => this._applyStyle()),
            this._settings.connect('changed::hide-system-lines', () => this._rerenderAll()),
            this._settings.connect('changed::show-version', () => this._applyVersionVisibility()),
            this._settings.connect('changed::show-last-checked',
                () => this._applyFooterVisibility()),
            this._settings.connect('changed::cache-results', () => {
                if (!this._settings.get_boolean('cache-results'))
                    this._clearCache();
            }),
            this._settings.connect('changed::only-outdated', () => this._rerenderInputs()),
            this._settings.connect('changed::color-system', () => this._applyStyle()),
            this._settings.connect('changed::color-inputs', () => this._applyStyle()),
        ];

        this._watchNetwork();
        this._schedule();

        // Show what we knew last time, so the menu is useful before the first
        // check completes (or if it never does).
        const cached = this._loadCache();
        if (cached?.sys)
            this._renderCached(cached, 'not yet rechecked');

        // Small delay so login isn't slowed down.
        this._startupId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 10, () => {
            this._startupId = 0;
            this._checkSafely();
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * Re-check when connectivity returns. Waking from suspend looks the same,
     * so this covers that too. The signal is always connected and the setting
     * is read when it fires, so toggling it needs no re-wiring.
     */
    _watchNetwork() {
        this._netMonitor = Gio.NetworkMonitor.get_default();
        this._wasOnline = this._netMonitor.get_network_available();

        this._netId = this._netMonitor.connect('network-changed', (_monitor, available) => {
            const cameBack = available && !this._wasOnline;
            this._wasOnline = available;
            if (!cameBack || !this._settings.get_boolean('recheck-on-network'))
                return;

            // Let the connection settle; this signal often fires several times.
            if (this._netDebounceId)
                GLib.source_remove(this._netDebounceId);
            this._netDebounceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
                this._netDebounceId = 0;
                this._checkSafely();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    _schedule() {
        if (this._timerId)
            GLib.source_remove(this._timerId);
        const mins = this._settings.get_uint('interval-minutes');
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, mins * 60, () => {
            this._checkSafely();
            return GLib.SOURCE_CONTINUE;
        });
    }

    // Settings fields write on every keystroke; wait for typing to stop.
    _checkSoon() {
        if (this._debounceId)
            GLib.source_remove(this._debounceId);
        this._debounceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
            this._debounceId = 0;
            this._checkSafely();
            return GLib.SOURCE_REMOVE;
        });
    }

    _headerInt(msg, name) {
        const v = msg.get_response_headers().get_one(name);
        const n = v ? parseInt(v, 10) : NaN;
        return Number.isFinite(n) ? n : null;
    }

    /**
     * Latest sha of owner/repo@ref, using conditional requests: GitHub does not
     * count 304 replies against the rate limit, so repeat checks are free.
     * Identical requests in one round share a single call.
     */
    _githubSha(owner, repo, ref) {
        const key = `${owner}/${repo}@${ref}`;
        if (this._pending.has(key))
            return this._pending.get(key);

        const promise = (async () => {
            const cached = this._shaCache.get(key);
            const now = GLib.get_real_time() / 1e6;
            if (this._rateLimitedUntil > now) {
                if (cached)
                    return {sha: cached.sha, stale: true};
                const e = new Error('rate limit');
                e.resetAt = this._rateLimitedUntil;
                throw e;
            }

            const msg = Soup.Message.new('GET',
                `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURI(ref)}`);
            const h = msg.get_request_headers();
            h.append('Accept', 'application/vnd.github.sha');
            if (cached?.etag)
                h.append('If-None-Match', cached.etag);

            const bytes = await new Promise((resolve, reject) => {
                this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (sess, res) => {
                    try {
                        resolve(sess.send_and_read_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
            });

            const status = msg.get_status();
            if (status === Soup.Status.NOT_MODIFIED && cached)
                return {sha: cached.sha, stale: false};

            if (status === 403 || status === 429) {
                const reset = this._headerInt(msg, 'x-ratelimit-reset');
                if (this._headerInt(msg, 'x-ratelimit-remaining') === 0 && reset)
                    this._rateLimitedUntil = reset;
                if (cached)
                    return {sha: cached.sha, stale: true};
                const e = new Error('rate limit');
                e.resetAt = reset;
                throw e;
            }
            if (status !== Soup.Status.OK) {
                const e = new Error(`HTTP ${status}`);
                e.status = status;
                throw e;
            }

            const sha = new TextDecoder().decode(bytes.get_data()).trim();
            if (!/^[0-9a-f]{40}$/.test(sha))
                throw new Error('unexpected response');
            this._shaCache.set(key, {sha, etag: msg.get_response_headers().get_one('etag')});
            this._rateLimitedUntil = 0;
            return {sha, stale: false};
        })();

        this._pending.set(key, promise);
        promise.catch(() => {}).then(() => this._pending.delete(key));
        return promise;
    }

    async _fetchText(url, accept = null) {
        const msg = Soup.Message.new('GET', url);
        if (accept)
            msg.get_request_headers().append('Accept', accept);
        const bytes = await new Promise((resolve, reject) => {
            this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (s, res) => {
                try {
                    resolve(s.send_and_read_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
        });
        const status = msg.get_status();
        if (status !== Soup.Status.OK) {
            const err = new Error(`HTTP ${status}`);
            err.status = status;
            throw err;
        }
        return new TextDecoder().decode(bytes.get_data()).trim();
    }

    // ---- system check (nixos-version vs channel) -------------------------
    /**
     * Work out which channel the system follows.
     *
     * nixos-version reports the release the system belongs to; on unstable
     * that is the *next* release, which has no channel yet. So: if a channel
     * exists for that release the system is on stable, and if it 404s the
     * release is still unreleased, which means unstable.
     */
    async _detectChannel(version) {
        if (this._detectedChannel)
            return this._detectedChannel;

        const fallback = 'nixos-unstable';
        // Both "26.11.20261023.3ec6363 (Zokor)" and a bare "24.11 (Vicuna)".
        const m = version.match(/^(\d+\.\d+)/);
        if (!m)
            return fallback;

        let channel;
        try {
            await this._fetchText(`https://channels.nixos.org/nixos-${m[1]}/git-revision`);
            channel = `nixos-${m[1]}`;          // released, so this is a stable system
        } catch (e) {
            if (e.status === 404)
                channel = fallback;             // not released yet, so unstable
            else                                // offline: reuse whatever we found last time
                return this._settings.get_string('detected-channel') || fallback;
        }

        this._detectedChannel = channel;
        this._settings.set_string('detected-channel', channel);
        return channel;
    }

    async _checkSystem() {
        const [localHash, version] = await Promise.all([
            run(['nixos-version', '--hash']),
            run(['nixos-version']),
        ]);
        if (!/^[0-9a-f]{40}$/.test(localHash))
            throw new Error('nixos-version --hash gave no revision (see README)');

        const override = this._settings.get_string('channel').trim();
        const channel = override || await this._detectChannel(version);
        const detected = !override;

        let remoteHash;
        try {
            remoteHash = await this._fetchText(`https://channels.nixos.org/${channel}/git-revision`);
        } catch (e) {
            throw new Error(e.status === 404 ? `channel "${channel}" not found` : e.message);
        }
        if (!/^[0-9a-f]{40}$/.test(remoteHash))
            throw new Error('Unexpected response from channels.nixos.org');

        return {channel, detected, version, localHash, remoteHash, upToDate: localHash === remoteHash};
    }

    // ---- flake input check (flake.lock vs GitHub) -------------------------
    /**
     * Check every configured flake. Returns one group per flake, or null when
     * no flake is configured at all. Each group fails independently, so a
     * broken second flake can't hide the first one's results.
     */
    async _checkInputs(localHash) {
        if (!this._settings.get_boolean('flake-enabled'))
            return null;

        const paths = [this._settings.get_string('flake-path').trim()];
        if (this._settings.get_boolean('second-flake-enabled'))
            paths.push(this._settings.get_string('flake-path-2').trim());

        const configured = paths.filter(Boolean);
        if (!configured.length)
            return null;

        const labelled = configured.length > 1;
        return Promise.all(configured.map(async setting => {
            const path = lockPathFor(setting);
            const label = labelled ? flakeLabel(path) : null;
            try {
                const rows = await this._rowsFor(path, localHash);
                rows.forEach(r => {
                    r.source = label;
                });
                return {label, path, rows, error: null};
            } catch (e) {
                return {label, path, rows: null, error: e.message};
            }
        }));
    }

    async _rowsFor(path, localHash) {
        let text;
        try {
            text = await readFile(path);
        } catch (e) {
            throw new Error(`cannot read ${path}`);
        }
        let inputs;
        try {
            inputs = parseLock(text);
        } catch (e) {
            throw new Error(`${path} is not a valid flake.lock`);
        }

        const ignored = new Set(splitList(this._settings.get_string('ignored-inputs')));
        const now = GLib.get_real_time() / 1e6;
        const haveGit = GLib.find_program_in_path('git') !== null;

        return Promise.all(inputs.map(async input => {
            const row = {
                name: input.name,
                age: formatAgo(ageDays(input.lastModified, now)),
                lastModified: input.lastModified,
                isSystem: !!localHash && input.rev === localHash,
                status: 'current',
                detail: input.ref ?? 'default branch',
                url: null,
                rev: input.rev,
            };
            if (ignored.has(input.name)) {
                row.status = 'ignored';
                return row;
            }
            const why = uncheckableReason(input);
            if (why) {
                row.status = 'unchecked';
                row.detail = why;
                row.pinned = input.pinned;
                return row;
            }
            try {
                const {sha, stale} = haveGit
                    ? {sha: await this._latestViaGit(input), stale: false}
                    : await this._latestViaApi(input);
                if (!/^[0-9a-f]{40}$/.test(sha ?? ''))
                    throw new Error('no revision returned');
                if (sha !== input.rev) {
                    row.status = 'behind';
                    row.url = compareUrl(input, sha);
                }
                row.stale = stale;
            } catch (e) {
                row.status = 'error';
                row.detail = e.resetAt !== undefined
                    ? `GitHub rate limit${e.resetAt ? `, resets ${GLib.DateTime.new_from_unix_local(e.resetAt).format('%H:%M')}` : ''}`
                    : e.status === 404 ? 'branch not found' : e.message;
            }
            return row;
        }));
    }

    // Preferred: no API quota, and works for any git host.
    async _latestViaGit(input) {
        const out = await gitLsRemote(gitUrlFor(input), input.ref ?? 'HEAD');
        return pickRef(out, input.ref);
    }

    // Fallback when git isn't on PATH. GitHub only, with ETag caching.
    _latestViaApi(input) {
        if (input.type !== 'github' || input.host)
            throw new Error('needs git installed');
        return this._githubSha(input.owner, input.repo, input.ref ?? 'HEAD');
    }

    // ---- orchestration ------------------------------------------------
    _checkSafely() {
        this.check().catch(e => console.error(`nixos-update-checker: check failed: ${e}`));
    }

    async check() {
        if (this._checking || this._destroyed)
            return;
        this._checking = true;

        if (this._rendered) {
            // Something useful is already on screen (a cached or earlier
            // result). Swapping the icon to a spinner and back just makes it
            // flicker, so only note the re-check on the timestamp line.
            this._checked.label.text = 'Checking…';
        } else {
            this._overall = 'checking';
            this._icon.gicon = this._icons.checking;
            this._applyStyle();
            this._status.label.text = 'Checking…';
        }

        let sys = null, sysErr = null, rows = null, rowsErr = null;
        try {
            sys = await this._checkSystem();
        } catch (e) {
            sysErr = e;
        }
        try {
            rows = await this._checkInputs(sys?.localHash);
        } catch (e) {
            rowsErr = e;
        }

        // The indicator can be destroyed while a check is in flight (extension
        // disabled, shell restarted); touching its widgets then throws.
        if (this._destroyed) {
            this._checking = false;
            return;
        }

        this._lastResult = {sys, sysErr, rows, rowsErr};
        this._updateReboot();
        try {
            // If the check got nowhere, a remembered result beats a blank menu.
            const cached = sysErr ? this._loadCache() : null;
            if (cached?.sys) {
                this._renderCached(cached, `offline — ${sysErr.message}`);
                return;
            }

            this._render(sys, sysErr, rows, rowsErr);
            this._saveCache(sys, rows);
            const now = GLib.DateTime.new_now_local().format('%H:%M');
            this._checked.label.text = `Last checked: ${now}`;
        } finally {
            this._checking = false;
        }
    }

    _render(sys, sysErr, groupsIn, rowsErr, cached = null) {
        if (this._destroyed)
            return;
        const groups = asGroups(groupsIn);
        const allRows = (groups ?? []).flatMap(g => g.rows ?? []);
        const behind = allRows.filter(r => r.status === 'behind' && !r.isSystem);

        // System lines
        if (sys) {
            this._localHash = sys.localHash;
            this._remoteHash = sys.remoteHash;
            this._local.label.text = `Installed: ${sys.version}  (${sys.localHash.slice(0, 7)})`;
            this._remote.label.text =
                `Latest ${sys.channel}${sys.detected ? ' (detected)' : ''}: ${sys.remoteHash.slice(0, 7)}`;
        } else {
            this._local.label.text = '';
            this._remote.label.text = '';
        }
        this._compareItem.visible = !!sys && !sys.upToDate;

        // Overall state: system behind > inputs behind > current > unknown
        let overall, systemText;
        if (sys && !sys.upToDate) {
            overall = 'outdated';
            systemText = `Update available${this._ageNote(sys.version)}`;
        } else if (sys) {
            systemText = `System up to date with ${sys.channel}`;
            overall = 'current';
        } else {
            systemText = `Could not check system: ${sysErr.message}`;
            overall = 'unknown';
        }
        if (overall !== 'outdated' && behind.length > 0) {
            overall = 'inputs';
            systemText += `; ${behind.length} flake input${behind.length === 1 ? '' : 's'} behind`;
        }
        // Lowest priority: only when nothing is behind.
        if (overall === 'current' && this._rebootNeeded) {
            overall = 'reboot';
            systemText += '; reboot needed';
        }
        if (cached?.note)
            systemText += ` · ${cached.note}`;
        this._status.label.text = systemText;

        // One switch hides the whole system block. The status line survives a
        // failed check, because the error text appears nowhere else.
        const hideLines = this._settings.get_boolean('hide-system-lines');
        this._status.visible = !hideLines || overall === 'unknown';
        this._local.visible = !hideLines && !!sys;
        this._remote.visible = !hideLines && !!sys;
        this._overall = overall;
        this._icon.gicon = this._icons[overall === 'inputs' ? 'outdated' : overall];
        this._applyStyle();

        this._renderInputs(groups, rowsErr, sys);

        // Notifications (only on a change, not at every check). Restoring a
        // cached result is not news: seed the state so a fresh check that
        // confirms it stays quiet too.
        const key = behind.map(rowKey).sort().join(',');
        const behindNames = behind.map(rowKey);

        // An input that is current again may be announced the next time it
        // slips. A failed check is NOT a return to current — treating it as
        // one is what makes a flaky connection re-announce the same input.
        for (const r of allRows) {
            if (r.status === 'current')
                this._notified.delete(rowKey(r));
        }

        if (cached) {
            // Already announced in an earlier session; don't repeat at login.
            behindNames.forEach(n => this._notified.add(n));
        } else if (this._settings.get_boolean('notify')) {
            if (!this._inQuietHours())
                this._flushHeld();

            if (sys && !sys.upToDate && this._lastSystemState !== 'outdated')
                this._notify('NixOS update available', `A newer ${sys.channel} revision is out${this._ageNote(sys.version)}.`);

            if (this._settings.get_boolean('notify-per-episode')) {
                const fresh = behindNames.filter(n => !this._notified.has(n));
                if (fresh.length)
                    this._notify('Flake inputs behind', fresh.join(', '));
            } else if (key && key !== this._lastInputsKey) {
                this._notify('Flake inputs behind', behindNames.join(', '));
            }
            behindNames.forEach(n => this._notified.add(n));
        }
        this._lastInputsKey = key;
        this._lastSystemState = sys ? (sys.upToDate ? 'current' : 'outdated') : 'unknown';
        this._rendered = true;
        this._applyVisibility();
    }

    _ageNote(version) {
        // nixos-version looks like "26.11.20261020.abc1234 (Name)"; pull the date.
        const m = version.match(/\.(\d{4})(\d{2})(\d{2})\./);
        if (!m)
            return '';
        const built = GLib.DateTime.new_local(+m[1], +m[2], +m[3], 0, 0, 0);
        const days = Math.floor(GLib.DateTime.new_now_local().difference(built) / 86400e6);
        return ` — your nixpkgs is ${days} day${days === 1 ? '' : 's'} old`;
    }

    // ---- persistent cache of the last result -----------------------------
    _cachePath() {
        return GLib.build_filenamev(
            [GLib.get_user_cache_dir(), 'nixos-update-checker', 'last-result.json']);
    }

    _saveCache(sys, rows) {
        if (!this._settings.get_boolean('cache-results') || (!sys && !rows))
            return;
        try {
            const path = this._cachePath();
            GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
            const json = JSON.stringify({
                savedAt: Math.floor(GLib.get_real_time() / 1e6),
                sys, rows,
            });
            // Encode explicitly: file_set_contents takes bytes, and passing a
            // plain string is not reliably marshalled.
            GLib.file_set_contents(path, new TextEncoder().encode(json));
        } catch (e) {
            // Best effort, but say so rather than failing silently.
            console.warn(`nixos-update-checker: could not write cache: ${e}`);
        }
    }

    _loadCache() {
        if (!this._settings.get_boolean('cache-results'))
            return null;
        try {
            const [ok, bytes] = GLib.file_get_contents(this._cachePath());
            if (!ok)
                return null;
            const data = JSON.parse(new TextDecoder().decode(bytes));
            return typeof data?.savedAt === 'number' ? data : null;
        } catch (e) {
            // A missing file on first run is normal and not worth reporting.
            if (!(e instanceof GLib.FileError) && e?.code !== GLib.FileError.NOENT)
                console.warn(`nixos-update-checker: could not read cache: ${e}`);
            return null;
        }
    }

    _clearCache() {
        try {
            GLib.unlink(this._cachePath());
        } catch (e) {
            // nothing to clean up
        }
    }

    /** Show the previous result straight away, clearly marked as not rechecked. */
    _renderCached(cached, note) {
        // Ages are relative, so recompute rather than replaying stale strings.
        const now = GLib.get_real_time() / 1e6;
        const groups = asGroups(cached.rows)?.map(g => ({
            ...g,
            rows: g.rows?.map(r => ({
                ...r,
                age: formatAgo(ageDays(r.lastModified, now)),
            })) ?? null,
        })) ?? null;

        this._updateReboot();
        this._render(cached.sys, null, groups, null, {note});
        this._checked.label.text = `Last checked: ${formatStamp(cached.savedAt)}`;
    }

    // Local and instant: no network, no flake.lock.
    _updateReboot() {
        if (this._destroyed)
            return;
        if (!this._settings.get_boolean('check-reboot')) {
            this._rebootNeeded = false;
            this._reboot.visible = false;
            return;
        }
        const st = rebootStatus();
        this._rebootNeeded = !!st?.kernelChanged;
        this._reboot.label.text = '⚠ Reboot needed — kernel changed since boot';
        this._reboot.visible = this._rebootNeeded;
    }

    _inQuietHours() {
        if (!this._settings.get_boolean('quiet-hours'))
            return false;
        const from = parseClock(this._settings.get_string('quiet-from'));
        const to = parseClock(this._settings.get_string('quiet-to'));
        if (from === null || to === null)
            return false;       // unparseable window: never suppress
        const now = GLib.DateTime.new_now_local();
        return withinWindow(now.get_hour() * 60 + now.get_minute(), from, to);
    }

    /** Hold rather than drop: a held notice is delivered once quiet time ends. */
    _notify(title, body) {
        if (!this._inQuietHours()) {
            Main.notify(title, body);
            return;
        }
        const key = `${title}\n${body}`;
        if (!this._held.some(h => h.key === key))
            this._held.push({key, title, body});
    }

    _flushHeld() {
        if (!this._held.length)
            return;
        const held = this._held;
        this._held = [];
        for (const h of held)
            Main.notify(h.title, h.body);
    }

    /** Redraw from the last result, without re-notifying. */
    _rerenderAll() {
        const last = this._lastResult;
        if (last)
            this._render(last.sys, last.sysErr, last.rows, last.rowsErr, {note: null});
    }

    _rerenderInputs() {
        const last = this._lastResult;
        if (last)
            this._renderInputs(last.rows, last.rowsErr, last.sys);
    }

    _renderInputs(groups, rowsErr, sys) {
        if (this._destroyed)
            return;
        this._inputsSection.removeAll();
        if (this._settings.get_boolean('hide-inputs'))
            return;

        const add = (text, url = null) => {
            const item = new PopupMenu.PopupMenuItem(text, {reactive: !!url});
            if (url)
                item.connect('activate', () => Gio.AppInfo.launch_default_for_uri(url, null));
            this._inputsSection.addMenuItem(item);
        };
        const heading = text => {
            const item = new PopupMenu.PopupMenuItem(text, {reactive: false});
            item.label.style = 'font-weight: bold;';
            this._inputsSection.addMenuItem(item);
        };

        if (rowsErr) {
            add(`Flake inputs: ${rowsErr.message}`);
            return;
        }
        if (groups === null) {
            add('Flake inputs: set your flake folder in Settings');
            return;
        }

        const onlyOutdated = this._settings.get_boolean('only-outdated');
        const order = this._settings.get_string('input-order');

        // Work out what each flake would show before drawing anything, so a
        // flake with nothing to report can be left out entirely.
        const sections = groups.map(g => {
            if (g.error)
                return {group: g, lines: null, failed: 0, note: g.error};

            const tracked = (g.rows ?? []).filter(r => r.status !== 'ignored' && !r.pinned);
            const failed = tracked.filter(r => r.status === 'error').length;
            if (!g.rows?.length)
                return {group: g, lines: [], failed: 0, note: 'none found in flake.lock'};
            if (!tracked.length)
                return {group: g, lines: [], failed: 0, note: 'all inputs are ignored or pinned'};

            const shown = onlyOutdated ? tracked.filter(r => r.status === 'behind') : tracked;
            return {group: g, lines: orderInputs(shown, order), failed, note: null};
        });

        const worthShowing = s =>
            s.note !== null || s.lines.length > 0 || (onlyOutdated ? s.failed > 0 : true);

        const visible = sections.filter(worthShowing);
        if (!visible.length)
            return;

        const multiple = groups.length > 1;
        for (const section of visible) {
            const {group: g, lines, failed, note} = section;
            heading(multiple ? `Flake inputs — ${g.label}` : 'Flake inputs');

            if (note !== null) {
                add(note);
                continue;
            }
            if (onlyOutdated && lines.length === 0)
                add('No inputs behind');

            for (const r of lines) {
                const tag = r.isSystem ? '  [system]' : '';
                switch (r.status) {
                case 'current':
                    add(`✓ ${r.name}${tag}  (upstream last changed ${r.age})${r.stale ? '  · cached' : ''}`);
                    break;
                case 'behind':
                    add(`⬆ ${r.name}${tag}  behind ${r.detail} — locked ${r.age}${r.url ? ' (open diff)' : ''}`, r.url);
                    break;
                case 'error':
                    add(`? ${r.name}${tag}  ${r.detail}`);
                    break;
                default:
                    add(`· ${r.name}${tag}  unchecked (${r.detail})`);
                }
            }

            // Don't let "only outdated" silently swallow failed checks.
            if (onlyOutdated && failed)
                add(`? ${failed} input${failed === 1 ? '' : 's'} could not be checked`);
        }

        // If nothing in any lock matches the running system, the lock has
        // probably moved on without a rebuild. Identify by revision, since the
        // input that builds the system may have any name.
        const allRows = groups.flatMap(g => g.rows ?? []);
        if (sys && allRows.length && !allRows.some(r => r.rev === sys.localHash)) {
            add(`⚠ No input matches the running system (${sys.localHash.slice(0, 7)}) — lock updated without a rebuild?`);
        }
    }

    _applyFooterVisibility() {
        this._checked.visible = this._settings.get_boolean('show-last-checked');
    }

    _applyVersionVisibility() {
        if (this._versionItem)
            this._versionItem.visible = this._settings.get_boolean('show-version');
    }

    _applyStyle() {
        let color = null;
        if (this._overall === 'outdated')
            color = this._settings.get_string('color-system');
        else if (this._overall === 'inputs')
            color = this._settings.get_string('color-inputs');
        else if (this._overall === 'reboot')
            color = this._settings.get_string('color-reboot');
        this._icon.style = color ? `color: ${color};` : null;
    }

    _applyVisibility() {
        this.visible = !(this._settings.get_boolean('hide-when-current') && this._overall === 'current');
    }

    destroy() {
        this._destroyed = true;
        if (this._timerId)
            GLib.source_remove(this._timerId);
        if (this._startupId)
            GLib.source_remove(this._startupId);
        if (this._debounceId)
            GLib.source_remove(this._debounceId);
        if (this._netDebounceId)
            GLib.source_remove(this._netDebounceId);
        if (this._netId)
            this._netMonitor.disconnect(this._netId);
        this._settingsIds?.forEach(id => this._settings.disconnect(id));
        this._session?.abort();
        this._session = null;
        super.destroy();
    }
});

export default class NixosUpdateChecker extends Extension {
    enable() {
        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
