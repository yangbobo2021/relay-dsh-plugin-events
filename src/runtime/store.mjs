import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.mjs";

export class RelayStore {
  constructor(path = ":memory:", { clock = () => new Date(), idFactory = randomUUID } = {}) {
    this.clock = clock;
    this.idFactory = idFactory;
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec(SCHEMA_SQL);
    const schemaVersion = this.database
      .prepare("SELECT MAX(version) AS version FROM relay_schema")
      .get().version;
    if (schemaVersion == null) {
      this.database
        .prepare("INSERT INTO relay_schema (version, applied_at) VALUES (?, ?)")
        .run(SCHEMA_VERSION, this.now());
    } else {
      assert.ok(schemaVersion <= SCHEMA_VERSION, `unsupported schema version ${schemaVersion}`);
      if (schemaVersion < SCHEMA_VERSION) {
        this.migrateSchema(schemaVersion);
        this.database
          .prepare("INSERT INTO relay_schema (version, applied_at) VALUES (?, ?)")
          .run(SCHEMA_VERSION, this.now());
      }
    }
    this.database
      .prepare("INSERT OR IGNORE INTO runtime_counters (name, value) VALUES ('routing_epoch', 0)")
      .run();
  }

  migrateSchema(fromVersion) {
    if (fromVersion < 3) {
      const runColumns = this.database.prepare("PRAGMA table_info(runs)").all();
      if (!runColumns.some((column) => column.name === "activation_id")) {
        this.transaction(() => {
          this.database.exec("ALTER TABLE runs ADD COLUMN activation_id TEXT");
          const runs = this.database.prepare("SELECT * FROM runs ORDER BY started_at, id").all();
          for (const run of runs) {
            const activationId = `legacy-${run.id}`;
            const state = run.state === "running" ? "active" : "committed";
            const timestamp = run.finished_at ?? run.started_at;
            this.database
              .prepare(`
                INSERT INTO activations (
                  id, session_id, trigger_type, state, delivery_ids_json,
                  provisional_outcome_json, provisional_at, committed_at,
                  created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `)
              .run(
                activationId,
                run.session_id,
                run.trigger_type,
                state,
                run.delivery_ids_json,
                run.outcome_json,
                run.outcome_json == null ? null : timestamp,
                state === "committed" ? timestamp : null,
                run.started_at,
                timestamp,
              );
            this.database
              .prepare("UPDATE runs SET activation_id = ? WHERE id = ?")
              .run(activationId, run.id);
          }
        });
      }
    }
    if (fromVersion < 4) {
      const columns = this.database.prepare("PRAGMA table_info(activations)").all();
      const names = new Set(columns.map((column) => column.name));
      for (const [name, type] of [
        ["lease_owner", "TEXT"],
        ["lease_expires_at", "TEXT"],
        ["accepted_at", "TEXT"],
        ["last_error", "TEXT"],
      ]) {
        if (!names.has(name)) {
          this.database.exec(`ALTER TABLE activations ADD COLUMN ${name} ${type}`);
        }
      }
      this.transaction(() => {
        this.database.exec(`
          ALTER TABLE routing_decisions RENAME TO routing_decisions_v3;
          CREATE TABLE routing_decisions (
            id TEXT PRIMARY KEY,
            event_id TEXT NOT NULL UNIQUE REFERENCES events(id),
            disposition TEXT NOT NULL CHECK (disposition IN ('deliver', 'escalate', 'dismiss')),
            actionable INTEGER NOT NULL CHECK (actionable IN (0, 1)),
            summary TEXT NOT NULL,
            evidence_json TEXT NOT NULL,
            decision_json TEXT NOT NULL,
            created_at TEXT NOT NULL
          ) STRICT;
          INSERT INTO routing_decisions (
            id, event_id, disposition, actionable, summary,
            evidence_json, decision_json, created_at
          )
          SELECT id, event_id,
            CASE disposition WHEN 'spawn' THEN 'escalate' ELSE disposition END,
            actionable, summary, evidence_json, decision_json, created_at
          FROM routing_decisions_v3;
          DROP TABLE routing_decisions_v3;
        `);
      });
    }
    if (fromVersion < 5) {
      const columns = this.database.prepare("PRAGMA table_info(delivery_waits)").all();
      const names = new Set(columns.map((column) => column.name));
      if (!names.has("ordinal")) {
        this.database.exec("ALTER TABLE delivery_waits ADD COLUMN ordinal INTEGER NOT NULL DEFAULT 0");
      }
      if (!names.has("wait_snapshot_json")) {
        this.database.exec("ALTER TABLE delivery_waits ADD COLUMN wait_snapshot_json TEXT");
      }
    }
    if (fromVersion < 6) {
      const columns = this.database.prepare("PRAGMA table_info(monitors)").all();
      const names = new Set(columns.map((column) => column.name));
      for (const [name, type] of [
        ["paused", "INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1))"],
        ["terminal_reason_code", "TEXT"],
        ["terminal_reason_detail", "TEXT"],
        ["terminal_actor", "TEXT"],
        ["terminal_at", "TEXT"],
      ]) {
        if (!names.has(name)) this.database.exec(`ALTER TABLE monitors ADD COLUMN ${name} ${type}`);
      }
    }
    if (fromVersion < 7) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS notification_outcomes (
          event_id TEXT PRIMARY KEY REFERENCES events(id),
          provider TEXT,
          state TEXT NOT NULL CHECK (state IN ('delivered', 'unavailable', 'failed')),
          error_class TEXT,
          attempted_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
      `);
    }
    if (fromVersion < 8) {
      const columns = this.database.prepare("PRAGMA table_info(events)").all();
      if (!columns.some(column => column.name === "correlation_key")) {
        this.database.exec("ALTER TABLE events ADD COLUMN correlation_key TEXT");
      }
      this.database.exec("CREATE UNIQUE INDEX IF NOT EXISTS events_trusted_correlation ON events(correlation_key) WHERE correlation_key IS NOT NULL");
    }
    if (fromVersion < 9) {
      const columns = new Set(this.database.prepare("PRAGMA table_info(activations)").all().map(column => column.name));
      for (const [name, type] of [
        ["attempt_count", "INTEGER NOT NULL DEFAULT 0"],
        ["next_attempt_at", "TEXT"],
        ["terminal_reason_code", "TEXT"],
        ["terminal_at", "TEXT"],
      ]) {
        if (!columns.has(name)) this.database.exec(`ALTER TABLE activations ADD COLUMN ${name} ${type}`);
      }
    }
    if (fromVersion < 10) {
      const columns = new Set(this.database.prepare("PRAGMA table_info(notification_outcomes)").all().map(column => column.name));
      if (!columns.has("receipt_id")) this.database.exec("ALTER TABLE notification_outcomes ADD COLUMN receipt_id TEXT");
      if (!columns.has("attempt_count")) this.database.exec("ALTER TABLE notification_outcomes ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0");
    }
  }

  close() {
    this.database.close();
  }

  getWaitRegistration(sessionId) {
    const row = this.database.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId);
    return row ? hydrateWaitRegistration(row, this.getWaits(sessionId)) : null;
  }

  inspectWaitRegistration(sessionId) {
    const session = this.getWaitRegistration(sessionId);
    if (!session) {
      return null;
    }
    const deliveries = this.database
      .prepare("SELECT * FROM deliveries WHERE session_id = ? ORDER BY created_at, id")
      .all(sessionId)
      .map((row) => this.hydrateDelivery(row));
    return { ...session, deliveries, monitors: this.getMonitors(sessionId) };
  }

  registerWaits({
    sessionId,
    taskSummary,
    context = {},
    waits,
    monitors = [],
    monitorRearms = [],
  }) {
    assert.ok(sessionId, "DSH session id is required");
    assert.ok(Array.isArray(waits) && waits.length > 0, "at least one wait is required");
    return this.transaction(() => {
      const timestamp = this.now();
      const existing = this.database.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId);
      if (!existing) {
        this.insertSession({ sessionId, taskSummary, context, state: "waiting" });
      } else {
        this.database
          .prepare(`
            UPDATE waits
            SET status = 'superseded', version = version + 1, updated_at = ?
            WHERE session_id = ? AND status IN ('active', 'claimed')
          `)
          .run(timestamp, sessionId);
        this.cancelEndedMonitors(
          sessionId,
          monitorRearms.map((rearm) => rearm.monitor_id),
          timestamp,
        );
        this.database
          .prepare(`
            UPDATE sessions
            SET state = 'waiting', task_summary = ?, context_json = ?,
                lease_owner = NULL, lease_expires_at = NULL,
                version = version + 1, updated_at = ?
            WHERE id = ?
          `)
          .run(taskSummary, encodeJson(context), timestamp, sessionId);
      }
      this.insertWaits(sessionId, waits);
      this.insertMonitors(sessionId, monitors);
      if (monitorRearms.length > 0) {
        this.rearmMonitors(sessionId, monitorRearms, timestamp);
      }
      this.bumpRoutingEpoch();
      return this.inspectWaitRegistration(sessionId);
    });
  }

  cancelWaits(sessionId) {
    return this.transaction(() => {
      const row = this.requireWaitRegistrationRow(sessionId);
      const timestamp = this.now();
      this.database
        .prepare(`
          UPDATE waits
          SET status = 'cancelled', version = version + 1, updated_at = ?
          WHERE session_id = ? AND status IN ('active', 'claimed')
        `)
        .run(timestamp, sessionId);
      this.cancelEndedMonitors(sessionId, [], timestamp);
      this.database
        .prepare(`
          UPDATE sessions
          SET state = 'created', lease_owner = NULL, lease_expires_at = NULL,
              version = version + 1, updated_at = ?
          WHERE id = ?
        `)
        .run(timestamp, sessionId);
      this.bumpRoutingEpoch();
      return hydrateWaitRegistration(this.requireWaitRegistrationRow(row.id), this.getWaits(row.id));
    });
  }

  listWaitRegistrations() {
    return this.listAllWaitRegistrations()
      .filter((registration) =>
        registration.waits.some((wait) => wait.status === "active" || wait.status === "claimed") ||
        registration.monitors.some((monitor) =>
          new Set(["active", "paused", "triggered", "degraded"]).has(monitor.state)
        )
      );
  }

  listAllWaitRegistrations() {
    return this.database
      .prepare("SELECT * FROM sessions ORDER BY updated_at DESC, id")
      .all()
      .map((row) => ({
        ...hydrateWaitRegistration(row, this.getWaits(row.id)),
        monitors: this.getMonitors(row.id),
      }));
  }

  listEvents(limit = 100) {
    return this.listEventsPage({ limit }).items;
  }

  listEventsPage({ limit = 20, cursor = null } = {}) {
    assert.ok(Number.isSafeInteger(limit) && limit > 0 && limit <= 100, "Event history limit is invalid");
    const boundary = cursor == null ? null : decodeHistoryCursor(cursor);
    const rows = boundary == null
      ? this.database.prepare(`
          SELECT id, received_at FROM events
          ORDER BY received_at DESC, id DESC LIMIT ?
        `).all(limit + 1)
      : this.database.prepare(`
          SELECT id, received_at FROM events
          WHERE received_at < ? OR (received_at = ? AND id < ?)
          ORDER BY received_at DESC, id DESC LIMIT ?
        `).all(boundary.received_at, boundary.received_at, boundary.id, limit + 1);
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const last = pageRows.at(-1);
    return {
      items: pageRows.map(row => this.inspectEvent(row.id)),
      next_cursor: hasMore && last ? encodeHistoryCursor(last) : null,
      total: this.database.prepare("SELECT COUNT(*) AS count FROM events").get().count,
    };
  }

  getNotificationOutcome(eventId) {
    const row = this.database.prepare("SELECT * FROM notification_outcomes WHERE event_id = ?").get(eventId);
    return row ? {
      event_id: row.event_id,
      provider: row.provider,
      state: row.state,
      error_class: row.error_class,
      receipt_id: row.receipt_id,
      attempt_count: row.attempt_count,
      attempted_at: row.attempted_at,
      updated_at: row.updated_at,
    } : null;
  }

  recordNotificationOutcome(eventId, { provider = null, state, errorClass = null, receiptId = null }) {
    assert.ok(new Set(["delivered", "unavailable", "failed"]).has(state), "notification state is invalid");
    this.requireEventRow(eventId);
    const timestamp = this.now();
    this.database.prepare(`
      INSERT INTO notification_outcomes (event_id, provider, state, error_class, receipt_id, attempt_count, attempted_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(event_id) DO UPDATE SET provider=excluded.provider, state=excluded.state,
        error_class=excluded.error_class, receipt_id=excluded.receipt_id,
        attempt_count=notification_outcomes.attempt_count + 1, updated_at=excluded.updated_at
    `).run(eventId, provider, state, errorClass, receiptId, timestamp, timestamp);
    return this.getNotificationOutcome(eventId);
  }

  listQueuedDeliverySessionIds() {
    return this.database
      .prepare(`
        SELECT DISTINCT session_id
        FROM deliveries
        WHERE state = 'queued'
        ORDER BY session_id
      `)
      .all()
      .map(row => row.session_id);
  }

  listRoutableEventIds(limit = 100) {
    return this.database
      .prepare(`
        SELECT id
        FROM events
        WHERE state IN ('received', 'routing')
        ORDER BY received_at, id
        LIMIT ?
      `)
      .all(limit)
      .map(row => row.id);
  }

  countRoutingAttempts(eventId) {
    return this.database
      .prepare("SELECT COUNT(*) AS count FROM routing_attempts WHERE event_id = ?")
      .get(eventId).count;
  }

  getActivation(activationId) {
    const row = this.database.prepare("SELECT * FROM activations WHERE id = ?").get(activationId);
    return row ? hydrateActivation(row) : null;
  }

  beginDispatch(sessionId, owner, leaseMs) {
    return this.transaction(() => {
      this.requireWaitRegistrationRow(sessionId);
      const nowDate = this.clock();
      const now = toIso(nowDate);
      let activationRow = this.database
        .prepare("SELECT * FROM activations WHERE session_id = ? AND state = 'active'")
        .get(sessionId);

      if (activationRow?.lease_owner && activationRow.lease_expires_at > now) {
        return { status: "busy" };
      }
      if (activationRow?.next_attempt_at && activationRow.next_attempt_at > now) {
        return { status: "retry_scheduled", activation: hydrateActivation(activationRow) };
      }

      let deliveryRows;
      if (activationRow) {
        deliveryRows = decodeJson(activationRow.delivery_ids_json).map((deliveryId) => {
          const row = this.database.prepare("SELECT * FROM deliveries WHERE id = ?").get(deliveryId);
          assert.ok(row, `activation delivery ${deliveryId} does not exist`);
          assert.equal(row.state, "queued", `activation delivery ${deliveryId} is not queued`);
          return row;
        });
      } else {
        deliveryRows = this.database
          .prepare(`
            SELECT * FROM deliveries
            WHERE session_id = ? AND state = 'queued'
            ORDER BY created_at, id
          `)
          .all(sessionId);
        if (deliveryRows.length === 0) return { status: "no_work" };
        const activationId = this.idFactory();
        this.database
          .prepare(`
            INSERT INTO activations (
              id, session_id, trigger_type, state, delivery_ids_json, created_at, updated_at
            ) VALUES (?, ?, 'event', 'active', ?, ?, ?)
          `)
          .run(
            activationId,
            sessionId,
            encodeJson(deliveryRows.map((row) => row.id)),
            now,
            now,
          );
        activationRow = this.database.prepare("SELECT * FROM activations WHERE id = ?").get(activationId);
      }

      const leaseExpiresAt = new Date(nowDate.getTime() + leaseMs).toISOString();
      this.database
        .prepare(`
          UPDATE activations
          SET lease_owner = ?, lease_expires_at = ?, last_error = NULL,
              next_attempt_at = NULL, updated_at = ?
          WHERE id = ? AND state = 'active'
        `)
        .run(owner, leaseExpiresAt, now, activationRow.id);

      return {
        status: "started",
        activation: this.getActivation(activationRow.id),
        session: this.getWaitRegistration(sessionId),
        deliveries: deliveryRows.map((row) => this.hydrateDelivery(row, true)),
      };
    });
  }

  completeDispatch(sessionId, activationId, owner) {
    return this.transaction(() => {
      const activation = this.database.prepare("SELECT * FROM activations WHERE id = ?").get(activationId);
      assert.ok(activation, `activation ${activationId} does not exist`);
      assert.equal(activation.session_id, sessionId, `activation ${activationId} has wrong session`);
      assert.equal(activation.state, "active", `activation ${activationId} is not active`);
      assert.equal(activation.lease_owner, owner, `worker does not own activation ${activationId}`);
      const timestamp = this.now();
      const deliveryIds = decodeJson(activation.delivery_ids_json);
      const eventIds = new Set();
      for (const deliveryId of deliveryIds) {
        const delivery = this.database.prepare("SELECT * FROM deliveries WHERE id = ?").get(deliveryId);
        assert.ok(delivery, `delivery ${deliveryId} does not exist`);
        assert.equal(delivery.state, "queued", `delivery ${deliveryId} is not queued`);
        eventIds.add(delivery.event_id);
        this.database
          .prepare("UPDATE deliveries SET state = 'resolved', updated_at = ? WHERE id = ?")
          .run(timestamp, deliveryId);
        this.database
          .prepare(`
            UPDATE waits
            SET status = 'consumed', version = version + 1, updated_at = ?
            WHERE id IN (SELECT wait_id FROM delivery_waits WHERE delivery_id = ?)
              AND status = 'claimed'
          `)
          .run(timestamp, deliveryId);
      }
      const pausedRecurringMonitorIds = this.database
        .prepare(`
          SELECT id FROM monitors
          WHERE session_id = ? AND lifecycle = 'recurring' AND state = 'triggered'
        `)
        .all(sessionId)
        .map((row) => row.id);
      this.cancelEndedMonitors(sessionId, pausedRecurringMonitorIds, timestamp);
      for (const eventId of eventIds) {
        const unresolved = this.database
          .prepare("SELECT COUNT(*) AS count FROM deliveries WHERE event_id = ? AND state != 'resolved'")
          .get(eventId).count;
        if (unresolved === 0) {
          this.database
            .prepare(`
              UPDATE events
              SET state = 'resolved', version = version + 1, updated_at = ?
              WHERE id = ?
            `)
            .run(timestamp, eventId);
        }
      }
      this.database
        .prepare(`
          UPDATE activations
          SET state = 'committed', accepted_at = ?, committed_at = ?,
              lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE id = ?
        `)
        .run(timestamp, timestamp, timestamp, activationId);
      const liveWaits = this.database
        .prepare("SELECT COUNT(*) AS count FROM waits WHERE session_id = ? AND status IN ('active', 'claimed')")
        .get(sessionId).count;
      this.database
        .prepare(`
          UPDATE sessions
          SET state = ?, version = version + 1, updated_at = ?
          WHERE id = ?
        `)
        .run(liveWaits > 0 ? "waiting" : "created", timestamp, sessionId);
      this.bumpRoutingEpoch();
      return this.inspectWaitRegistration(sessionId);
    });
  }

  failDispatch(sessionId, activationId, owner, error, { failureLimit = 5, baseDelayMs = 1_000 } = {}) {
    return this.transaction(() => {
      const activation = this.database.prepare("SELECT * FROM activations WHERE id = ?").get(activationId);
      assert.ok(activation, `activation ${activationId} does not exist`);
      assert.equal(activation.session_id, sessionId, `activation ${activationId} has wrong session`);
      assert.equal(activation.state, "active", `activation ${activationId} is not active`);
      assert.equal(activation.lease_owner, owner, `worker does not own activation ${activationId}`);
      assert.ok(Number.isSafeInteger(failureLimit) && failureLimit > 0, "delivery failure limit must be positive");
      assert.ok(Number.isSafeInteger(baseDelayMs) && baseDelayMs > 0, "delivery retry base delay must be positive");
      const attemptCount = (activation.attempt_count ?? 0) + 1;
      const timestamp = this.now();
      if (attemptCount < failureLimit) {
        const delay = Math.min(baseDelayMs * (2 ** (attemptCount - 1)), 3_600_000);
        const nextAttemptAt = new Date(this.clock().getTime() + delay).toISOString();
        this.database.prepare(`
          UPDATE activations
          SET lease_owner = NULL, lease_expires_at = NULL, last_error = ?,
              attempt_count = ?, next_attempt_at = ?, updated_at = ?
          WHERE id = ?
        `).run(error, attemptCount, nextAttemptAt, timestamp, activationId);
        return { status: "retry", activation: this.getActivation(activationId), eventIds: [] };
      }

      const deliveryIds = decodeJson(activation.delivery_ids_json);
      const eventIds = new Set();
      for (const deliveryId of deliveryIds) {
        const delivery = this.database.prepare("SELECT * FROM deliveries WHERE id = ?").get(deliveryId);
        assert.ok(delivery, `delivery ${deliveryId} does not exist`);
        eventIds.add(delivery.event_id);
        this.database.prepare("UPDATE deliveries SET state = 'failed', updated_at = ? WHERE id = ?")
          .run(timestamp, deliveryId);
      }
      for (const eventId of eventIds) {
        const pending = this.database.prepare("SELECT COUNT(*) AS count FROM deliveries WHERE event_id = ? AND state IN ('queued', 'running')")
          .get(eventId).count;
        if (pending === 0) this.database.prepare("UPDATE events SET state = 'resolved', version = version + 1, updated_at = ? WHERE id = ?")
          .run(timestamp, eventId);
      }
      this.database.prepare(`
        UPDATE activations
        SET state = 'committed', lease_owner = NULL, lease_expires_at = NULL,
            last_error = ?, attempt_count = ?, next_attempt_at = NULL,
            terminal_reason_code = 'delivery_retry_exhausted', terminal_at = ?,
            committed_at = ?, updated_at = ?
        WHERE id = ?
      `).run(error, attemptCount, timestamp, timestamp, timestamp, activationId);
      return { status: "failed", activation: this.getActivation(activationId), eventIds: [...eventIds] };
    });
  }

  retryActivation(activationId) {
    return this.transaction(() => {
      const row = this.database.prepare("SELECT * FROM activations WHERE id = ?").get(activationId);
      assert.ok(row, `activation ${activationId} does not exist`);
      assert.equal(row.state, "committed", `activation ${activationId} is not terminal`);
      assert.equal(row.terminal_reason_code, "delivery_retry_exhausted", `activation ${activationId} is not retryable`);
      const timestamp = this.now();
      const deliveryIds = decodeJson(row.delivery_ids_json);
      for (const deliveryId of deliveryIds) {
        const delivery = this.database.prepare("SELECT * FROM deliveries WHERE id = ?").get(deliveryId);
        assert.ok(delivery, `delivery ${deliveryId} does not exist`);
        assert.equal(delivery.state, "failed", `delivery ${deliveryId} is not failed`);
        this.database.prepare("UPDATE deliveries SET state = 'queued', updated_at = ? WHERE id = ?").run(timestamp, deliveryId);
        this.database.prepare("UPDATE events SET state = 'dispatched', version = version + 1, updated_at = ? WHERE id = ?")
          .run(timestamp, delivery.event_id);
      }
      this.database.prepare(`
        UPDATE activations
        SET state = 'active', attempt_count = 0, next_attempt_at = NULL,
            terminal_reason_code = NULL, terminal_at = NULL, committed_at = NULL,
            last_error = NULL, updated_at = ?
        WHERE id = ?
      `).run(timestamp, activationId);
      return this.getActivation(activationId);
    });
  }

  getWaits(sessionId) {
    return this.database
      .prepare("SELECT * FROM waits WHERE session_id = ? ORDER BY created_at, id")
      .all(sessionId)
      .map(hydrateWait);
  }

  getMonitor(monitorId) {
    const row = this.database.prepare("SELECT * FROM monitors WHERE id = ?").get(monitorId);
    return row ? this.hydrateMonitor(row) : null;
  }

  pauseMonitor(monitorId, { expectedVersion } = {}) {
    return this.transaction(() => {
      const row = this.requireMonitorRow(monitorId);
      if (expectedVersion != null) assert.equal(row.version, expectedVersion, `monitor ${monitorId} version changed`);
      assert.ok(new Set(["active", "degraded"]).has(row.state), `monitor ${monitorId} cannot be paused from ${row.state}`);
      assert.equal(Boolean(row.paused), false, `monitor ${monitorId} is already paused`);
      assert.ok(!row.lease_owner || row.lease_expires_at <= this.now(), `monitor ${monitorId} is busy`);
      this.database.prepare(`
        UPDATE monitors
        SET paused = 1, next_check_at = NULL, lease_owner = NULL,
            lease_expires_at = NULL, version = version + 1, updated_at = ?
        WHERE id = ?
      `).run(this.now(), monitorId);
      return this.inspectMonitor(monitorId);
    });
  }

  resumeMonitor(monitorId, { expectedVersion } = {}) {
    return this.transaction(() => {
      const row = this.requireMonitorRow(monitorId);
      if (expectedVersion != null) assert.equal(row.version, expectedVersion, `monitor ${monitorId} version changed`);
      assert.equal(Boolean(row.paused), true, `monitor ${monitorId} is not paused`);
      assert.ok(new Set(["active", "degraded"]).has(row.state), `monitor ${monitorId} cannot resume from ${row.state}`);
      const timestamp = this.now();
      this.database.prepare(`
        UPDATE monitors
        SET paused = 0, next_check_at = ?, version = version + 1, updated_at = ?
        WHERE id = ?
      `).run(nextMonitorCheckAt(decodeJson(row.schedule_json), this.clock()), timestamp, monitorId);
      return this.inspectMonitor(monitorId);
    });
  }

  updateMonitorCadence(monitorId, intervalSeconds, { expectedVersion } = {}) {
    assert.ok(Number.isSafeInteger(intervalSeconds) && intervalSeconds >= 1 && intervalSeconds <= 86_400, "monitor interval_seconds must be a whole number from 1 to 86400");
    return this.transaction(() => {
      const row = this.requireMonitorRow(monitorId);
      if (expectedVersion != null) assert.equal(row.version, expectedVersion, `monitor ${monitorId} version changed`);
      assert.ok(new Set(["active", "degraded"]).has(row.state), `monitor ${monitorId} cannot be updated from ${row.state}`);
      const schedule = { ...decodeJson(row.schedule_json), interval_seconds: intervalSeconds };
      const timestamp = this.now();
      this.database.prepare(`
        UPDATE monitors
        SET schedule_json = ?, next_check_at = ?, version = version + 1, updated_at = ?
        WHERE id = ?
      `).run(encodeJson(schedule), row.paused ? null : nextMonitorCheckAt(schedule, this.clock()), timestamp, monitorId);
      return this.inspectMonitor(monitorId);
    });
  }

  rebaselineMonitor(monitorId, prepared, { expectedVersion } = {}) {
    assert.ok(prepared?.baseline_observation && typeof prepared.baseline_observation === "object", "monitor baseline_observation is required");
    return this.transaction(() => {
      const row = this.requireMonitorRow(monitorId);
      if (expectedVersion != null) assert.equal(row.version, expectedVersion, `monitor ${monitorId} version changed`);
      assert.ok(new Set(["active", "degraded"]).has(row.state), `monitor ${monitorId} cannot be updated from ${row.state}`);
      assert.ok(!row.lease_owner || row.lease_expires_at <= this.now(), `monitor ${monitorId} is busy`);
      assert.equal(prepared.monitor_id, monitorId, "monitor identity cannot change during rebaseline");
      assert.equal(prepared.wait_id, row.wait_id, "monitor wait cannot change during rebaseline");
      const schedule = {
        interval_seconds: prepared.schedule?.interval_seconds ?? decodeJson(row.schedule_json).interval_seconds,
        jitter_seconds: prepared.schedule?.jitter_seconds ?? decodeJson(row.schedule_json).jitter_seconds ?? 0,
      };
      assert.ok(Number.isSafeInteger(schedule.interval_seconds) && schedule.interval_seconds >= 1 && schedule.interval_seconds <= 86_400,
        "monitor interval_seconds must be a whole number from 1 to 86400");
      assert.ok(Number.isSafeInteger(schedule.jitter_seconds) && schedule.jitter_seconds >= 0
        && schedule.jitter_seconds <= Math.min(schedule.interval_seconds, 3_600),
      "monitor jitter_seconds must be a bounded whole number no greater than interval_seconds");
      const retry = {
        degraded_after: prepared.retry?.degraded_after ?? decodeJson(row.retry_json).degraded_after,
        fail_after: prepared.retry?.fail_after ?? decodeJson(row.retry_json).fail_after,
        backoff_seconds: prepared.retry?.backoff_seconds ?? decodeJson(row.retry_json).backoff_seconds ?? [],
      };
      assert.ok(Number.isSafeInteger(retry.degraded_after) && retry.degraded_after >= 1 && retry.degraded_after <= 100,
        "monitor degraded_after must be a whole number from 1 to 100");
      assert.ok(Number.isSafeInteger(retry.fail_after) && retry.fail_after >= retry.degraded_after && retry.fail_after <= 100,
        "monitor fail_after must follow degraded_after and be at most 100");
      assert.ok(Array.isArray(retry.backoff_seconds) && retry.backoff_seconds.length <= 20
        && retry.backoff_seconds.every(value => Number.isSafeInteger(value) && value >= 1 && value <= 86_400),
      "monitor backoff_seconds must contain at most 20 whole-second delays from 1 to 86400");
      const observer = prepared.observer ?? (prepared.detector?.kind === "deadline_reached" ? { provider: "clock" } : null);
      const manifest = {
        observer,
        detector: prepared.detector,
        schedule,
        retry,
        capabilities: prepared.capabilities ?? {},
        artifact: prepared.artifact ?? { kind: "fixture" },
      };
      const versionId = this.idFactory();
      const timestamp = this.now();
      const artifactHash = prepared.artifact?.version_sha256 ?? prepared.artifact?.sha256 ?? hashJson(manifest);
      const existingVersion = this.database.prepare(`
        SELECT id, manifest_json FROM monitor_versions WHERE monitor_id = ? AND artifact_hash = ?
      `).get(monitorId, artifactHash);
      const activeVersionId = existingVersion?.id ?? versionId;
      if (existingVersion) {
        assert.deepEqual(decodeJson(existingVersion.manifest_json), manifest,
          `monitor ${monitorId} artifact hash conflicts with different version content`);
      } else {
        this.database.prepare(`
          INSERT INTO monitor_versions (id, monitor_id, artifact_hash, manifest_json, created_by_run_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(versionId, monitorId, artifactHash, encodeJson(manifest), prepared.created_by_run_id ?? null, timestamp);
      }
      const checkId = this.idFactory();
      this.database.prepare(`
        INSERT INTO monitor_checks (id, monitor_id, version_id, kind, state, started_at, finished_at)
        VALUES (?, ?, ?, 'baseline', 'succeeded', ?, ?)
      `).run(checkId, monitorId, activeVersionId, timestamp, timestamp);
      const sequence = this.database.prepare("SELECT COALESCE(MAX(sequence), -1) + 1 AS sequence FROM observations WHERE monitor_id = ?")
        .get(monitorId).sequence;
      this.database.prepare(`
        INSERT INTO observations (id, check_id, monitor_id, sequence, state_hash, data_json, observed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(this.idFactory(), checkId, monitorId, sequence, hashJson(prepared.baseline_observation),
        encodeJson(prepared.baseline_observation), timestamp);
      this.database.prepare(`
        UPDATE monitors
        SET active_version_id = ?, detector_json = ?, schedule_json = ?, retry_json = ?,
            capabilities_json = ?, next_check_at = ?, consecutive_failures = 0,
            state = 'active', version = version + 1, updated_at = ?
        WHERE id = ?
      `).run(activeVersionId, encodeJson(prepared.detector), encodeJson(schedule), encodeJson(retry),
        encodeJson(prepared.capabilities ?? {}), row.paused ? null : nextMonitorCheckAt(schedule, this.clock()),
        timestamp, monitorId);
      return this.inspectMonitor(monitorId);
    });
  }

  stopMonitor(monitorId, { expectedVersion, actor = "user", reasonCode = "stopped_by_user", detail = "" } = {}) {
    assert.ok(typeof actor === "string" && actor.length > 0 && actor.length <= 256, "monitor stop actor is invalid");
    assert.ok(typeof reasonCode === "string" && /^[a-z][a-z0-9._-]{0,127}$/u.test(reasonCode), "monitor stop reason code is invalid");
    assert.ok(typeof detail === "string" && detail.length <= 2000, "monitor stop detail is invalid");
    return this.transaction(() => {
      const row = this.requireMonitorRow(monitorId);
      if (expectedVersion != null) assert.equal(row.version, expectedVersion, `monitor ${monitorId} version changed`);
      assert.ok(!new Set(["completed", "failed", "expired", "cancelled"]).has(row.state), `monitor ${monitorId} is already terminal`);
      assert.ok(!row.lease_owner || row.lease_expires_at <= this.now(), `monitor ${monitorId} is busy`);
      const timestamp = this.now();
      this.database.prepare(`
        UPDATE monitors
        SET state = 'cancelled', paused = 0, next_check_at = NULL,
            lease_owner = NULL, lease_expires_at = NULL,
            terminal_reason_code = ?, terminal_reason_detail = ?, terminal_actor = ?, terminal_at = ?,
            version = version + 1, updated_at = ?
        WHERE id = ?
      `).run(reasonCode, detail, actor, timestamp, timestamp, monitorId);
      return this.inspectMonitor(monitorId);
    });
  }

  getMonitors(sessionId) {
    return this.database
      .prepare("SELECT * FROM monitors WHERE session_id = ? ORDER BY created_at, id")
      .all(sessionId)
      .map((row) => this.hydrateMonitor(row));
  }

  inspectMonitor(monitorId) {
    const monitor = this.getMonitor(monitorId);
    if (!monitor) {
      return null;
    }
    const versions = this.database
      .prepare("SELECT * FROM monitor_versions WHERE monitor_id = ? ORDER BY created_at, id")
      .all(monitorId)
      .map(hydrateMonitorVersion);
    const checks = this.database
      .prepare("SELECT * FROM monitor_checks WHERE monitor_id = ? ORDER BY started_at, id")
      .all(monitorId)
      .map(hydrateMonitorCheck);
    const observations = this.database
      .prepare("SELECT * FROM observations WHERE monitor_id = ? ORDER BY sequence")
      .all(monitorId)
      .map(hydrateObservation);
    const triggers = this.database
      .prepare("SELECT * FROM monitor_triggers WHERE monitor_id = ? ORDER BY created_at, id")
      .all(monitorId)
      .map(hydrateMonitorTrigger);
    return { ...monitor, versions, checks, observations, triggers };
  }

  ingestEvent(input, { allowCorrelation = false } = {}) {
    return this.transaction(() => {
      const correlationKey = allowCorrelation && typeof input.correlation_key === "string" && input.correlation_key.length > 0
        ? input.correlation_key : null;
      if (correlationKey != null) assert.ok(correlationKey.length <= 1024, "trusted Event correlation key is too long");
      const storedInput = correlationKey == null
        ? Object.fromEntries(Object.entries(input).filter(([key]) => key !== "correlation_key"))
        : input;
      const existing = this.findDuplicateEvent(storedInput, correlationKey);
      if (existing) {
        return { event: hydrateEvent(existing), duplicate: true };
      }

      const eventId = input.event_id ?? this.idFactory();
      const timestamp = this.now();
      this.database
        .prepare(`
          INSERT INTO events (
            id, source, source_event_id, fingerprint, correlation_key, payload_json,
            state, version, received_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'received', 0, ?, ?)
        `)
        .run(
          eventId,
          input.source,
          input.source_event_id ?? null,
          input.fingerprint,
          correlationKey,
          encodeJson(storedInput),
          timestamp,
          timestamp,
        );
      return { event: this.getEvent(eventId), duplicate: false };
    });
  }

  getEvent(eventId) {
    const row = this.database.prepare("SELECT * FROM events WHERE id = ?").get(eventId);
    return row ? hydrateEvent(row) : null;
  }

  inspectEvent(eventId) {
    const event = this.getEvent(eventId);
    if (!event) {
      return null;
    }
    const decisionRow = this.database
      .prepare("SELECT * FROM routing_decisions WHERE event_id = ?")
      .get(eventId);
    const deliveries = this.database
      .prepare("SELECT * FROM deliveries WHERE event_id = ? ORDER BY created_at, id")
      .all(eventId)
      .map((row) => this.hydrateDelivery(row));
    const routingAttempts = this.database
      .prepare("SELECT * FROM routing_attempts WHERE event_id = ? ORDER BY created_at, id")
      .all(eventId)
      .map(hydrateRoutingAttempt);
    const activations = this.database.prepare(`
      SELECT DISTINCT a.*
      FROM activations a, json_each(a.delivery_ids_json) ids
      JOIN deliveries d ON d.id = ids.value
      WHERE d.event_id = ?
      ORDER BY a.created_at, a.id
    `).all(eventId).map(hydrateActivation);
    return {
      ...event,
      decision: decisionRow ? hydrateDecision(decisionRow) : null,
      deliveries,
      routing_attempts: routingAttempts,
      activations,
      notification: this.getNotificationOutcome(eventId),
    };
  }

  beginRouting(eventId) {
    const state = this.transaction(() => {
      const eventRow = this.requireEventRow(eventId);
      const decision = this.database
        .prepare("SELECT id FROM routing_decisions WHERE event_id = ?")
        .get(eventId);
      if (decision) {
        return { alreadyRouted: true };
      }
      assert.ok(
        eventRow.state === "received" || eventRow.state === "routing",
        `event ${eventId} cannot route from ${eventRow.state}`,
      );
      if (eventRow.state === "received") {
        this.database
          .prepare(`
            UPDATE events
            SET state = 'routing', version = version + 1, updated_at = ?
            WHERE id = ?
          `)
          .run(this.now(), eventId);
      }
      return { alreadyRouted: false };
    });

    if (state.alreadyRouted) {
      return { alreadyRouted: true, result: this.getRoutingResult(eventId) };
    }

    return {
      alreadyRouted: false,
      event: this.getEvent(eventId),
      sessions: this.listRoutingCandidates(),
      routingEpoch: this.getRoutingEpoch(),
    };
  }

  listRoutingCandidates() {
    const sessionRows = this.database
      .prepare(`
        SELECT * FROM sessions
        WHERE state IN ('waiting', 'running')
        ORDER BY created_at, id
      `)
      .all();
    return sessionRows.map((row) => hydrateWaitRegistration(row, this.getWaits(row.id).filter((wait) =>
      wait.status === "active" || wait.status === "claimed"
    )));
  }

  recordRoutingAttempt({ eventId, pass = "final", router, model = null, output = null, usage = null, error = null }) {
    this.database
      .prepare(`
        INSERT INTO routing_attempts (
          id, event_id, pass, router, model, output_json, usage_json, error, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        this.idFactory(),
        eventId,
        pass,
        router,
        model,
        output == null ? null : encodeJson(output),
        usage == null ? null : encodeJson(usage),
        error,
        this.now(),
      );
  }

  commitRouting(snapshot, decision) {
    const committed = this.transaction(() => {
      const existingDecision = this.database
        .prepare("SELECT id FROM routing_decisions WHERE event_id = ?")
        .get(snapshot.event.event_id);
      if (existingDecision) {
        return { alreadyCommitted: true };
      }

      const eventRow = this.requireEventRow(snapshot.event.event_id);
      assert.equal(eventRow.state, "routing", `event ${eventRow.id} is not routing`);
      assert.equal(eventRow.version, snapshot.event.version, `event ${eventRow.id} version changed`);
      assert.equal(
        this.getRoutingEpoch(),
        snapshot.routingEpoch,
        `routing candidates changed for event ${eventRow.id}`,
      );

      const timestamp = this.now();
      this.database
        .prepare(`
          INSERT INTO routing_decisions (
            id, event_id, disposition, actionable, summary,
            evidence_json, decision_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          this.idFactory(),
          eventRow.id,
          decision.disposition,
          Number(decision.actionable),
          decision.summary,
          encodeJson(decision.evidence),
          encodeJson(decision),
          timestamp,
        );

      const deliveryIds = [];
      const sessionIds = [];

      if (decision.disposition === "deliver") {
        const snapshotSessions = new Map(
          snapshot.sessions.map((session) => [session.session_id, session]),
        );
        for (const delivery of decision.deliveries) {
          const snapshotSession = snapshotSessions.get(delivery.session_id);
          assert.ok(snapshotSession, `unknown snapshot session ${delivery.session_id}`);
          const sessionRow = this.requireWaitRegistrationRow(delivery.session_id);
          assert.equal(
            sessionRow.version,
            snapshotSession.version,
            `session ${sessionRow.id} version changed`,
          );
          const deliveryId = this.insertDelivery({
            eventId: eventRow.id,
            sessionId: delivery.session_id,
            relation: delivery.relation,
            confidence: delivery.confidence,
            timestamp,
          });
          deliveryIds.push(deliveryId);
          sessionIds.push(delivery.session_id);

          for (const [ordinal, waitId] of delivery.wait_ids.entries()) {
            const snapshotWait = snapshotSession.waits.find((wait) => wait.wait_id === waitId);
            assert.ok(snapshotWait, `unknown snapshot wait ${waitId}`);
            const waitRow = this.database.prepare("SELECT * FROM waits WHERE id = ?").get(waitId);
            assert.ok(waitRow, `wait ${waitId} no longer exists`);
            assert.equal(waitRow.status, "active", `wait ${waitId} is not active`);
            assert.equal(waitRow.version, snapshotWait.version, `wait ${waitId} version changed`);
            this.database
              .prepare(`
                INSERT INTO delivery_waits (
                  delivery_id, wait_id, ordinal, wait_snapshot_json
                ) VALUES (?, ?, ?, ?)
              `)
              .run(deliveryId, waitId, ordinal, encodeJson(snapshotWait));
            this.database
              .prepare(`
                UPDATE waits
                SET status = 'claimed', version = version + 1, updated_at = ?
                WHERE id = ?
              `)
              .run(timestamp, waitId);
          }
        }
      }

      const eventState = decision.disposition === "deliver" ? "dispatched" : "resolved";
      this.database
        .prepare(`
          UPDATE events
          SET state = ?, version = version + 1, updated_at = ?
          WHERE id = ?
        `)
        .run(eventState, timestamp, eventRow.id);
      if (decision.disposition === "deliver") {
        this.bumpRoutingEpoch();
      }

      return { alreadyCommitted: false, deliveryIds, sessionIds };
    });

    if (committed.alreadyCommitted) {
      return this.getRoutingResult(snapshot.event.event_id);
    }
    return this.getRoutingResult(snapshot.event.event_id);
  }

  getRoutingResult(eventId) {
    const decisionRow = this.database
      .prepare("SELECT * FROM routing_decisions WHERE event_id = ?")
      .get(eventId);
    if (!decisionRow) {
      return null;
    }
    const deliveries = this.database
      .prepare("SELECT * FROM deliveries WHERE event_id = ? ORDER BY created_at, id")
      .all(eventId)
      .map((row) => this.hydrateDelivery(row));
    return {
      decision: hydrateDecision(decisionRow),
      deliveries,
      sessionIds: [...new Set(deliveries.map((delivery) => delivery.session_id))],
    };
  }

  listDueMonitors(at = this.now(), limit = 100) {
    return this.database
      .prepare(`
        SELECT * FROM monitors
        WHERE state IN ('active', 'degraded')
          AND paused = 0
          AND next_check_at IS NOT NULL
          AND next_check_at <= ?
        ORDER BY next_check_at, id
        LIMIT ?
      `)
      .all(toIso(at), limit)
      .map((row) => this.hydrateMonitor(row));
  }

  cleanupRetention({ terminalBefore, limit = 1_000 } = {}) {
    const before = toIso(terminalBefore);
    assert.ok(Number.isSafeInteger(limit) && limit >= 1 && limit <= 10_000, "retention cleanup limit must be from 1 to 10000");
    return this.transaction(() => {
      const rows = this.database.prepare(`
        SELECT id FROM events
        WHERE state = 'resolved' AND updated_at < ?
          AND json_extract(payload_json, '$.__relay_retention_redacted') IS NOT 1
        ORDER BY updated_at, id
        LIMIT ?
      `).all(before, limit);
      const timestamp = this.now();
      for (const row of rows) {
        this.database.prepare(`
          UPDATE events
          SET payload_json = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND state = 'resolved'
        `).run(encodeJson({ __relay_retention_redacted: 1, redacted_at: timestamp }), timestamp, row.id);
        this.database.prepare(`
          UPDATE routing_attempts SET output_json = NULL, error = NULL
          WHERE event_id = ?
        `).run(row.id);
      }
      return {
        terminal_before: before,
        scanned: rows.length,
        redacted_events: rows.length,
        retained_events: this.database.prepare("SELECT COUNT(*) AS count FROM events").get().count,
        retained_decisions: this.database.prepare("SELECT COUNT(*) AS count FROM routing_decisions").get().count,
        retained_deliveries: this.database.prepare("SELECT COUNT(*) AS count FROM deliveries").get().count,
        retained_activations: this.database.prepare("SELECT COUNT(*) AS count FROM activations").get().count,
      };
    });
  }

  beginMonitorCheck(monitorId, owner, leaseMs, { force = false } = {}) {
    return this.transaction(() => {
      let row = this.requireMonitorRow(monitorId);
      if (row.paused) return { status: "paused", monitor: this.hydrateMonitor(row) };
      if (!new Set(["active", "degraded"]).has(row.state)) {
        return { status: "inactive", monitor: this.hydrateMonitor(row) };
      }

      const nowDate = this.clock();
      const now = toIso(nowDate);
      if (!force && (row.next_check_at == null || row.next_check_at > now)) {
        return { status: "not_due", monitor: this.hydrateMonitor(row) };
      }
      if (row.lease_owner && row.lease_expires_at > now) {
        return { status: "busy" };
      }
      if (row.lease_owner) {
        this.database
          .prepare(`
            UPDATE monitor_checks
            SET state = 'failed', error_class = 'lease_expired',
                error = 'monitor lease expired', finished_at = ?
            WHERE monitor_id = ? AND state = 'running'
          `)
          .run(now, monitorId);
      }

      const leaseExpiresAt = new Date(nowDate.getTime() + leaseMs).toISOString();
      this.database
        .prepare(`
          UPDATE monitors
          SET lease_owner = ?, lease_expires_at = ?, version = version + 1,
              updated_at = ?
          WHERE id = ?
        `)
        .run(owner, leaseExpiresAt, now, monitorId);
      row = this.requireMonitorRow(monitorId);

      const checkId = this.idFactory();
      this.database
        .prepare(`
          INSERT INTO monitor_checks (
            id, monitor_id, version_id, kind, state, started_at
          ) VALUES (?, ?, ?, 'scheduled', 'running', ?)
        `)
        .run(checkId, monitorId, row.active_version_id, now);

      return {
        status: "started",
        check_id: checkId,
        monitor: this.hydrateMonitor(row),
      };
    });
  }

  completeMonitorCheck(snapshot, owner, observation, proposedEvents) {
    assert.ok(observation && typeof observation === "object", "observation is required");
    assert.ok(Array.isArray(proposedEvents), "proposedEvents must be an array");
    assert.ok(proposedEvents.length <= 1, "initial Monitor slice emits at most one Event per check");

    return this.transaction(() => {
      const current = this.requireMonitorRow(snapshot.monitor.monitor_id);
      const proposal = proposedEvents[0];
      const correlationKey = typeof proposal?.correlation_key === "string" && proposal.correlation_key.length > 0
        ? proposal.correlation_key : null;
      const correlated = correlationKey == null ? null
        : this.database.prepare("SELECT id FROM events WHERE correlation_key = ?").get(correlationKey);
      const ownershipChanged = current.lease_owner !== owner
        || current.version !== snapshot.monitor.version
        || current.active_version_id !== snapshot.monitor.active_version_id;
      if (ownershipChanged && correlated) {
        const check = this.database.prepare("SELECT * FROM monitor_checks WHERE id = ?").get(snapshot.check_id);
        assert.ok(check, `monitor check ${snapshot.check_id} does not exist`);
        assert.equal(check.state, "running", `monitor check ${snapshot.check_id} is not running`);
        const timestamp = this.now();
        const prior = this.latestObservationRow(current.id);
        const sequence = (prior?.sequence ?? -1) + 1;
        this.database.prepare(`
          INSERT INTO observations (id, check_id, monitor_id, sequence, state_hash, data_json, observed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(this.idFactory(), snapshot.check_id, current.id, sequence, hashJson(observation), encodeJson(observation), timestamp);
        if (!this.database.prepare("SELECT event_id FROM monitor_triggers WHERE monitor_id = ? AND trigger_key = ?")
          .get(current.id, proposal.key)) {
          this.insertBoundMonitorEvent({ monitorRow: current, checkId: snapshot.check_id, proposal, claimWait: false, timestamp });
        }
        const nextState = current.lifecycle === "one_shot" ? "completed" : "triggered";
        this.database.prepare(`
          UPDATE monitors
          SET state = ?, paused = 0, next_check_at = NULL, consecutive_failures = 0,
              lease_owner = NULL, lease_expires_at = NULL,
              terminal_reason_code = NULL, terminal_reason_detail = NULL,
              terminal_actor = NULL, terminal_at = NULL,
              version = version + 1, updated_at = ?
          WHERE id = ?
        `).run(nextState, timestamp, current.id);
        this.database.prepare("UPDATE monitor_checks SET state = 'succeeded', finished_at = ? WHERE id = ? AND state = 'running'")
          .run(timestamp, snapshot.check_id);
        return {
          status: "converged",
          monitor: this.inspectMonitor(current.id),
          eventIds: [correlated.id],
          sessionIds: [],
        };
      }
      const row = this.requireMonitorCommit(snapshot, owner);
      const timestamp = this.now();
      const prior = this.latestObservationRow(row.id);
      const sequence = (prior?.sequence ?? -1) + 1;
      const observationId = this.idFactory();
      this.database
        .prepare(`
          INSERT INTO observations (
            id, check_id, monitor_id, sequence, state_hash, data_json, observed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          observationId,
          snapshot.check_id,
          row.id,
          sequence,
          hashJson(observation),
          encodeJson(observation),
          timestamp,
        );

      const eventIds = [];
      if (proposedEvents.length === 1 && !this.database.prepare(
        "SELECT event_id FROM monitor_triggers WHERE monitor_id = ? AND trigger_key = ?",
      ).get(row.id, proposedEvents[0].key)) {
        eventIds.push(this.insertBoundMonitorEvent({
          monitorRow: row,
          checkId: snapshot.check_id,
          proposal: proposedEvents[0],
          claimWait: true,
          timestamp,
        }));
      }

      const nextState = eventIds.length === 0
        ? "active"
        : row.lifecycle === "one_shot" ? "completed" : "triggered";
      const nextCheckAt = eventIds.length === 0
        ? nextMonitorCheckAt(decodeJson(row.schedule_json), this.clock())
        : null;
      this.database
        .prepare(`
          UPDATE monitors
          SET state = ?, next_check_at = ?, consecutive_failures = 0,
              lease_owner = NULL, lease_expires_at = NULL,
              version = version + 1, updated_at = ?
          WHERE id = ?
        `)
        .run(nextState, nextCheckAt, timestamp, row.id);
      this.database
        .prepare(`
          UPDATE monitor_checks
          SET state = 'succeeded', finished_at = ?
          WHERE id = ? AND state = 'running'
        `)
        .run(timestamp, snapshot.check_id);

      return {
        status: eventIds.length === 0 ? "observed" : "triggered",
        monitor: this.inspectMonitor(row.id),
        eventIds,
        sessionIds: eventIds.length === 0 ? [] : [row.session_id],
      };
    });
  }

  failMonitorCheck(snapshot, owner, errorClass, errorMessage) {
    return this.transaction(() => {
      const row = this.requireMonitorCommit(snapshot, owner);
      const timestamp = this.now();
      const retry = decodeJson(row.retry_json);
      const failures = row.consecutive_failures + 1;
      const failed = failures >= retry.fail_after;
      const nextState = failed
        ? "failed"
        : failures >= retry.degraded_after ? "degraded" : "active";
      const delaySeconds = retry.backoff_seconds?.[
        Math.min(failures - 1, retry.backoff_seconds.length - 1)
      ] ?? decodeJson(row.schedule_json).interval_seconds;
      const nextCheckAt = failed
        ? null
        : new Date(this.clock().getTime() + delaySeconds * 1000).toISOString();

      this.database
        .prepare(`
          UPDATE monitor_checks
          SET state = 'failed', error_class = ?, error = ?, finished_at = ?
          WHERE id = ? AND state = 'running'
        `)
        .run(errorClass, errorMessage, timestamp, snapshot.check_id);

      const eventIds = [];
      if (failed) {
        eventIds.push(this.insertBoundMonitorEvent({
          monitorRow: row,
          checkId: snapshot.check_id,
          proposal: {
            type: "monitor.failed",
            key: `${row.id}:failed:${errorClass}`,
            data: {
              monitor_id: row.id,
              error_class: errorClass,
              error: errorMessage,
              version_id: row.active_version_id,
            },
          },
          claimWait: false,
          timestamp,
        }));
      }

      this.database
        .prepare(`
          UPDATE monitors
          SET state = ?, next_check_at = ?, consecutive_failures = ?,
              lease_owner = NULL, lease_expires_at = NULL,
              version = version + 1, updated_at = ?
          WHERE id = ?
        `)
        .run(nextState, nextCheckAt, failures, timestamp, row.id);

      return {
        status: nextState,
        monitor: this.inspectMonitor(row.id),
        eventIds,
        sessionIds: eventIds.length === 0 ? [] : [row.session_id],
      };
    });
  }

  abandonMonitorCheck(snapshot, owner) {
    return this.transaction(() => {
      const row = this.requireMonitorCommit(snapshot, owner);
      this.database.prepare("UPDATE monitor_checks SET state = 'failed', error_class = 'cancelled', finished_at = ? WHERE id = ?")
        .run(this.now(), snapshot.check_id);
      this.database.prepare("UPDATE monitors SET lease_owner = NULL, lease_expires_at = NULL, version = version + 1 WHERE id = ?")
        .run(row.id);
      return { status: "aborted", monitor: this.inspectMonitor(row.id), sessionIds: [], eventIds: [] };
    });
  }

  expireMonitorCheck(snapshot, owner) {
    return this.transaction(() => {
      const row = this.requireMonitorCommit(snapshot, owner);
      const timestamp = this.now();
      this.database.prepare(`
        UPDATE monitor_checks
        SET state = 'failed', error_class = 'bundle_expired',
            error = 'custom Monitor Bundle expired', finished_at = ?
        WHERE id = ? AND state = 'running'
      `).run(timestamp, snapshot.check_id);
      this.database.prepare(`
        UPDATE monitors
        SET state = 'expired', paused = 0, next_check_at = NULL,
            consecutive_failures = 0, lease_owner = NULL, lease_expires_at = NULL,
            terminal_reason_code = 'bundle_expired',
            terminal_reason_detail = 'The custom Monitor Bundle reached its declared expiry.',
            terminal_actor = 'relay.monitors', terminal_at = ?,
            version = version + 1, updated_at = ?
        WHERE id = ?
      `).run(timestamp, timestamp, row.id);
      this.database.prepare(`
        UPDATE waits SET status = 'cancelled', version = version + 1, updated_at = ?
        WHERE id = ? AND status = 'active'
      `).run(timestamp, row.wait_id);
      const hasLiveWait = this.database.prepare("SELECT 1 FROM waits WHERE session_id = ? AND status IN ('active', 'claimed') LIMIT 1").get(row.session_id);
      if (!hasLiveWait) {
        this.database.prepare(`
          UPDATE sessions SET state = 'created', lease_owner = NULL, lease_expires_at = NULL,
              version = version + 1, updated_at = ? WHERE id = ?
        `).run(timestamp, row.session_id);
      }
      this.bumpRoutingEpoch();
      return { status: "expired", monitor: this.inspectMonitor(row.id), eventIds: [], sessionIds: [] };
    });
  }

  getRoutingEpoch() {
    return this.database
      .prepare("SELECT value FROM runtime_counters WHERE name = 'routing_epoch'")
      .get().value;
  }

  transaction(callback) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  now() {
    return toIso(this.clock());
  }

  insertSession({ sessionId, taskSummary, context, state }) {
    assert.ok(taskSummary, "task summary is required");
    const timestamp = this.now();
    this.database
      .prepare(`
        INSERT INTO sessions (
          id, state, task_summary, context_json, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 0, ?, ?)
      `)
      .run(sessionId, state, taskSummary, encodeJson(context), timestamp, timestamp);
  }

  insertWaits(sessionId, waits) {
    const timestamp = this.now();
    for (const wait of waits) {
      const waitId = wait.wait_id ?? this.idFactory();
      const card = {
        expected_event: wait.expected_event,
        caused_by: wait.caused_by,
        actors: wait.actors ?? [],
        entities: wait.entities ?? [],
        prior_exchange: wait.prior_exchange,
        continuation: wait.continuation,
      };
      this.database
        .prepare(`
          INSERT INTO waits (
            id, session_id, phase, status, exclusive, exclusive_owner_key,
            wait_card_json, version, created_at, updated_at
          ) VALUES (?, ?, ?, 'active', ?, ?, ?, 0, ?, ?)
        `)
        .run(
          waitId,
          sessionId,
          wait.phase,
          Number(wait.exclusive),
          wait.exclusive_owner_key ?? null,
          encodeJson(card),
          timestamp,
          timestamp,
        );
    }
  }

  insertMonitors(sessionId, monitors) {
    const timestamp = this.now();
    for (const monitor of monitors) {
      assert.ok(monitor.monitor_id, "monitor_id is required");
      assert.ok(monitor.wait_id, `monitor ${monitor.monitor_id} requires wait_id`);
      assert.ok(
        monitor.lifecycle === "one_shot" || monitor.lifecycle === "recurring",
        `monitor ${monitor.monitor_id} has invalid lifecycle`,
      );
      assert.equal(
        monitor.fire_on_initial_match ?? false,
        false,
        "fire_on_initial_match is outside the initial Monitor slice",
      );
      assert.ok(monitor.detector && typeof monitor.detector === "object", "monitor detector is required");
      assert.ok(
        monitor.baseline_observation && typeof monitor.baseline_observation === "object",
        "monitor baseline_observation is required",
      );

      const waitRow = this.database.prepare("SELECT * FROM waits WHERE id = ?").get(monitor.wait_id);
      assert.ok(waitRow, `monitor wait ${monitor.wait_id} does not exist`);
      assert.equal(waitRow.session_id, sessionId, `monitor wait ${monitor.wait_id} has wrong owner`);
      assert.equal(waitRow.status, "active", `monitor wait ${monitor.wait_id} is not active`);

      const schedule = {
        interval_seconds: monitor.schedule?.interval_seconds ?? 60,
        jitter_seconds: monitor.schedule?.jitter_seconds ?? 0,
      };
      assert.ok(Number.isSafeInteger(schedule.interval_seconds) && schedule.interval_seconds >= 1 && schedule.interval_seconds <= 86_400,
        "monitor interval_seconds must be a whole number from 1 to 86400");
      assert.ok(Number.isSafeInteger(schedule.jitter_seconds) && schedule.jitter_seconds >= 0
        && schedule.jitter_seconds <= Math.min(schedule.interval_seconds, 3_600),
      "monitor jitter_seconds must be a bounded whole number no greater than interval_seconds");
      const retry = {
        degraded_after: monitor.retry?.degraded_after ?? 1,
        fail_after: monitor.retry?.fail_after ?? 3,
        backoff_seconds: monitor.retry?.backoff_seconds ?? [],
      };
      assert.ok(Number.isSafeInteger(retry.degraded_after) && retry.degraded_after >= 1 && retry.degraded_after <= 100,
        "monitor degraded_after must be a whole number from 1 to 100");
      assert.ok(Number.isSafeInteger(retry.fail_after) && retry.fail_after >= retry.degraded_after && retry.fail_after <= 100,
        "monitor fail_after must follow degraded_after and be at most 100");
      assert.ok(Array.isArray(retry.backoff_seconds) && retry.backoff_seconds.length <= 20
        && retry.backoff_seconds.every(value => Number.isSafeInteger(value) && value >= 1 && value <= 86_400),
      "monitor backoff_seconds must contain at most 20 whole-second delays from 1 to 86400");

      const versionId = this.idFactory();
      const manifest = {
        observer: monitor.observer ?? (monitor.detector.kind === "deadline_reached" ? { provider: "clock" } : null),
        detector: monitor.detector,
        schedule,
        retry,
        capabilities: monitor.capabilities ?? {},
        artifact: monitor.artifact ?? { kind: "fixture" },
      };
      const artifactHash = monitor.artifact?.version_sha256 ?? monitor.artifact?.sha256 ?? hashJson(manifest);
      this.database
        .prepare(`
          INSERT INTO monitors (
            id, session_id, wait_id, state, lifecycle, fire_on_initial_match,
            active_version_id, detector_json, schedule_json, retry_json,
            capabilities_json, next_check_at, consecutive_failures, version,
            created_at, updated_at
          ) VALUES (?, ?, ?, 'active', ?, 0, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
        `)
        .run(
          monitor.monitor_id,
          sessionId,
          monitor.wait_id,
          monitor.lifecycle,
          versionId,
          encodeJson(monitor.detector),
          encodeJson(schedule),
          encodeJson(retry),
          encodeJson(monitor.capabilities ?? {}),
          nextMonitorCheckAt(schedule, this.clock()),
          timestamp,
          timestamp,
        );
      this.database
        .prepare(`
          INSERT INTO monitor_versions (
            id, monitor_id, artifact_hash, manifest_json, created_by_run_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(
          versionId,
          monitor.monitor_id,
          artifactHash,
          encodeJson(manifest),
          monitor.created_by_run_id ?? null,
          timestamp,
        );

      const checkId = this.idFactory();
      this.database
        .prepare(`
          INSERT INTO monitor_checks (
            id, monitor_id, version_id, kind, state, started_at, finished_at
          ) VALUES (?, ?, ?, 'baseline', 'succeeded', ?, ?)
        `)
        .run(checkId, monitor.monitor_id, versionId, timestamp, timestamp);
      this.database
        .prepare(`
          INSERT INTO observations (
            id, check_id, monitor_id, sequence, state_hash, data_json, observed_at
          ) VALUES (?, ?, ?, 0, ?, ?, ?)
        `)
        .run(
          this.idFactory(),
          checkId,
          monitor.monitor_id,
          hashJson(monitor.baseline_observation),
          encodeJson(monitor.baseline_observation),
          timestamp,
        );
    }
  }

  rearmMonitors(sessionId, rearms, timestamp) {
    const rearmIds = new Set(rearms.map((rearm) => rearm.monitor_id));
    assert.equal(rearmIds.size, rearms.length, "monitor rearm IDs must be unique");
    for (const rearm of rearms) {
      const row = this.requireMonitorRow(rearm.monitor_id);
      assert.equal(row.session_id, sessionId, `monitor ${row.id} has wrong owner`);
      assert.equal(row.lifecycle, "recurring", `monitor ${row.id} is not recurring`);
      assert.equal(row.state, "triggered", `monitor ${row.id} is not triggered`);
      const waitRow = this.database.prepare("SELECT * FROM waits WHERE id = ?").get(rearm.wait_id);
      assert.ok(waitRow, `rearm wait ${rearm.wait_id} does not exist`);
      assert.equal(waitRow.session_id, sessionId, `rearm wait ${rearm.wait_id} has wrong owner`);
      assert.equal(waitRow.status, "active", `rearm wait ${rearm.wait_id} is not active`);
      this.database
        .prepare(`
          UPDATE monitors
          SET wait_id = ?, state = 'active', next_check_at = ?,
              consecutive_failures = 0, version = version + 1, updated_at = ?
          WHERE id = ?
        `)
        .run(
          rearm.wait_id,
          nextMonitorCheckAt(decodeJson(row.schedule_json), this.clock()),
          timestamp,
          row.id,
        );
    }
  }

  cancelEndedMonitors(sessionId, rearmIds, timestamp) {
    const excluded = new Set(rearmIds);
    const rows = this.database
      .prepare(`
        SELECT m.id
        FROM monitors m
        JOIN waits w ON w.id = m.wait_id
        WHERE m.session_id = ?
          AND m.state IN ('active', 'degraded', 'triggered')
          AND w.status IN ('consumed', 'superseded', 'cancelled')
      `)
      .all(sessionId);
    for (const row of rows) {
      if (excluded.has(row.id)) {
        continue;
      }
      this.database
        .prepare(`
          UPDATE monitors
          SET state = 'cancelled', next_check_at = NULL,
              lease_owner = NULL, lease_expires_at = NULL,
              version = version + 1, updated_at = ?
          WHERE id = ?
        `)
        .run(timestamp, row.id);
    }
  }

  insertDelivery({ eventId, sessionId, relation, confidence, timestamp }) {
    const deliveryId = this.idFactory();
    this.database
      .prepare(`
        INSERT INTO deliveries (
          id, event_id, session_id, state, relation, confidence, created_at, updated_at
        ) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)
      `)
      .run(deliveryId, eventId, sessionId, relation, confidence, timestamp, timestamp);
    return deliveryId;
  }

  hydrateDelivery(row, includeEvent = false) {
    const matchedWaitRows = this.database
      .prepare(`
        SELECT dw.wait_id, dw.ordinal, dw.wait_snapshot_json, w.*
        FROM delivery_waits dw
        JOIN waits w ON w.id = dw.wait_id
        WHERE dw.delivery_id = ?
        ORDER BY dw.ordinal, dw.wait_id
      `)
      .all(row.id);
    const waitIds = matchedWaitRows.map((item) => item.wait_id);
    const matchedWaits = matchedWaitRows.map((item) => item.wait_snapshot_json == null
      ? hydrateWait(item)
      : decodeJson(item.wait_snapshot_json));
    const decision = this.database
      .prepare("SELECT evidence_json FROM routing_decisions WHERE event_id = ?")
      .get(row.event_id);
    const delivery = {
      delivery_id: row.id,
      event_id: row.event_id,
      session_id: row.session_id,
      state: row.state,
      wait_ids: waitIds,
      matched_waits: matchedWaits,
      relation: row.relation,
      routing_evidence: decision ? decodeJson(decision.evidence_json) : [],
      confidence: row.confidence,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
    if (includeEvent) {
      delivery.event = this.getEvent(row.event_id)?.payload ?? null;
    }
    return delivery;
  }

  findDuplicateEvent(input, correlationKey = null) {
    // A provider's delivery identity is the stronger invariant. Validate it
    // before cross-source convergence so a reused delivery id with mutated
    // content can never be hidden by a matching correlation key.
    if (input.source_event_id != null) {
      const bySourceId = this.database
        .prepare("SELECT * FROM events WHERE source = ? AND source_event_id = ?")
        .get(input.source, input.source_event_id);
      if (bySourceId) {
        assert.equal(
          bySourceId.fingerprint,
          input.fingerprint,
          `source Event identity ${input.source}/${input.source_event_id} was reused with conflicting content`,
        );
        return bySourceId;
      }
    }
    if (correlationKey != null) {
      const correlated = this.database.prepare("SELECT * FROM events WHERE correlation_key = ?").get(correlationKey);
      if (correlated) return correlated;
    }
    return this.database
      .prepare("SELECT * FROM events WHERE source = ? AND fingerprint = ?")
      .get(input.source, input.fingerprint);
  }

  requireEventRow(eventId) {
    const row = this.database.prepare("SELECT * FROM events WHERE id = ?").get(eventId);
    assert.ok(row, `event ${eventId} does not exist`);
    return row;
  }

  requireWaitRegistrationRow(sessionId) {
    const row = this.database.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId);
    assert.ok(row, `session ${sessionId} does not exist`);
    return row;
  }

  requireMonitorRow(monitorId) {
    const row = this.database.prepare("SELECT * FROM monitors WHERE id = ?").get(monitorId);
    assert.ok(row, `monitor ${monitorId} does not exist`);
    return row;
  }

  requireMonitorCommit(snapshot, owner) {
    const row = this.requireMonitorRow(snapshot.monitor.monitor_id);
    assert.equal(row.lease_owner, owner, `worker does not own monitor ${row.id}`);
    assert.equal(row.version, snapshot.monitor.version, `monitor ${row.id} version changed`);
    assert.equal(row.active_version_id, snapshot.monitor.active_version_id, `monitor ${row.id} version changed`);
    const check = this.database.prepare("SELECT * FROM monitor_checks WHERE id = ?").get(snapshot.check_id);
    assert.ok(check, `monitor check ${snapshot.check_id} does not exist`);
    assert.equal(check.state, "running", `monitor check ${snapshot.check_id} is not running`);
    return row;
  }

  latestObservationRow(monitorId) {
    return this.database
      .prepare("SELECT * FROM observations WHERE monitor_id = ? ORDER BY sequence DESC LIMIT 1")
      .get(monitorId);
  }

  hydrateMonitor(row) {
    const versionRow = this.database
      .prepare("SELECT * FROM monitor_versions WHERE id = ?")
      .get(row.active_version_id);
    const observationRow = this.latestObservationRow(row.id);
    const checkRow = this.database
      .prepare("SELECT * FROM monitor_checks WHERE monitor_id = ? ORDER BY started_at DESC, id DESC LIMIT 1")
      .get(row.id);
    const triggerRow = this.database
      .prepare("SELECT * FROM monitor_triggers WHERE monitor_id = ? ORDER BY created_at DESC, id DESC LIMIT 1")
      .get(row.id);
    const manifest = decodeJson(versionRow?.manifest_json) ?? {};
    return {
      monitor_id: row.id,
      session_id: row.session_id,
      wait_id: row.wait_id,
      state: row.paused ? "paused" : row.state,
      lifecycle: row.lifecycle,
      fire_on_initial_match: Boolean(row.fire_on_initial_match),
      active_version_id: row.active_version_id,
      artifact_hash: versionRow?.artifact_hash ?? null,
      observer: manifest.observer ?? (decodeJson(row.detector_json).kind === "deadline_reached" ? { provider: "clock" } : null),
      artifact: manifest.artifact,
      detector: decodeJson(row.detector_json),
      schedule: decodeJson(row.schedule_json),
      retry: decodeJson(row.retry_json),
      capabilities: decodeJson(row.capabilities_json),
      next_check_at: row.next_check_at,
      consecutive_failures: row.consecutive_failures,
      terminal_reason: row.terminal_reason_code == null ? null : {
        code: row.terminal_reason_code,
        detail: row.terminal_reason_detail ?? "",
        actor: row.terminal_actor,
        at: row.terminal_at,
      },
      version: row.version,
      lease_owner: row.lease_owner,
      lease_expires_at: row.lease_expires_at,
      last_check: checkRow ? hydrateMonitorCheck(checkRow) : null,
      last_observation: observationRow ? hydrateObservation(observationRow) : null,
      last_trigger: triggerRow ? hydrateMonitorTrigger(triggerRow) : null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  insertBoundMonitorEvent({ monitorRow, checkId, proposal, claimWait, timestamp }) {
    assert.equal(typeof proposal.type, "string", "monitor Event type is required");
    assert.equal(typeof proposal.key, "string", "monitor trigger key is required");
    const existing = this.database
      .prepare("SELECT event_id FROM monitor_triggers WHERE monitor_id = ? AND trigger_key = ?")
      .get(monitorRow.id, proposal.key);
    if (existing) {
      return existing.event_id;
    }

    const correlationKey = typeof proposal.correlation_key === "string" && proposal.correlation_key.length > 0
      ? proposal.correlation_key : null;
    if (correlationKey != null) {
      assert.ok(correlationKey.length <= 1024, "Monitor correlation key is too long");
      const correlated = this.database.prepare("SELECT id FROM events WHERE correlation_key = ?").get(correlationKey);
      if (correlated) {
        this.database.prepare(`
          INSERT INTO monitor_triggers (id, monitor_id, check_id, trigger_key, event_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(this.idFactory(), monitorRow.id, checkId, proposal.key, correlated.id, timestamp);
        return correlated.id;
      }
    }

    const waitRow = this.database.prepare("SELECT * FROM waits WHERE id = ?").get(monitorRow.wait_id);
    assert.ok(waitRow, `monitor wait ${monitorRow.wait_id} does not exist`);
    assert.equal(waitRow.session_id, monitorRow.session_id, "monitor binding owner changed");
    if (claimWait) {
      assert.equal(waitRow.status, "active", `monitor wait ${waitRow.id} is not active`);
    }

    const eventId = this.idFactory();
    const sourceEventId = `${monitorRow.id}:${proposal.key}`;
    const payload = {
      event_id: eventId,
      source: "relay-monitor",
      source_event_id: sourceEventId,
      fingerprint: hashJson({ monitor_id: monitorRow.id, trigger_key: proposal.key }),
      ...(correlationKey ? { correlation_key: correlationKey } : {}),
      channel: "monitor",
      type: proposal.type,
      monitor_id: monitorRow.id,
      trigger_key: proposal.key,
      data: proposal.data ?? {},
    };
    this.database
      .prepare(`
        INSERT INTO events (
          id, source, source_event_id, fingerprint, correlation_key, payload_json,
          state, version, received_at, updated_at
        ) VALUES (?, 'relay-monitor', ?, ?, ?, ?, 'dispatched', 1, ?, ?)
      `)
      .run(eventId, sourceEventId, payload.fingerprint, correlationKey, encodeJson(payload), timestamp, timestamp);

    const waitIds = claimWait ? [monitorRow.wait_id] : [];
    const relation = claimWait
      ? `bound Monitor ${monitorRow.id} detected ${proposal.type}`
      : `bound Monitor ${monitorRow.id} failed`;
    const decision = {
      disposition: "deliver",
      actionable: true,
      deliveries: [{
        session_id: monitorRow.session_id,
        wait_ids: waitIds,
        relation,
        confidence: 1,
      }],
      evidence: [`validated binding from Monitor ${monitorRow.id}`],
      summary: relation,
    };
    this.database
      .prepare(`
        INSERT INTO routing_decisions (
          id, event_id, disposition, actionable, summary,
          evidence_json, decision_json, created_at
        ) VALUES (?, ?, 'deliver', 1, ?, ?, ?, ?)
      `)
      .run(
        this.idFactory(),
        eventId,
        decision.summary,
        encodeJson(decision.evidence),
        encodeJson(decision),
        timestamp,
      );
    const deliveryId = this.insertDelivery({
      eventId,
      sessionId: monitorRow.session_id,
      relation,
      confidence: 1,
      timestamp,
    });
    if (claimWait) {
      this.database
        .prepare(`
          INSERT INTO delivery_waits (
            delivery_id, wait_id, ordinal, wait_snapshot_json
          ) VALUES (?, ?, 0, ?)
        `)
        .run(deliveryId, monitorRow.wait_id, encodeJson(hydrateWait(waitRow)));
      this.database
        .prepare(`
          UPDATE waits
          SET status = 'claimed', version = version + 1, updated_at = ?
          WHERE id = ?
        `)
        .run(timestamp, monitorRow.wait_id);
    }
    this.database
      .prepare(`
        INSERT INTO monitor_triggers (
          id, monitor_id, check_id, trigger_key, event_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(this.idFactory(), monitorRow.id, checkId, proposal.key, eventId, timestamp);
    this.bumpRoutingEpoch();
    return eventId;
  }

  bumpRoutingEpoch() {
    this.database
      .prepare("UPDATE runtime_counters SET value = value + 1 WHERE name = 'routing_epoch'")
      .run();
  }
}

function hydrateWaitRegistration(row, waits) {
  return {
    session_id: row.id,
    task_summary: row.task_summary,
    context: decodeJson(row.context_json),
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
    waits,
  };
}

function hydrateWait(row) {
  return {
    wait_id: row.id,
    session_id: row.session_id,
    phase: row.phase,
    status: row.status,
    exclusive: Boolean(row.exclusive),
    exclusive_owner_key: row.exclusive_owner_key,
    version: row.version,
    ...decodeJson(row.wait_card_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function hydrateRoutingAttempt(row) {
  return {
    routing_attempt_id: row.id,
    event_id: row.event_id,
    pass: row.pass,
    router: row.router,
    model: row.model,
    output: row.output_json == null ? null : decodeJson(row.output_json),
    usage: row.usage_json == null ? null : decodeJson(row.usage_json),
    error: row.error,
    created_at: row.created_at,
  };
}

function hydrateEvent(row) {
  return {
    event_id: row.id,
    source: row.source,
    source_event_id: row.source_event_id,
      fingerprint: row.fingerprint,
      correlation_key: row.correlation_key,
    payload: decodeJson(row.payload_json),
    state: row.state,
    version: row.version,
    received_at: row.received_at,
    updated_at: row.updated_at,
  };
}

function hydrateDecision(row) {
  return {
    decision_id: row.id,
    event_id: row.event_id,
    disposition: row.disposition,
    actionable: Boolean(row.actionable),
    summary: row.summary,
    evidence: decodeJson(row.evidence_json),
    raw: decodeJson(row.decision_json),
    created_at: row.created_at,
  };
}

function hydrateActivation(row) {
  return {
    activation_id: row.id,
    session_id: row.session_id,
    trigger_type: row.trigger_type,
    state: row.state,
    delivery_ids: decodeJson(row.delivery_ids_json),
    lease_owner: row.lease_owner ?? null,
    lease_expires_at: row.lease_expires_at ?? null,
    accepted_at: row.accepted_at ?? null,
    last_error: row.last_error ?? null,
    attempt_count: row.attempt_count ?? 0,
    next_attempt_at: row.next_attempt_at ?? null,
    terminal_reason_code: row.terminal_reason_code ?? null,
    terminal_at: row.terminal_at ?? null,
    committed_at: row.committed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function hydrateMonitorCheck(row) {
  return {
    check_id: row.id,
    monitor_id: row.monitor_id,
    version_id: row.version_id,
    kind: row.kind,
    state: row.state,
    error_class: row.error_class,
    error: row.error,
    started_at: row.started_at,
    finished_at: row.finished_at,
  };
}

function hydrateMonitorVersion(row) {
  return {
    version_id: row.id,
    monitor_id: row.monitor_id,
    artifact_hash: row.artifact_hash,
    manifest: decodeJson(row.manifest_json),
    created_at: row.created_at,
  };
}

function hydrateObservation(row) {
  return {
    observation_id: row.id,
    check_id: row.check_id,
    monitor_id: row.monitor_id,
    sequence: row.sequence,
    state_hash: row.state_hash,
    data: decodeJson(row.data_json),
    observed_at: row.observed_at,
  };
}

function hydrateMonitorTrigger(row) {
  return {
    trigger_id: row.id,
    monitor_id: row.monitor_id,
    check_id: row.check_id,
    trigger_key: row.trigger_key,
    event_id: row.event_id,
    created_at: row.created_at,
  };
}

function nextMonitorCheckAt(schedule, clockValue) {
  const intervalMs = schedule.interval_seconds * 1000;
  return new Date(clockValue.getTime() + intervalMs).toISOString();
}

function hashJson(value) {
  return createHash("sha256").update(encodeJson(value)).digest("hex");
}

function encodeJson(value) {
  return JSON.stringify(value);
}

function decodeJson(value) {
  return value == null ? null : JSON.parse(value);
}

function encodeHistoryCursor(row) {
  return Buffer.from(JSON.stringify({ received_at: row.received_at, id: row.id }), "utf8").toString("base64url");
}

function decodeHistoryCursor(value) {
  assert.ok(typeof value === "string" && value.length > 0 && value.length <= 2048, "Event history cursor is invalid");
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    assert.fail("Event history cursor is invalid");
  }
  assert.ok(parsed && typeof parsed === "object" && Object.keys(parsed).length === 2,
    "Event history cursor is invalid");
  assert.ok(typeof parsed.id === "string" && parsed.id.length > 0 && parsed.id.length <= 512,
    "Event history cursor is invalid");
  assert.ok(typeof parsed.received_at === "string" && parsed.received_at.length <= 64
    && !Number.isNaN(Date.parse(parsed.received_at)), "Event history cursor is invalid");
  return parsed;
}

function toIso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
