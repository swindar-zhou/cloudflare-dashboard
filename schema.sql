DROP TABLE IF EXISTS feedback;
DROP TABLE IF EXISTS daily_digest;

CREATE TABLE feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  type TEXT,
  theme TEXT,
  sentiment TEXT,
  urgency INTEGER DEFAULT 0
);

CREATE TABLE daily_digest (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL UNIQUE,
  top_themes TEXT NOT NULL,
  urgent_items TEXT NOT NULL,
  total_feedback INTEGER NOT NULL,
  created_at TEXT NOT NULL
);