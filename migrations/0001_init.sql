-- TweetCat Miner schema
CREATE TABLE IF NOT EXISTS users (
  wallet        TEXT PRIMARY KEY,
  tweets        INTEGER NOT NULL DEFAULT 0,
  balance       REAL    NOT NULL DEFAULT 0,
  mining        INTEGER NOT NULL DEFAULT 0,
  last_mined_at INTEGER NOT NULL,
  last_tweet_at INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_balance ON users (balance DESC);
