CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pw TEXT NOT NULL, -- pbkdf2 "salt:hash", see src/users.ts
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
-- a user's landmark (נקודת ציון): home, work... label is user-editable
CREATE TABLE favorites (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL
);
CREATE INDEX favorites_user ON favorites(user_id);
-- the lots the user likes for that place
CREATE TABLE favorite_lots (
  favorite_id INTEGER NOT NULL REFERENCES favorites(id) ON DELETE CASCADE,
  lot_id TEXT NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY (favorite_id, lot_id)
);
