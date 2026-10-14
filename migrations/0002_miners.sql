-- Per-tweet miners.
-- Each miner = one tweet = one self-contained "container" that mines 0.02 $TWEETCAT/sec
-- for the wallet that created it. More miners (more tweets) = more total earnings.

DROP TABLE IF EXISTS users;

CREATE TABLE IF NOT EXISTS wallets (
  wallet     TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS miners (
  id            TEXT PRIMARY KEY,
  wallet        TEXT    NOT NULL,
  balance       REAL    NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1,
  last_mined_at INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_miners_wallet ON miners (wallet);
CREATE INDEX IF NOT EXISTS idx_miners_created ON miners (created_at DESC);
