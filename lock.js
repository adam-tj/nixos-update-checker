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

// Pure helpers (no GNOME imports) so they can be unit-tested with node.

/**
 * Read the top-level inputs of a flake.lock.
 * Inputs that are just "follows" aliases (arrays) are skipped.
 */
export function parseLock(text) {
    const lock = JSON.parse(text);
    const root = lock.nodes?.[lock.root];
    const out = [];
    for (const [name, target] of Object.entries(root?.inputs ?? {})) {
        if (typeof target !== 'string')
            continue;
        const node = lock.nodes?.[target];
        if (!node?.locked)
            continue;
        const l = node.locked;
        const o = node.original ?? {};
        out.push({
            name,
            type: l.type,
            owner: l.owner ?? null,
            repo: l.repo ?? null,
            host: l.host ?? null,
            url: l.url ?? null,
            rev: l.rev ?? null,
            lastModified: l.lastModified ?? null,
            ref: o.ref ?? l.ref ?? null,
            pinned: !!o.rev,
        });
    }
    return out;
}

/** The git URL to ask for the branch head, or null if we can't work one out. */
export function gitUrlFor(input) {
    switch (input.type) {
    case 'github':
        return input.owner && input.repo
            ? `https://${input.host ?? 'github.com'}/${input.owner}/${input.repo}.git` : null;
    case 'gitlab':
        return input.owner && input.repo
            ? `https://${input.host ?? 'gitlab.com'}/${input.owner}/${input.repo}.git` : null;
    case 'sourcehut':
        return input.owner && input.repo
            ? `https://${input.host ?? 'git.sr.ht'}/${input.owner}/${input.repo}` : null;
    case 'git':
        // nix writes these as git+https://… or a plain URL
        return input.url ? input.url.replace(/^git\+/, '') : null;
    default:
        return null;
    }
}

/** Can we compare this input at all? Returns null if yes, else the reason. */
export function uncheckableReason(input) {
    if (input.pinned)
        return 'pinned to a revision';
    if (!input.rev)
        return 'no revision in lock';
    if (!gitUrlFor(input))
        return `not a git input (${input.type ?? 'unknown'})`;
    return null;
}

/** Web link showing what changed, where the host supports one. */
export function compareUrl(input, latest) {
    if (input.type === 'github')
        return `https://${input.host ?? 'github.com'}/${input.owner}/${input.repo}/compare/${input.rev}...${latest}`;
    if (input.type === 'gitlab')
        return `https://${input.host ?? 'gitlab.com'}/${input.owner}/${input.repo}/-/compare/${input.rev}...${latest}`;
    return null;
}

/**
 * Pick the right sha out of `git ls-remote` output.
 * Lines look like: "<sha>\trefs/heads/main"
 */
export function pickRef(output, ref) {
    const lines = (output ?? '').trim().split('\n').filter(Boolean)
        .map(l => l.split(/\s+/));
    if (!lines.length)
        return null;
    const find = name => lines.find(([, n]) => n === name);
    if (!ref)
        return (find('HEAD') ?? lines[0])[0];
    // Prefer a branch, then an annotated tag's target, then a plain tag.
    const hit = find(`refs/heads/${ref}`) ?? find(`refs/tags/${ref}^{}`) ??
        find(`refs/tags/${ref}`) ?? lines[0];
    return hit[0];
}

/** Turn git's stderr into something that fits in a menu row. */
export function gitErrorMessage(stderr, exitCode) {
    const text = (stderr ?? '').trim();
    if (exitCode === 2 || /unable to find remote (?:helper|ref)/i.test(text))
        return 'branch not found';
    // GitHub prompts for credentials for private *and* non-existent repos,
    // so these cannot be told apart from the client side.
    if (/could not read Username|Authentication failed|terminal prompts disabled|Permission denied/i.test(text))
        return 'private or missing repo';
    if (/not found|does not exist|HTTP 404/i.test(text))
        return 'repo not found';
    if (/Could not resolve host|unable to access|Connection (?:timed out|refused)|network/i.test(text))
        return 'network error';
    const first = text.split('\n').find(l => l.trim()) ?? 'git ls-remote failed';
    return first.length > 60 ? `${first.slice(0, 57)}…` : first;
}

export function ageDays(lastModified, nowSeconds) {
    if (!lastModified)
        return null;
    return Math.max(0, Math.floor((nowSeconds - lastModified) / 86400));
}

export function formatAgo(days) {
    if (days === null)
        return 'unknown age';
    return days === 0 ? 'today' : `${days}d ago`;
}

