-- Starred models of the gateway owner. One row per model (provider, identity, model) holds the newest change: last writer wins by `at_ms`.
-- A removed model stays as a row with present = false, so an older add that arrives late cannot bring it back. `seq` grows when `present` flips.
CREATE SEQUENCE IF NOT EXISTS gateway_favourites_seq;
CREATE TABLE IF NOT EXISTS gateway_favourites (
  id       text PRIMARY KEY,
  provider text NOT NULL,
  identity text NOT NULL,
  model    text NOT NULL,
  present  boolean NOT NULL,
  at_ms    bigint NOT NULL,
  seq      bigint NOT NULL,
  origin   text NOT NULL
);
CREATE INDEX IF NOT EXISTS gateway_favourites_present ON gateway_favourites (present, at_ms);
