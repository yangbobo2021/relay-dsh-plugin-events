import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { SCHEMA_VERSION } from "../src/runtime/schema.mjs";
import { RelayStore } from "../src/runtime/store.mjs";

test("a missing, empty, or metadata-only database initializes directly at the latest schema", async () => {
  for (const state of ["missing", "empty", "metadata-only"]) {
    const directory = await mkdtemp(join(tmpdir(), `relay-events-${state}-`));
    const databasePath = join(directory, "relay.sqlite");
    try {
      if (state === "empty") await writeFile(databasePath, "");
      if (state === "metadata-only") {
        const database = new DatabaseSync(databasePath);
        database.exec(`
          CREATE TABLE relay_schema (
            version INTEGER PRIMARY KEY,
            applied_at TEXT NOT NULL
          ) STRICT
        `);
        database.close();
      }

      const store = new RelayStore(databasePath);
      assertLatestSchema(store.database);
      assert.equal(store.migrationBackupPath, null);
      store.close();
      assert.equal(existsSync(databasePath), true);
      assert.equal(findBackups(directory).length, 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("every historical schema from v1 through v9 migrates, preserves data, and reopens idempotently", async () => {
  for (let version = 1; version < SCHEMA_VERSION; version += 1) {
    const directory = await mkdtemp(join(tmpdir(), `relay-events-v${version}-`));
    const databasePath = join(directory, "relay.sqlite");
    try {
      createHistoricalDatabase(databasePath, version);

      const migrated = new RelayStore(databasePath);
      assertLatestSchema(migrated.database);
      assert.equal(migrated.inspectEvent("event-1").payload.subject, "preserve me");
      assert.equal(
        migrated.migrationBackupPath,
        `${databasePath}.backup-v${version}-to-v${SCHEMA_VERSION}.sqlite`,
      );
      migrated.close();

      const backup = new DatabaseSync(`${databasePath}.backup-v${version}-to-v${SCHEMA_VERSION}.sqlite`, {
        readOnly: true,
      });
      assert.equal(currentVersion(backup), version);
      if (version < 8) assert.equal(columnNames(backup, "events").has("correlation_key"), false);
      assert.deepEqual(backup.prepare("PRAGMA quick_check").all().map(row => row.quick_check), ["ok"]);
      backup.close();

      const reopened = new RelayStore(databasePath);
      assertLatestSchema(reopened.database);
      assert.equal(reopened.inspectEvent("event-1").payload.subject, "preserve me");
      assert.equal(reopened.migrationBackupPath, null);
      reopened.close();
      assert.equal(findBackups(directory).length, 1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("a partially repaired v4 database converges without duplicating migration effects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relay-events-partial-v4-"));
  const databasePath = join(directory, "relay.sqlite");
  try {
    createHistoricalDatabase(databasePath, 4);
    const partial = new DatabaseSync(databasePath);
    partial.exec("ALTER TABLE events ADD COLUMN correlation_key TEXT");
    partial.close();

    const migrated = new RelayStore(databasePath);
    assertLatestSchema(migrated.database);
    assert.ok(migrated.database.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'events_trusted_correlation'",
    ).get());
    migrated.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("migration failure rolls back all schema changes and retains a verified pre-migration backup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relay-events-rollback-"));
  const databasePath = join(directory, "relay.sqlite");
  const backupPath = `${databasePath}.backup-v4-to-v${SCHEMA_VERSION}.sqlite`;
  try {
    createHistoricalDatabase(databasePath, 4);
    const invalid = new DatabaseSync(databasePath);
    invalid.exec(`
      ALTER TABLE events ADD COLUMN correlation_key TEXT;
      UPDATE events SET correlation_key = 'duplicate';
    `);
    invalid.close();

    assert.throws(
      () => new RelayStore(databasePath),
      error => {
        assert.match(error.message, /Relay database initialization failed/u);
        assert.match(error.message, /UNIQUE constraint failed: events\.correlation_key/u);
        assert.match(error.message, /backup-v4-to-v10/u);
        return true;
      },
    );

    const rolledBack = new DatabaseSync(databasePath);
    assert.equal(currentVersion(rolledBack), 4);
    assert.equal(columnNames(rolledBack, "delivery_waits").has("ordinal"), false);
    assert.equal(
      rolledBack.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'events_trusted_correlation'").get(),
      undefined,
    );
    rolledBack.close();

    assert.equal(existsSync(backupPath), true);
    const backup = new DatabaseSync(backupPath, { readOnly: true });
    assert.equal(currentVersion(backup), 4);
    assert.deepEqual(backup.prepare("PRAGMA quick_check").all().map(row => row.quick_check), ["ok"]);
    backup.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unknown unversioned databases and future schemas fail closed without modification", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relay-events-unsupported-"));
  try {
    const unversionedPath = join(directory, "unversioned.sqlite");
    const unversioned = new DatabaseSync(unversionedPath);
    unversioned.exec("CREATE TABLE mystery (id TEXT PRIMARY KEY) STRICT");
    assert.equal(unversioned.prepare("PRAGMA journal_mode").get().journal_mode, "delete");
    unversioned.close();
    assert.throws(
      () => new RelayStore(unversionedPath),
      /non-empty Relay database has no relay_schema metadata/u,
    );
    const unchanged = new DatabaseSync(unversionedPath);
    assert.equal(unchanged.prepare("PRAGMA journal_mode").get().journal_mode, "delete");
    assert.deepEqual(
      unchanged.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all().map(row => row.name),
      ["mystery"],
    );
    unchanged.close();

    const futurePath = join(directory, "future.sqlite");
    new RelayStore(futurePath).close();
    const future = new DatabaseSync(futurePath);
    future.exec(`
      DELETE FROM relay_schema;
      INSERT INTO relay_schema (version, applied_at) VALUES (11, '2026-09-04T00:00:00.000Z');
    `);
    future.close();
    assert.throws(
      () => new RelayStore(futurePath),
      /database schema version 11 is newer than supported version 10/u,
    );
    const stillFuture = new DatabaseSync(futurePath);
    assert.equal(currentVersion(stillFuture), 11);
    stillFuture.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function createHistoricalDatabase(databasePath, version) {
  assert.ok(version >= 1 && version <= SCHEMA_VERSION);
  const latest = new RelayStore(databasePath);
  latest.database.prepare(`
    INSERT INTO events (
      id, source, source_event_id, fingerprint, correlation_key, payload_json,
      state, version, received_at, updated_at
    ) VALUES ('event-1', 'test', 'source-1', 'fingerprint-1', NULL, ?, 'received', 0, ?, ?)
  `).run(
    JSON.stringify({ event_id: "event-1", source: "test", fingerprint: "fingerprint-1", subject: "preserve me" }),
    "2026-09-04T00:00:00.000Z",
    "2026-09-04T00:00:00.000Z",
  );
  latest.database.prepare(`
    INSERT INTO events (
      id, source, source_event_id, fingerprint, correlation_key, payload_json,
      state, version, received_at, updated_at
    ) VALUES ('event-2', 'test', 'source-2', 'fingerprint-2', NULL, ?, 'received', 0, ?, ?)
  `).run(
    JSON.stringify({ event_id: "event-2", source: "test", fingerprint: "fingerprint-2" }),
    "2026-09-04T00:00:01.000Z",
    "2026-09-04T00:00:01.000Z",
  );
  latest.close();

  const database = new DatabaseSync(databasePath);
  if (version < 10) {
    database.exec(`
      ALTER TABLE notification_outcomes DROP COLUMN receipt_id;
      ALTER TABLE notification_outcomes DROP COLUMN attempt_count;
    `);
  }
  if (version < 9) {
    for (const column of ["terminal_at", "terminal_reason_code", "next_attempt_at", "attempt_count"]) {
      database.exec(`ALTER TABLE activations DROP COLUMN ${column}`);
    }
  }
  if (version < 8) {
    database.exec(`
      DROP INDEX events_trusted_correlation;
      ALTER TABLE events DROP COLUMN correlation_key;
    `);
  }
  if (version < 7) database.exec("DROP TABLE notification_outcomes");
  if (version < 6) {
    for (const column of ["terminal_at", "terminal_actor", "terminal_reason_detail", "terminal_reason_code", "paused"]) {
      database.exec(`ALTER TABLE monitors DROP COLUMN ${column}`);
    }
  }
  if (version < 5) {
    database.exec(`
      ALTER TABLE delivery_waits DROP COLUMN wait_snapshot_json;
      ALTER TABLE delivery_waits DROP COLUMN ordinal;
    `);
  }
  if (version < 4) {
    for (const column of ["last_error", "accepted_at", "lease_expires_at", "lease_owner"]) {
      database.exec(`ALTER TABLE activations DROP COLUMN ${column}`);
    }
    database.exec(`
      DROP TABLE routing_decisions;
      CREATE TABLE routing_decisions (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE REFERENCES events(id),
        disposition TEXT NOT NULL CHECK (disposition IN ('deliver', 'spawn', 'dismiss')),
        actionable INTEGER NOT NULL CHECK (actionable IN (0, 1)),
        summary TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        decision_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
    `);
  }
  if (version < 3) database.exec("ALTER TABLE runs DROP COLUMN activation_id");
  database.exec("DELETE FROM relay_schema");
  database.prepare("INSERT INTO relay_schema (version, applied_at) VALUES (?, ?)")
    .run(version, "2026-09-04T00:00:00.000Z");
  database.close();
}

function assertLatestSchema(database) {
  assert.equal(currentVersion(database), SCHEMA_VERSION);
  assert.equal(columnNames(database, "events").has("correlation_key"), true);
  assert.equal(columnNames(database, "delivery_waits").has("ordinal"), true);
  assert.equal(columnNames(database, "delivery_waits").has("wait_snapshot_json"), true);
  assert.equal(columnNames(database, "notification_outcomes").has("receipt_id"), true);
  assert.equal(columnNames(database, "notification_outcomes").has("attempt_count"), true);
  assert.ok(database.prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'events_trusted_correlation'",
  ).get());
  assert.deepEqual(database.prepare("PRAGMA quick_check").all().map(row => row.quick_check), ["ok"]);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
}

function currentVersion(database) {
  return database.prepare("SELECT MAX(version) AS version FROM relay_schema").get().version;
}

function columnNames(database, table) {
  return new Set(database.prepare(`PRAGMA table_info("${table}")`).all().map(column => column.name));
}

function findBackups(directory) {
  return readdirSync(directory).filter(name => name.includes(".backup-v") && name.endsWith(".sqlite"));
}
