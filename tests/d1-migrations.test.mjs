import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertAdditiveMigration,
  checkMigrationDirectory,
  splitSqlStatements,
} from "../scripts/check-d1-migrations.mjs";

test("all checked-in D1 migrations are additive", async () => {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  assert.deepEqual(await checkMigrationDirectory(resolve(root, "migrations")), {
    fileCount: 7,
    statementCount: 16,
  });
});

test("the admin guestbook keyset order has a matching composite D1 index", async () => {
  const migration = await readFile(new URL("../migrations/0006_guestbook_admin_keyset.sql", import.meta.url), "utf8");
  assert.match(migration, /ON guestbook_entries \(created_at DESC, id DESC\)/);
});

test("the guard accepts the narrow additive migration forms", () => {
  const sql = `
    -- semicolons inside values are not statement boundaries
    CREATE TABLE IF NOT EXISTS example (id TEXT PRIMARY KEY, value TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS example_value_idx ON example (value);
    ALTER TABLE example ADD COLUMN created_at TEXT;
  `;
  assert.equal(assertAdditiveMigration(sql), 3);
  assert.equal(splitSqlStatements(sql).length, 3);
});

test("the guard accepts only the exact invitation-state bootstrap insert", () => {
  const bootstrap = `
    INSERT OR IGNORE INTO invitation_state (
      singleton_id,
      draft_revision_id,
      published_revision_id,
      updated_at
    ) VALUES (1, NULL, NULL, '1970-01-01T00:00:00.000Z');
  `;
  assert.equal(assertAdditiveMigration(bootstrap), 1);
});

for (const destructive of [
  "DROP TABLE guestbook_entries;",
  "DELETE FROM guestbook_entries;",
  "UPDATE invitation_state SET published_revision_id = NULL;",
  "ALTER TABLE invitation_state DROP COLUMN draft_revision_id;",
  "CREATE TABLE invitation_state (id INTEGER);",
  "INSERT OR REPLACE INTO invitation_state VALUES (1);",
  "INSERT OR IGNORE INTO example (id, value) VALUES ('one', 'safe') RETURNING id;",
  "INSERT OR IGNORE INTO example (id, value) SELECT id, value FROM source;",
  "INSERT OR IGNORE INTO invitation_state (singleton_id, draft_revision_id, published_revision_id, updated_at) VALUES (1, NULL, NULL, '1970-01-01T00:00:00.000Z') ON CONFLICT(singleton_id) DO UPDATE SET published_revision_id = NULL;",
]) {
  test(`the guard rejects destructive or non-idempotent SQL: ${destructive.split(" ")[0]}`, () => {
    assert.throws(() => assertAdditiveMigration(destructive), /비증분 SQL/);
  });
}

test("the guard ignores comment text but fails on unterminated SQL", () => {
  assert.equal(assertAdditiveMigration("/* DROP TABLE ignored; */ CREATE TABLE IF NOT EXISTS safe (id TEXT);"), 1);
  assert.throws(() => assertAdditiveMigration("CREATE TABLE IF NOT EXISTS safe (value TEXT DEFAULT 'oops);"), /종료되지 않은/);
});
