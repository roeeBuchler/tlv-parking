-- crowd reports. kind: full / space = occupancy right now (counts for 30 min); price = what the driver paid
CREATE TABLE reports (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lot_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('full', 'space', 'price')),
  price REAL,        -- price: ₪ paid
  quoted REAL,       -- price: what our engine said for that stay (closest of gate/app price), so mismatches are one query
  entered_at TEXT,   -- price: Jerusalem local "YYYY-MM-DDTHH:MM"
  minutes INTEGER,
  resident INTEGER,
  created_at INTEGER NOT NULL -- ms epoch
);
CREATE INDEX reports_lot ON reports(lot_id, created_at);
CREATE INDEX reports_user ON reports(user_id, created_at);
