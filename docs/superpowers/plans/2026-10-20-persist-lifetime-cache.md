# Persist lifetime-stats cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tiến trình MCP mới dùng lại số liệu lifetime đã lưu trên đĩa, chỉ mở các session DB đã đổi.

**Architecture:** Thêm file `<sessionsDir>/lifetime-cache.json` (schemaVersion 1). `getLifetimeStats` nạp file một lần/tiến trình/thư mục vào `lifetimeDbCache` có sẵn, quét như cũ, và sau lần quét đầu tiên (nếu có miss) ghi lại file một lần bằng tmp + rename. Mọi lỗi I/O bị nuốt.

**Tech Stack:** TypeScript, `node:fs`, vitest. Repo `/Users/lang/GolandProjects/github.com/lang315/context-mode`, nhánh `feat/persist-lifetime-cache`.

**Spec:** `docs/superpowers/specs/2026-10-20-persist-lifetime-cache-design.md`

## Global Constraints

- Không xoá/di chuyển DB; không đụng `getRealBytesStats`, `getConversationStats`, `scanOneAdapter`; không thêm biến môi trường.
- File cache được ghi **tối đa một lần mỗi tiến trình mỗi sessionsDir**, chỉ sau lần quét đầu tiên và chỉ khi lần quét đó có miss.
- Kết quả `getLifetimeStats` phải giống hệt bản không có file cache.
- File cache hỏng/thiếu/sai `schemaVersion` ⇒ quét lại, không ném lỗi.
- `firstEventMs = +Infinity` lưu thành `null` trong JSON.
- Export mới duy nhất: `__resetLifetimeCacheForTests()` (chỉ cho test).
- Cài dependency nếu thiếu: `bun install --frozen-lockfile --ignore-scripts` (KHÔNG chạy `npm install` / postinstall — ghi vào `~/.claude`).
- Commit tiếng Anh, kiểu `fix(stats): ...` / `chore(release): ...`, kết thúc bằng `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Hai tiến trình ghi file cache cùng lúc → người ghi sau thắng nhờ rename atomic; file không bao giờ dở dang. Không test được ổn định — reviewer kiểm code.
2. Thư mục sessions không ghi được / ổ đầy → ghi thất bại im lặng, file tạm bị xoá, tiến trình vẫn chạy với cache RAM. Reviewer kiểm `catch` + `unlinkSync(tmp)`.
3. Tiến trình chết giữa write và rename → để lại `lifetime-cache.json.<pid>.tmp` (không khớp `*.db`, không khớp `stats-*.json`, nên vô hại nhưng không được dọn).
4. Entry trong file có `agg` sai kiểu (sửa tay, upstream đổi shape) → bị bỏ qua từng entry, các entry hợp lệ vẫn dùng. Test 3 phủ trường hợp sai `schemaVersion`; reviewer kiểm `isPersistedAgg`.
5. In-memory cache đã có entry trước khi nạp file (không xảy ra ở runtime vì nạp trước vòng quét đầu tiên) → entry RAM được giữ (`if (lifetimeDbCache.has(dbPath)) continue`).

---

### Task 1: Lưu và nạp lifetime cache

**Files:**
- Modify: `src/session/analytics.ts` (import `node:fs` dòng 13; thêm hàm ngay SAU `readLifetimeDbAgg` và TRƯỚC JSDoc `/** Aggregate lifetime stats ...`; sửa khối `if (DatabaseCtor) { for (...) }` trong `getLifetimeStats`)
- Test: `tests/session/lifetime-stats.test.ts` (import đầu file; thêm 1 `describe` cuối file)

**Interfaces:**
- Consumes: `lifetimeDbCache: Map<string, { sig: string; agg: LifetimeDbAgg }>`, `LifetimeDbAgg`, `lifetimeDbSignature`, `readLifetimeDbAgg` (đã có trong `analytics.ts`); `loadDatabase()` (`src/db-base.ts`); `SessionDB` (`src/session/db.ts`).
- Produces: `export function __resetLifetimeCacheForTests(): void`; file `<sessionsDir>/lifetime-cache.json` dạng `{ schemaVersion: 1, entries: Record<"<file>.db", { sig: string; agg: LifetimeDbAgg & { firstEventMs: number | null } }> }`.

- [ ] **Step 1: Mốc test**

Run: `cd /Users/lang/GolandProjects/github.com/lang315/context-mode && npx vitest run tests/session/lifetime-stats.test.ts tests/analytics/lifetime-stats-config-dir.test.ts tests/session/multi-adapter-stats.test.ts`
Expected: PASS hết (12+ test). Nếu `vitest` không có: `bun install --frozen-lockfile --ignore-scripts` rồi chạy lại.

- [ ] **Step 2: Viết test fail**

Trong `tests/session/lifetime-stats.test.ts`, sửa 2 dòng import:

```ts
import { mkdirSync, writeFileSync, rmSync, readFileSync, statSync, existsSync } from "node:fs";
```

```ts
import { getLifetimeStats, __resetLifetimeCacheForTests } from "../../src/session/analytics.js";
```

Thêm cuối file:

```ts
// ── Persisted cache: a new MCP process must not reopen unchanged DBs ──
describe("getLifetimeStats — persisted cache across processes", () => {
  const CACHE = "lifetime-cache.json";

  function countingLoader() {
    const Real = loadDatabase() as unknown as new (...args: unknown[]) => object;
    const state = { opens: 0 };
    const Counting = new Proxy(Real, {
      construct(target, args) {
        state.opens++;
        return Reflect.construct(target, args);
      },
    });
    return { loadDatabase: () => Counting, state };
  }

  function seed(dir: string, name: string, sid: string, n: number) {
    const db = new SessionDB({ dbPath: tmpDbPath(dir, name) });
    cleanups.push(() => db.cleanup());
    db.ensureSession(sid, `/p/${name}`);
    for (let i = 0; i < n; i++) {
      db.insertEvent(sid, makeEvent(`/p/${name}/f${i}.ts`), "PostToolUse");
    }
    db.close();
  }

  function addEvent(dir: string, name: string, sid: string) {
    const db = new SessionDB({ dbPath: tmpDbPath(dir, name) });
    cleanups.push(() => db.cleanup());
    db.insertEvent(sid, makeEvent(`/p/${name}/extra-${Date.now()}.ts`), "PostToolUse");
    db.close();
  }

  test("a new process reuses the persisted cache and opens no unchanged DB", () => {
    const sessionsDir = tmpDir("persist-reuse");
    const memoryRoot = tmpDir("persist-reuse-mem");
    seed(sessionsDir, "a", "s-a", 2);
    seed(sessionsDir, "b", "s-b", 3);

    const first = getLifetimeStats({ sessionsDir, memoryRoot });
    expect(existsSync(join(sessionsDir, CACHE))).toBe(true);

    __resetLifetimeCacheForTests();
    const c = countingLoader();
    const second = getLifetimeStats({ sessionsDir, memoryRoot, loadDatabase: c.loadDatabase });
    expect(c.state.opens).toBe(0);
    expect(second).toEqual(first);
  });

  test("after a restart only the DB that changed is reopened", () => {
    const sessionsDir = tmpDir("persist-changed");
    const memoryRoot = tmpDir("persist-changed-mem");
    seed(sessionsDir, "a", "s-a", 1);
    seed(sessionsDir, "b", "s-b", 1);
    getLifetimeStats({ sessionsDir, memoryRoot });

    __resetLifetimeCacheForTests();
    addEvent(sessionsDir, "a", "s-a");
    const c = countingLoader();
    const after = getLifetimeStats({ sessionsDir, memoryRoot, loadDatabase: c.loadDatabase });
    expect(c.state.opens).toBe(1);
    expect(after.totalEvents).toBe(3);
  });

  test("a corrupt or wrong-schema cache file is ignored", () => {
    const sessionsDir = tmpDir("persist-bad");
    const memoryRoot = tmpDir("persist-bad-mem");
    seed(sessionsDir, "a", "s-a", 2);
    getLifetimeStats({ sessionsDir, memoryRoot });

    // Wrong schema: keep the valid sig but poison the numbers.
    const file = join(sessionsDir, CACHE);
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    parsed.schemaVersion = 2;
    parsed.entries["a.db"].agg.events = 999;
    writeFileSync(file, JSON.stringify(parsed));
    __resetLifetimeCacheForTests();
    const c1 = countingLoader();
    expect(getLifetimeStats({ sessionsDir, memoryRoot, loadDatabase: c1.loadDatabase }).totalEvents).toBe(2);
    expect(c1.state.opens).toBe(1);

    writeFileSync(file, "not json");
    __resetLifetimeCacheForTests();
    const c2 = countingLoader();
    expect(getLifetimeStats({ sessionsDir, memoryRoot, loadDatabase: c2.loadDatabase }).totalEvents).toBe(2);
    expect(c2.state.opens).toBe(1);
  });

  test("the cache file is written at most once per process", () => {
    const sessionsDir = tmpDir("persist-once");
    const memoryRoot = tmpDir("persist-once-mem");
    seed(sessionsDir, "a", "s-a", 1);
    getLifetimeStats({ sessionsDir, memoryRoot });
    const file = join(sessionsDir, CACHE);
    const before = readFileSync(file, "utf-8");
    const mtimeBefore = statSync(file).mtimeMs;

    addEvent(sessionsDir, "a", "s-a");
    expect(getLifetimeStats({ sessionsDir, memoryRoot }).totalEvents).toBe(2);
    expect(readFileSync(file, "utf-8")).toBe(before);
    expect(statSync(file).mtimeMs).toBe(mtimeBefore);
  });

  test("a removed DB drops out of the totals and out of the next write", () => {
    const sessionsDir = tmpDir("persist-removed");
    const memoryRoot = tmpDir("persist-removed-mem");
    seed(sessionsDir, "a", "s-a", 2);
    seed(sessionsDir, "b", "s-b", 3);
    getLifetimeStats({ sessionsDir, memoryRoot });

    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(tmpDbPath(sessionsDir, "a") + suffix, { force: true });
    }
    addEvent(sessionsDir, "b", "s-b"); // forces a miss so the restart writes
    __resetLifetimeCacheForTests();
    expect(getLifetimeStats({ sessionsDir, memoryRoot }).totalEvents).toBe(4);
    const entries = JSON.parse(readFileSync(join(sessionsDir, CACHE), "utf-8")).entries;
    expect(Object.keys(entries)).toEqual(["b.db"]);
  });

  test("a DB with no timestamped events round-trips firstEventMs through JSON", () => {
    const sessionsDir = tmpDir("persist-inf");
    const memoryRoot = tmpDir("persist-inf-mem");
    seed(sessionsDir, "a", "s-a", 1);
    seed(sessionsDir, "empty", "s-e", 0);

    const first = getLifetimeStats({ sessionsDir, memoryRoot });
    const entries = JSON.parse(readFileSync(join(sessionsDir, CACHE), "utf-8")).entries;
    expect(entries["empty.db"].agg.firstEventMs).toBeNull();

    __resetLifetimeCacheForTests();
    const c = countingLoader();
    const second = getLifetimeStats({ sessionsDir, memoryRoot, loadDatabase: c.loadDatabase });
    expect(c.state.opens).toBe(0);
    expect(second).toEqual(first);
  });
});
```

- [ ] **Step 3: Chạy test, xác nhận fail đúng lý do**

Run: `npx vitest run tests/session/lifetime-stats.test.ts -t "persisted cache"`
Expected: FAIL — `__resetLifetimeCacheForTests is not a function` (hoặc `existsSync(...lifetime-cache.json)` false). Không được FAIL vì lỗi cú pháp/import khác.

- [ ] **Step 4: Sửa import trong `src/session/analytics.ts` dòng 13**

```ts
import { existsSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
```

- [ ] **Step 5: Thêm các hàm lưu/nạp**

Chèn ngay SAU hàm `readLifetimeDbAgg` (kết thúc bằng `return agg;\n}`) và TRƯỚC `/**\n * Aggregate lifetime stats from all SessionDB files`:

```ts
// A fresh MCP process starts with an empty lifetimeDbCache and would reopen
// every sidecar once. Persist the per-DB aggregates next to the DBs so a new
// process only reopens DBs whose signature changed. Written at most once per
// process (after its first scan) so steady-state disk writes do not grow.
const LIFETIME_CACHE_FILE = "lifetime-cache.json";
// Bump when LifetimeDbAgg's shape changes so stale files are ignored.
const LIFETIME_CACHE_SCHEMA = 1;
const lifetimeCacheLoaded = new Set<string>();
const lifetimeCacheFirstScanDone = new Set<string>();

function isPersistedAgg(a: unknown): a is Omit<LifetimeDbAgg, "firstEventMs"> & { firstEventMs: number | null } {
  const o = a as Record<string, unknown> | null;
  return !!o
    && typeof o.events === "number"
    && typeof o.sessions === "number"
    && typeof o.rescueBytes === "number"
    && typeof o.categoryCounts === "object" && o.categoryCounts !== null
    && Array.isArray(o.projects)
    && (o.firstEventMs === null || typeof o.firstEventMs === "number");
}

function loadPersistedLifetimeCache(sessionsDir: string): void {
  if (lifetimeCacheLoaded.has(sessionsDir)) return;
  lifetimeCacheLoaded.add(sessionsDir);
  try {
    const raw = JSON.parse(readFileSync(join(sessionsDir, LIFETIME_CACHE_FILE), "utf-8")) as {
      schemaVersion?: unknown;
      entries?: Record<string, { sig?: unknown; agg?: unknown }>;
    };
    if (raw?.schemaVersion !== LIFETIME_CACHE_SCHEMA || typeof raw.entries !== "object" || raw.entries === null) return;
    for (const [file, entry] of Object.entries(raw.entries)) {
      if (!file.endsWith(".db") || typeof entry?.sig !== "string" || !isPersistedAgg(entry.agg)) continue;
      const dbPath = join(sessionsDir, file);
      if (lifetimeDbCache.has(dbPath)) continue; // in-memory entry is at least as fresh
      lifetimeDbCache.set(dbPath, {
        sig: entry.sig,
        agg: { ...entry.agg, firstEventMs: entry.agg.firstEventMs ?? Number.POSITIVE_INFINITY },
      });
    }
  } catch { /* missing or corrupt cache file — rescan */ }
}

