# lang315/context-mode fork

This repository is a fork of [mksglu/context-mode](https://github.com/mksglu/context-mode) by Mert Koseoğlu. It is based on upstream `v1.0.169`. The license (Elastic License 2.0, see [LICENSE](LICENSE)) and all upstream notices are unchanged.

The fork exists because upstream has pull requests and issues disabled, so fixes cannot be sent back.

## Changes from upstream

| Version | Change | Reference |
| --- | --- | --- |
| `1.0.169-lang315.1` | `getLifetimeStats` caches each session DB's totals. It reopens a DB only when its `.db` or `-wal` file changed. | [PR #1](https://github.com/lang315/context-mode/pull/1) |
| `1.0.169-lang315.1` | Bundles (`server.bundle.mjs`, `cli.bundle.mjs`, `hooks/*.bundle.mjs`) are rebuilt from this fork's `src/`. | this release |
| `1.0.169-lang315.2` | On startup, the server deletes `stats-*.json` files that have not been written for 14 days. Before this, nothing deleted them; one machine had 6,868, and every `ctx_*` call lists that directory. Side effect: the Pi adapter's lifetime figure, which sums all stats files, drops. | `cleanupStaleStatsFiles` in `src/store.ts` |

### Why the lifetime-stats fix matters

Every context-mode MCP server refreshes lifetime stats on a 60-second heartbeat (`src/server.ts`, `persistStats`). Before the fix, each refresh opened every `~/.claude/context-mode/sessions/*.db`.

Opening a WAL database writes its `-shm` file, even in readonly mode. Session DBs are never deleted, so this cost keeps growing.

Measured on one machine with 8 Claude Code sessions open:

| Session DBs | Disk writes, all context-mode processes |
| --- | --- |
| 438 | 111.6 MB/min |
| 121 | 31.9 MB/min |

After the fix, a refresh only reopens DBs that changed. In a test with 122 real DBs, the first call opened 122 DBs and each later call opened 0.

## Install (Claude Code)

Only Claude Code has been tested with this fork.

The fork's marketplace has the same name as upstream's (`context-mode`). Remove the upstream marketplace first:

```bash
claude plugin marketplace remove context-mode
claude plugin marketplace add lang315/context-mode
claude plugin install context-mode@context-mode
```

Then restart every running Claude Code session so it loads the new MCP server.

Inside Claude Code, the same steps are `/plugin marketplace remove context-mode`, `/plugin marketplace add lang315/context-mode`, and `/plugin install context-mode@context-mode`.

### Check the install

```bash
grep -A3 '"context-mode"' ~/.claude/plugins/known_marketplaces.json   # repo: lang315/context-mode
grep -A6 '"context-mode@context-mode"' ~/.claude/plugins/installed_plugins.json   # version: 1.0.169-lang315.2
```

### Go back to upstream

```bash
claude plugin marketplace remove context-mode
claude plugin marketplace add mksglu/context-mode
claude plugin install context-mode@context-mode
```

Restart your Claude Code sessions afterwards.

## Keeping the fork in sync (maintainer)

Updates from upstream do not reach this fork automatically.

To bring them in:

```bash
git fetch upstream
git switch main
git rebase upstream/main
bun install --frozen-lockfile --ignore-scripts   # see note below
npx vitest run
npm run typecheck
# set package.json "version" to <upstream-version>-lang315.<n>
node scripts/version-sync.mjs
npm run bundle && npm run assert-bundle && npm run assert-asymmetric-drift
git commit -am "chore(release): <version>"
git push --force-with-lease origin main
```

Notes:

- **`--ignore-scripts`:** `scripts/postinstall.mjs` writes to your live `~/.claude` config: `plugins/installed_plugins.json`, `settings.json`, and symlinks in the plugin cache. Skip it when you install dependencies for development. `npm install` currently fails on this tree (`Cannot read properties of null (reading 'edgesOut')`); use bun with the tracked `bun.lock`.
- **Bundles:** the plugin runs `server.bundle.mjs` and does not read `src/` (`start.mjs`). A source change has no effect until you run `npm run bundle` and commit the result.
- **Version suffix:** always bump the `-lang315.<n>` suffix on a release. Claude Code caches plugins by version, so reusing a version can keep old code running.

## Known limitations

- The fork has only been tested on Claude Code on macOS, using the `node:sqlite` driver. Other platforms, Windows, and the better-sqlite3 path have not been tested.
- Session DBs are still never deleted. Old ones can be moved out of the scan directory to cut the first-call cost. They will no longer be found by `ctx_search`. To move every DB not modified in 30 days:

  ```bash
  cd ~/.claude/context-mode && mkdir -p sessions-archive
  find sessions -maxdepth 1 -name '*.db' -mtime +30 | while read -r db; do
    for f in "$db" "$db-wal" "$db-shm"; do [ -e "$f" ] && mv -n "$f" sessions-archive/; done
  done
  ```
