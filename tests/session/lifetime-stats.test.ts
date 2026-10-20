/**
 * lifetime-stats — Bug #3 + #4
 *
 * Bug #3: Persistent memory totals (events across all sessions, not just
 * the current one) must be visible in ctx_stats so the user sees the
 * cumulative value of context-mode.
 *
 * Bug #4: Auto-memory captured by Claude Code under
 * ~/.claude/projects/<project>/memory/*.md is invisible today. ctx_stats
 * should surface the count and the projects involved.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, rmSync, readFileSync, statSync, existsSync } from "node:fs";
import { afterAll, describe, expect, test } from "vitest";
import { SessionDB } from "../../src/session/db.js";
import { getLifetimeStats, __resetLifetimeCacheForTests } from "../../src/session/analytics.js";
import { loadDatabase } from "../../src/db-base.js";

const cleanups: Array<() => void> = [];

afterAll(() => {
  for (const fn of cleanups) {
    try { fn(); } catch { /* ignore */ }
  }
});

function tmpDir(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function tmpDbPath(dir: string, name: string): string {
  return join(dir, `${name}.db`);
}

function makeEvent(data: string) {
  return {
    type: "file",
    category: "file",
    data,
    priority: 2,
    data_hash: "",
  };
}

describe("getLifetimeStats — cross-session totals + auto-memory", () => {
  test("aggregates totalEvents and totalSessions across multiple SessionDBs", () => {
    const sessionsDir = tmpDir("sessions");

    const db1 = new SessionDB({ dbPath: tmpDbPath(sessionsDir, "proj-a") });
    cleanups.push(() => db1.cleanup());
    db1.ensureSession("sess-a1", "/p/a");
    db1.insertEvent("sess-a1", makeEvent("/p/a/x.ts"), "PostToolUse");
    db1.ensureSession("sess-a2", "/p/a");
    db1.insertEvent("sess-a2", makeEvent("/p/a/y.ts"), "PostToolUse");
    db1.close();

    const db2 = new SessionDB({ dbPath: tmpDbPath(sessionsDir, "proj-b") });
    cleanups.push(() => db2.cleanup());
    db2.ensureSession("sess-b1", "/p/b");
    db2.insertEvent("sess-b1", makeEvent("/p/b/m.ts"), "PostToolUse");
    db2.insertEvent("sess-b1", makeEvent("/p/b/n.ts"), "PostToolUse");
    db2.close();

    const memoryRoot = tmpDir("projects-empty");

    const stats = getLifetimeStats({ sessionsDir, memoryRoot });
    expect(stats.totalEvents).toBe(4);
    expect(stats.totalSessions).toBe(3);
  });

  test("counts auto-memory files across project subdirs", () => {
    const sessionsDir = tmpDir("sessions-empty");
    const memoryRoot = tmpDir("projects-with-memory");

    // ~/.claude/projects/<project>/memory/<file>.md
    const projA = join(memoryRoot, "proj-a", "memory");
    const projB = join(memoryRoot, "proj-b", "memory");
    mkdirSync(projA, { recursive: true });
    mkdirSync(projB, { recursive: true });

    writeFileSync(join(projA, "user_identity.md"), "name: Mert");
    writeFileSync(join(projA, "feedback_push.md"), "always push to next");
    writeFileSync(join(projB, "project_notes.md"), "hello");
    // Non-md file should be ignored
    writeFileSync(join(projB, "ignore.txt"), "skip me");

    const stats = getLifetimeStats({ sessionsDir, memoryRoot });
    expect(stats.autoMemoryCount).toBe(3);
    expect(stats.autoMemoryProjects).toBe(2);
  });

  test("returns zero stats when no DBs and no memory dirs exist", () => {
    const sessionsDir = tmpDir("none-sessions");
    const memoryRoot = tmpDir("none-memory");
    const stats = getLifetimeStats({ sessionsDir, memoryRoot });
    expect(stats.totalEvents).toBe(0);
    expect(stats.totalSessions).toBe(0);
    expect(stats.autoMemoryCount).toBe(0);
    expect(stats.autoMemoryProjects).toBe(0);
  });

  // ── Cycle 2: aggregate per-category counts across every SessionDB ──
  test("aggregates categoryCounts across multiple SessionDBs", () => {
    const sessionsDir = tmpDir("sessions-cats");

    function eventOfCategory(cat: string, data: string) {
      return { type: cat, category: cat, data, priority: 2, data_hash: "" };
    }

    const db1 = new SessionDB({ dbPath: tmpDbPath(sessionsDir, "proj-a") });
    cleanups.push(() => db1.cleanup());
    db1.ensureSession("sess-a1", "/p/a");
    db1.insertEvent("sess-a1", eventOfCategory("file", "/p/a/x.ts"), "PostToolUse");
    db1.insertEvent("sess-a1", eventOfCategory("file", "/p/a/y.ts"), "PostToolUse");
    db1.insertEvent("sess-a1", eventOfCategory("cwd", "/p/a"), "PostToolUse");
    db1.close();

    const db2 = new SessionDB({ dbPath: tmpDbPath(sessionsDir, "proj-b") });
    cleanups.push(() => db2.cleanup());
    db2.ensureSession("sess-b1", "/p/b");
    db2.insertEvent("sess-b1", eventOfCategory("file", "/p/b/m.ts"), "PostToolUse");
    db2.insertEvent("sess-b1", eventOfCategory("rule", "AGENTS.md"), "PostToolUse");
    db2.close();

    const memoryRoot = tmpDir("projects-empty-cats");
    const stats = getLifetimeStats({ sessionsDir, memoryRoot });
    expect(stats.categoryCounts).toBeDefined();
    expect(stats.categoryCounts.file).toBe(3); // 2 from a + 1 from b
    expect(stats.categoryCounts.cwd).toBe(1);
    expect(stats.categoryCounts.rule).toBe(1);
  });
});

// ── Per-DB cache: dormant sidecars must not be reopened ──
// persistStats() refreshes lifetime stats every 30–60s; every reopen of a
// WAL DB dirties its -shm, so unchanged DBs must be served from cache.
describe("getLifetimeStats — per-DB cache", () => {
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

  test("second call with unchanged DBs opens none and returns identical stats", () => {
    const sessionsDir = tmpDir("cache-unchanged");
    const memoryRoot = tmpDir("cache-unchanged-mem");
    seed(sessionsDir, "a", "s-a", 2);
    seed(sessionsDir, "b", "s-b", 3);
    const c = countingLoader();

    const first = getLifetimeStats({ sessionsDir, memoryRoot, loadDatabase: c.loadDatabase });
    expect(c.state.opens).toBe(2);
    expect(first.totalEvents).toBe(5);

    const second = getLifetimeStats({ sessionsDir, memoryRoot, loadDatabase: c.loadDatabase });
    expect(c.state.opens).toBe(2);
    expect(second).toEqual(first);
  });

  test("a DB that gained events is reopened; the others are not", () => {
    const sessionsDir = tmpDir("cache-changed");
    const memoryRoot = tmpDir("cache-changed-mem");
    seed(sessionsDir, "a", "s-a", 1);
    seed(sessionsDir, "b", "s-b", 1);
    const c = countingLoader();

    expect(getLifetimeStats({ sessionsDir, memoryRoot, loadDatabase: c.loadDatabase }).totalEvents).toBe(2);
    expect(c.state.opens).toBe(2);

    const db = new SessionDB({ dbPath: tmpDbPath(sessionsDir, "a") });
    cleanups.push(() => db.cleanup());
    db.insertEvent("s-a", makeEvent("/p/a/new.ts"), "PostToolUse");
    db.close();

    const after = getLifetimeStats({ sessionsDir, memoryRoot, loadDatabase: c.loadDatabase });
    expect(c.state.opens).toBe(3);
    expect(after.totalEvents).toBe(3);
  });

  test("a removed DB stops contributing", () => {
    const sessionsDir = tmpDir("cache-removed");
    const memoryRoot = tmpDir("cache-removed-mem");
    seed(sessionsDir, "a", "s-a", 2);
    seed(sessionsDir, "b", "s-b", 3);

    expect(getLifetimeStats({ sessionsDir, memoryRoot }).totalEvents).toBe(5);

    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(tmpDbPath(sessionsDir, "a") + suffix, { force: true });
    }
    expect(getLifetimeStats({ sessionsDir, memoryRoot }).totalEvents).toBe(3);
  });

  test("an unreadable DB is not cached and is retried", () => {
    const sessionsDir = tmpDir("cache-bad");
    const memoryRoot = tmpDir("cache-bad-mem");
    writeFileSync(join(sessionsDir, "bad.db"), "not a sqlite file");
    const c = countingLoader();

    expect(getLifetimeStats({ sessionsDir, memoryRoot, loadDatabase: c.loadDatabase }).totalEvents).toBe(0);
    expect(c.state.opens).toBe(1);
    getLifetimeStats({ sessionsDir, memoryRoot, loadDatabase: c.loadDatabase });
    expect(c.state.opens).toBe(2);
  });
});

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

  test("a cache file written by another context-mode version is ignored", () => {
    const sessionsDir = tmpDir("persist-version");
    const memoryRoot = tmpDir("persist-version-mem");
    seed(sessionsDir, "a", "s-a", 2);
    getLifetimeStats({ sessionsDir, memoryRoot });

    // An upgrade may change what the per-DB queries mean without changing shape.
    const file = join(sessionsDir, CACHE);
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    parsed.version = "0.0.0-older";
    parsed.entries["a.db"].agg.events = 999;
    writeFileSync(file, JSON.stringify(parsed));
    __resetLifetimeCacheForTests();
    const c = countingLoader();
    expect(getLifetimeStats({ sessionsDir, memoryRoot, loadDatabase: c.loadDatabase }).totalEvents).toBe(2);
    expect(c.state.opens).toBe(1);
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