/**
 * Order rows by a user-written list of input names.
 *
 * - "system" matches whichever input built the running system, whatever it is
 *   actually called, so the default works on any configuration.
 * - "*" marks where unlisted inputs go; without it they go last.
 * - Matching ignores case and surrounding space; repeats keep the first.
 * - Anything unlisted is sorted alphabetically among its peers.
 */
export function orderInputs(rows, orderString) {
    const seq = [];
    for (const token of splitList(orderString)) {
        const t = token.toLowerCase();
        if (!seq.includes(t))
            seq.push(t);
    }

    const starAt = seq.indexOf('*');
    const unlistedRank = starAt >= 0 ? starAt + 0.5 : seq.length;

    const rankOf = row => {
        const name = row.name.toLowerCase();
        const i = seq.findIndex(t =>
            t === name || (t === 'system' && row.isSystem));
        return i >= 0 ? i : unlistedRank;
    };

    return [...rows].sort((a, b) => {
        const d = rankOf(a) - rankOf(b);
        return d !== 0 ? d : a.name.localeCompare(b.name);
    });
}

/** Names in the order list that match no input (typo detection for prefs). */
export function unknownOrderNames(orderString, rows) {
    const known = new Set(rows.map(r => r.name.toLowerCase()));
    return splitList(orderString).filter(token => {
        const t = token.toLowerCase();
        return t !== 'system' && t !== '*' && !known.has(t);
    });
}

/** "22:00" -> 1320 minutes past midnight. Returns null if unparseable. */
export function parseClock(str) {
    const m = (str ?? '').trim().match(/^(\d{1,2})(?::(\d{2}))?$/);
    if (!m)
        return null;
    const h = +m[1];
    const min = m[2] ? +m[2] : 0;
    if (h > 23 || min > 59)
        return null;
    return h * 60 + min;
}

export function formatClock(minutes) {
    const h = Math.floor(minutes / 60), m = minutes % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Is `nowMinutes` inside the window? Handles windows that wrap midnight. */
export function withinWindow(nowMinutes, from, to) {
    if (from === to)
        return false;
    return from < to
        ? nowMinutes >= from && nowMinutes < to
        : nowMinutes >= from || nowMinutes < to;
}

export function splitList(str) {
    return (str ?? '').split(',').map(s => s.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

const STATUS_RANK = {behind: 0, error: 1, current: 2, unchecked: 3, ignored: 4};

/**
 * Sort rows for display. The input that built the running system always comes
 * first, and rows from a second flake stay grouped after the first.
 */
export function sortRows(rows, order) {
    const keyed = rows.map((r, i) => ({r, i}));
    keyed.sort((a, b) => {
        const fa = a.r.flakeIndex ?? 0, fb = b.r.flakeIndex ?? 0;
        if (fa !== fb)
            return fa - fb;
        if (!!a.r.isSystem !== !!b.r.isSystem)
            return a.r.isSystem ? -1 : 1;
        if (order === 'behind') {
            const sa = STATUS_RANK[a.r.status] ?? 9, sb = STATUS_RANK[b.r.status] ?? 9;
            if (sa !== sb)
                return sa - sb;
        } else if (order === 'age') {
            const da = a.r.days ?? -1, db = b.r.days ?? -1;
            if (da !== db)
                return db - da;   // oldest first
        }
        return a.i - b.i;         // otherwise keep flake.lock order
    });
    return keyed.map(k => k.r);
}

// ---------------------------------------------------------------------------
// Failure backoff
// ---------------------------------------------------------------------------

/** Seconds to wait after `count` consecutive failures, capped at ~1 day. */
export function backoffSeconds(count, intervalSeconds) {
    const cycles = Math.min(2 ** Math.max(0, count - 1), 12);
    return Math.min(cycles * intervalSeconds, 86400);
}

/** Should this input be skipped right now? */
export function shouldSkip(entry, nowSeconds) {
    return !!entry && entry.nextAttempt > nowSeconds;
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** Fill {input} (and {name}) in the user's update-command template. */
export function renderCommand(template, name) {
    const t = (template ?? '').trim() || 'nix flake update {input}';
    return t.replace(/\{input\}|\{name\}/g, name);
}

/**
 * Derive the stable channel name from `nixos-version` output.
 * "26.11.20261023.3ec6363 (Zokor)" -> "nixos-26.11"
 */
export function deriveStableChannel(version) {
    const m = (version ?? '').match(/^(\d{2})\.(\d{2})/);
    return m ? `nixos-${m[1]}.${m[2]}` : null;
}

/** Channels worth trying when auto-detecting, most likely first. */
export function channelCandidates(version) {
    const stable = deriveStableChannel(version);
    return stable ? ['nixos-unstable', stable] : ['nixos-unstable'];
}
