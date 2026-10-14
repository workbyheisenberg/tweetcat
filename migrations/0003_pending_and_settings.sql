-- Pending miners + live settings.
-- A miner stays PENDING (not mining) until its tweet card is opened and someone
-- taps START MINING inside that tweet. started_at marks the moment mining began.

ALTER TABLE miners ADD COLUMN started_at INTEGER;
ALTER TABLE miners ADD COLUMN tweet_url TEXT;
ALTER TABLE miners ADD COLUMN tweet_id TEXT;

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