function savePersistedLifetimeCache(sessionsDir: string, files: string[]): void {
  const entries: Record<string, unknown> = {};
  for (const file of files) {
    const hit = lifetimeDbCache.get(join(sessionsDir, file));
    if (!hit) continue;
    entries[file] = {
      sig: hit.sig,
      agg: { ...hit.agg, firstEventMs: Number.isFinite(hit.agg.firstEventMs) ? hit.agg.firstEventMs : null },
    };
  }
  const target = join(sessionsDir, LIFETIME_CACHE_FILE);
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ schemaVersion: LIFETIME_CACHE_SCHEMA, entries }));
    renameSync(tmp, target); // atomic: concurrent writers → last one wins, never a torn file
  } catch {
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }
}

/** Test-only: simulate a fresh process by dropping all in-memory cache state. */
export function __resetLifetimeCacheForTests(): void {
  lifetimeDbCache.clear();
  lifetimeCacheLoaded.clear();
  lifetimeCacheFirstScanDone.clear();
}
```

- [ ] **Step 6: Nối vào vòng quét trong `getLifetimeStats`**

Trong khối `if (DatabaseCtor) {`, thay dòng mở vòng lặp

```ts
        for (const file of dbFiles) {
```

bằng

```ts
        loadPersistedLifetimeCache(sessionsDir);
        let missed = false;
        for (const file of dbFiles) {
```

thay

```ts
          } else {
            try {
              agg = readLifetimeDbAgg(DatabaseCtor, dbPath);
```

bằng

```ts
          } else {
            missed = true;
            try {
              agg = readLifetimeDbAgg(DatabaseCtor, dbPath);
```

và ngay SAU dấu `}` đóng vòng `for (const file of dbFiles)` (dòng sau `for (const p of agg.projects) distinctProjectsSet.add(p);\n        }`), thêm:

```ts
        if (!lifetimeCacheFirstScanDone.has(sessionsDir)) {
          lifetimeCacheFirstScanDone.add(sessionsDir);
          if (missed) savePersistedLifetimeCache(sessionsDir, dbFiles);
        }
```

- [ ] **Step 7: Chạy test mới**

Run: `npx vitest run tests/session/lifetime-stats.test.ts`
Expected: PASS toàn bộ file (8 test cũ + 6 test mới = 14).

- [ ] **Step 8: Test liên quan + toàn suite + typecheck**

Run: `npx vitest run tests/session/lifetime-stats.test.ts tests/analytics/lifetime-stats-config-dir.test.ts tests/session/multi-adapter-stats.test.ts tests/core/server.test.ts && npx vitest run && npm run typecheck`
Expected: PASS; toàn suite ≥ 4731 passed (4725 + 6), 0 failed; typecheck exit 0. Sau đó `rm -f f0.tmp f1.tmp f2.tmp` (suite để lại).

- [ ] **Step 9: Commit**

```bash
git add src/session/analytics.ts tests/session/lifetime-stats.test.ts
git commit -F - <<'EOF'
fix(stats): persist the per-DB lifetime cache so new processes skip unchanged DBs

Every new MCP process started with an empty lifetime cache and reopened all
session DBs once (122 opens, ~4 MB of -shm writes, ~150 ms on one machine).
Store the per-DB aggregates in <sessionsDir>/lifetime-cache.json, load them
once per process, and write the file at most once per process (after the
first scan, only if it had a miss) via tmp + rename, so steady-state writes
do not grow. A corrupt or wrong-schema file is ignored.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

### Task 2: Kiểm chứng dữ liệu thật + phát hành `1.0.169-lang315.3`

**Files:**
- Modify: `package.json` + manifest do `scripts/version-sync.mjs` sửa; `server.bundle.mjs`, `cli.bundle.mjs` (do `npm run bundle`); `FORK.md` (bảng "Changes from upstream" và dòng `# version:` trong mục "Check the install").

**Interfaces:**
- Consumes: `getLifetimeStats`, `loadDatabase` (Task 1).

- [ ] **Step 1: Đo trên dữ liệu thật bằng 2 tiến trình riêng**

Run (2 lần liên tiếp, mỗi lần là một tiến trình mới):

```bash
cd /Users/lang/GolandProjects/github.com/lang315/context-mode && for i in 1 2; do npx tsx -e '
import { getLifetimeStats } from "./src/session/analytics.ts";
import { loadDatabase } from "./src/db-base.ts";
const Real = loadDatabase(); let opens = 0;
const C = new Proxy(Real, { construct(t, a) { opens++; return Reflect.construct(t, a); } });
const t = performance.now(); const s = getLifetimeStats({ loadDatabase: () => C });
console.log(JSON.stringify({ opens, ms: Math.round(performance.now() - t), totalEvents: s.totalEvents }));
' 2>&1 | grep -v -E "ExperimentalWarning|trace-warnings"; done; ls ~/.claude/context-mode/sessions/*.db | wc -l
```

Expected: lần 1 `opens` ≤ số `*.db` (lần đầu chưa có file cache thì = số DB); lần 2 `opens` ≤ số DB đang được session hoạt động ghi (vài cái), `totalEvents` hai lần chênh không quá vài event (session đang chạy vẫn ghi).

- [ ] **Step 2: Đổi version, build bundle, assert**

```bash
sed -i '' 's/^  "version": "1.0.169-lang315.2",$/  "version": "1.0.169-lang315.3",/' package.json
node scripts/version-sync.mjs
npm run bundle && npm run assert-bundle && npm run assert-asymmetric-drift
grep -c "lifetime-cache.json" server.bundle.mjs
```

Expected: `✓ all manifests at v1.0.169-lang315.3`; cả 2 assert OK; grep ≥ 1.

- [ ] **Step 3: Cập nhật `FORK.md`**

Thêm dòng ngay dưới dòng bảng `1.0.169-lang315.2`:

```markdown
| `1.0.169-lang315.3` | The lifetime cache is saved to `sessions/lifetime-cache.json`. A new MCP process loads it and only reopens session DBs that changed. Before this, each process opened every DB on its first refresh (122 opens, about 4 MB of writes). The file is written at most once per process. | spec `docs/superpowers/specs/2026-10-20-persist-lifetime-cache-design.md` |
```

và đổi `# version: 1.0.169-lang315.2` thành `# version: 1.0.169-lang315.3`.

- [ ] **Step 4: Commit release, fast-forward `main` của fork**

```bash
git add -u
git commit -m "chore(release): 1.0.169-lang315.3 persisted lifetime cache

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git fetch -q origin && git merge-base --is-ancestor origin/main HEAD && git push origin HEAD:main
git push -u origin feat/persist-lifetime-cache
gh api repos/lang315/context-mode/branches/main --jq .commit.sha
```

Expected: push fast-forward thành công; sha `main` = HEAD.

- [ ] **Step 5: Cập nhật plugin trên máy**

```bash
claude plugin marketplace update context-mode
claude plugin update context-mode@context-mode
grep -A8 '"context-mode@context-mode"' ~/.claude/plugins/installed_plugins.json | grep -E '"version"|gitCommitSha'
shasum -a1 ~/.claude/plugins/cache/context-mode/context-mode/1.0.169-lang315.3/server.bundle.mjs server.bundle.mjs
```

Expected: version `1.0.169-lang315.3`, sha trùng HEAD; 2 hash bundle trùng nhau. Báo user restart session.
