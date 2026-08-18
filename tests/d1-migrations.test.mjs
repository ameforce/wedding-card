import assert from "node:assert/strict";
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
    fileCount: 4,
    statementCount: 10,
  });
});

test("the guard accepts the narrow additive migration forms", () => {
  const sql = `
    -- semicolons inside values are not statement boundaries
    CREATE TABLE IF NOT EXISTS example (id TEXT PRIMARY KEY, value TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS example_value_idx ON example (value);
    INSERT OR IGNORE INTO example (id, value) VALUES ('one', 'safe; value');
    ALTER TABLE example ADD COLUMN created_at TEXT;
  `;
  assert.equal(assertAdditiveMigration(sql), 4);
  assert.equal(splitSqlStatements(sql).length, 4);
});

for (const destructive of [
  "DROP TABLE guestbook_entries;",
  "DELETE FROM guestbook_entries;",
  "UPDATE invitation_state SET published_revision_id = NULL;",
  "ALTER TABLE invitation_state DROP COLUMN draft_revision_id;",
  "CREATE TABLE invitation_state (id INTEGER);",
  "INSERT OR REPLACE INTO invitation_state VALUES (1);",
]) {
  test(`the guard rejects destructive or non-idempotent SQL: ${destructive.split(" ")[0]}`, () => {
    assert.throws(() => assertAdditiveMigration(destructive), /비증분 SQL/);
  });
}

test("the guard ignores comment text but fails on unterminated SQL", () => {
  assert.equal(assertAdditiveMigration("/* DROP TABLE ignored; */ CREATE TABLE IF NOT EXISTS safe (id TEXT);"), 1);
  assert.throws(() => assertAdditiveMigration("CREATE TABLE IF NOT EXISTS safe (value TEXT DEFAULT 'oops);"), /종료되지 않은/);
});
