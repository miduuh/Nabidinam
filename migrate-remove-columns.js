const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'data.sqlite');
const db = new Database(dbPath);

console.log('Running migration to remove users.age_group and questions.category');

const sql = `
BEGIN TRANSACTION;

-- Create new users table without age_group
CREATE TABLE IF NOT EXISTS users_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT UNIQUE NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
INSERT INTO users_new (id, name, phone, created_at)
  SELECT id, name, phone, created_at FROM users;

-- Create new questions table without category
CREATE TABLE IF NOT EXISTS questions_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_text TEXT NOT NULL,
  option_a TEXT NOT NULL,
  option_b TEXT NOT NULL,
  option_c TEXT NOT NULL,
  option_d TEXT NOT NULL,
  correct_option TEXT NOT NULL,
  duration_seconds INTEGER DEFAULT 20,
  status TEXT DEFAULT 'draft',
  started_at INTEGER,
  sort_order INTEGER DEFAULT 0
);
INSERT INTO questions_new (id, question_text, option_a, option_b, option_c, option_d, correct_option, duration_seconds, status, started_at, sort_order)
  SELECT id, question_text, option_a, option_b, option_c, option_d, correct_option, duration_seconds, status, started_at, sort_order FROM questions;

DROP TABLE users;
ALTER TABLE users_new RENAME TO users;

DROP TABLE questions;
ALTER TABLE questions_new RENAME TO questions;

COMMIT;
`;

try {
  db.exec(sql);
  console.log('Migration completed successfully.');
} catch (e) {
  console.error('Migration failed:', e);
  console.error('No changes were applied.');
  process.exit(1);
}

process.exit(0);
