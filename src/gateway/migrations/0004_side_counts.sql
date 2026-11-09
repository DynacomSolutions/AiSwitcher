-- Side and served requests per app and day (lists, search, speech, pool-served routes), shared by every replica.
CREATE TABLE IF NOT EXISTS gateway_side_counts (
  app text NOT NULL,
  day date NOT NULL,
  n bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (app, day)
);
