# NixOS Update Checker

A GNOME Shell extension that tells you, at a glance, whether your NixOS system
is behind its channel — and optionally whether the inputs in your `flake.lock`
have moved on upstream.

Everything is read-only. The extension never runs `nix`, never writes to your
configuration, and never changes your `flake.lock`.

## The panel icon

| Icon | Meaning |
| --- | --- |
| ✓ | Everything is up to date |
| ⬆ red | Your system is behind its channel |
| ⬆ amber | The system is current, but one or more flake inputs are behind |
| ⏻  purple | A reboot is needed: the booted kernel is older than the current system |
| ? | The last check failed — the menu says why |

Only one state can show at a time, so they have a priority order: **system →
inputs → reboot**. A pending reboot shows only when nothing is behind. All
three colours are configurable.

Clicking the icon opens a menu with your installed revision, the latest channel
revision, the flake input list, and a "Check now" action.

## What it checks

**The system.** Runs `nixos-version --hash` and compares the result with
`https://channels.nixos.org/<channel>/git-revision`.

The channel is worked out for you. `nixos-version` reports the release a system
belongs to, and on unstable that is the *next* release, which has no channel
yet — so if a channel exists for that release you are on stable, and if it
404s you are on unstable. You can override it in Settings if the guess is
wrong or you follow something unusual such as `nixos-unstable-small`.

**Flake inputs** (off by default). Reads the top-level inputs from your
`flake.lock` and asks each one's upstream for the current head of the branch
you track, using `git ls-remote`. That works for any git host and uses no API
quota. If `git` isn't on `PATH`, it falls back to the GitHub API with ETag
caching, which is subject to GitHub's 60-requests-per-hour anonymous limit.

Inputs pinned to a fixed revision can't be behind, so they are skipped.

**Reboots** (on by default). Compares the kernel, initrd and module set of
`/run/booted-system` against `/run/current-system`. A plain `nixos-rebuild
switch` applies most changes live, so only a changed kernel actually calls for
a reboot — the extension doesn't nag you after every rebuild.

## Requirements

- GNOME Shell 50
- `git` for flake input checking (optional; a GitHub-only fallback exists)
- NixOS

## Install

Download the release zip, then:

```sh
mkdir -p ~/.local/share/gnome-shell/extensions
unzip nixos-update-checker@adam-tj.github.com.zip \
  -d ~/.local/share/gnome-shell/extensions/nixos-update-checker@adam-tj.github.com
```

The folder name must match the extension's UUID exactly, domain part and
all, or GNOME won't load it.

Log out and back in — on Wayland there is no way to reload the shell without
ending the session — then:

```sh
gnome-extensions enable nixos-update-checker@adam-tj.github.com
```

## Settings

Four tabs.

**Settings** — the channel override, the reboot warning, how often to check,
whether to re-check when the network returns, whether to remember the last
result between sessions, and the notification options. Also holds "Reset all
settings".

**Flake inputs** — the master switch, your flake folder, an optional second
flake, inputs to ignore, and the order to list them in. Below that, two
display switches that change what the menu shows without affecting what gets
checked.

**Appearance** — the three icon colours, and what appears in the menu.

**About** — version, licence, repository link.

### Input order

A comma-separated list of input names, highest first. Two special tokens:

- `system` — whichever input built your running system, whatever it's called.
  This makes the default work on any configuration.
- `*` — where unlisted inputs go. Without it they go last.

```
system, helium-browser, waterfox, *, nixpkgs
```

Anything not listed is sorted alphabetically. Names that match no input are
flagged underneath the field, since a typo would otherwise do nothing at all.

### Notifications

Edge-triggered: you are told when something *becomes* behind, never on every
check. By default each input is announced once and stays quiet until it is up
to date again — a failed check doesn't count as a return to up-to-date, so a
flaky connection can't re-announce the same input.

Quiet hours hold notifications during a window and deliver them afterwards
rather than dropping them. GNOME's own Do Not Disturb covers the manual case
and is usually the better tool.

## Checking schedule

A check runs about ten seconds after login, then every 120 minutes by default,
and again whenever the network comes back (which also covers waking from
suspend). "Check now" in the menu is always available.

The last result is cached in
`~/.cache/nixos-update-checker/last-result.json`, so the menu is useful
immediately at login, marked as not yet rechecked, and keeps showing the last
known state if a check fails.

## Licence

Copyright © 2026 Adam Tjörnhammar ([@adam-tj](https://github.com/adam-tj))

Released under the GNU General Public License, version 2 or later
(`GPL-2.0-or-later`). The full text is in [LICENSE.md](LICENSE.md).
