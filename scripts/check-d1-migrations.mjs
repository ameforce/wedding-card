import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MIGRATION_NAME = /^\d{4}_[a-z0-9_]+\.sql$/;

export function splitSqlStatements(sql) {
  const statements = [];
  let statement = "";
  let state = "normal";

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    const next = sql[index + 1];

    if (state === "line-comment") {
      if (character === "\n") {
        state = "normal";
        statement += "\n";
      }
      continue;
    }
    if (state === "block-comment") {
      if (character === "*" && next === "/") {
        state = "normal";
        index += 1;
      }
      continue;
    }
    if (state === "single-quote") {
      statement += character;
      if (character === "'" && next === "'") {
        statement += next;
        index += 1;
      } else if (character === "'") {
        state = "normal";
      }
      continue;
    }
    if (state === "double-quote") {
      statement += character;
      if (character === '"' && next === '"') {
        statement += next;
        index += 1;
      } else if (character === '"') {
        state = "normal";
      }
      continue;
    }

    if (character === "-" && next === "-") {
      state = "line-comment";
      index += 1;
    } else if (character === "/" && next === "*") {
      state = "block-comment";
      index += 1;
    } else if (character === "'") {
      state = "single-quote";
      statement += character;
    } else if (character === '"') {
      state = "double-quote";
      statement += character;
    } else if (character === ";") {
      if (statement.trim()) statements.push(statement.trim());
      statement = "";
    } else {
      statement += character;
    }
  }

  if (state === "block-comment" || state === "single-quote" || state === "double-quote") {
    throw new Error(`종료되지 않은 SQL ${state}가 있습니다.`);
  }
  if (statement.trim()) statements.push(statement.trim());
  return statements;
}

function isAdditiveStatement(statement) {
  const normalized = statement.replace(/\s+/g, " ").trim();
  const additiveSchemaPatterns = [
    /^CREATE TABLE IF NOT EXISTS\b/i,
    /^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS\b/i,
    /^ALTER TABLE\s+(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[a-z0-9_]+)\s+ADD COLUMN\b/i,
  ];
  if (additiveSchemaPatterns.some((pattern) => pattern.test(normalized))) return true;

  return /^INSERT OR IGNORE INTO invitation_state\s*\(\s*singleton_id\s*,\s*draft_revision_id\s*,\s*published_revision_id\s*,\s*updated_at\s*\)\s*VALUES\s*\(\s*1\s*,\s*NULL\s*,\s*NULL\s*,\s*'1970-01-01T00:00:00\.000Z'\s*\)$/i.test(normalized);
}

export function assertAdditiveMigration(sql, filename = "migration.sql") {
  const statements = splitSqlStatements(sql);
  if (statements.length === 0) throw new Error(`${filename}: 실행할 SQL 문이 없습니다.`);

  statements.forEach((statement, index) => {
    if (!isAdditiveStatement(statement)) {
      const preview = statement.replace(/\s+/g, " ").slice(0, 100);
      throw new Error(`${filename}:${index + 1}: 허용되지 않은 비증분 SQL입니다: ${preview}`);
    }
  });
  return statements.length;
}

export async function checkMigrationDirectory(directory) {
  const filenames = (await readdir(directory))
    .filter((filename) => filename.endsWith(".sql"))
    .sort();
  if (filenames.length === 0) throw new Error("D1 migration 파일을 찾지 못했습니다.");

  let statementCount = 0;
  for (const filename of filenames) {
    if (!MIGRATION_NAME.test(filename)) {
      throw new Error(`${filename}: migration 파일명은 4자리 순번과 snake_case를 사용해야 합니다.`);
    }
    statementCount += assertAdditiveMigration(await readFile(resolve(directory, filename), "utf8"), filename);
  }
  return { fileCount: filenames.length, statementCount };
}

const isCli = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isCli) {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  checkMigrationDirectory(resolve(root, "migrations"))
    .then(({ fileCount, statementCount }) => {
      console.log(`[d1-migrations] 통과: ${fileCount}개 파일, ${statementCount}개 증분 SQL 문`);
    })
    .catch((error) => {
      console.error(`[d1-migrations] 실패: ${error.message}`);
      process.exitCode = 1;
    });
}
