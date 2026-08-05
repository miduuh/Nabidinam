const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'data.sqlite'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT UNIQUE NOT NULL,
  age_group TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  question_id INTEGER NOT NULL,
  selected_option TEXT,
  is_correct INTEGER DEFAULT 0,
  forfeited INTEGER DEFAULT 0,
  answered_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, question_id)
);

CREATE TABLE IF NOT EXISTS cheat_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  question_id INTEGER,
  event TEXT,
  logged_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS swalath (
  user_id INTEGER PRIMARY KEY,
  total_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS swalath_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  logged_at TEXT DEFAULT (datetime('now'))
);
`);

module.exports = db;
