-- Nook schema for Tiger Cloud (TimescaleDB + PostGIS)
-- Requires: CREATE EXTENSION timescaledb; CREATE EXTENSION postgis;

CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS postgis;

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  user_id       TEXT PRIMARY KEY,
  handle        TEXT UNIQUE NOT NULL,
  home          GEOGRAPHY(POINT, 4326),
  contact       TEXT,
  night_start   TIME NOT NULL DEFAULT '22:00',
  night_end     TIME NOT NULL DEFAULT '06:00',
  tz            TEXT NOT NULL DEFAULT 'America/New_York',
  display_name  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS users_handle_idx ON users (handle);

-- Onboarding / settings (Person A). `contact` = trusted contact phone.
ALTER TABLE users ADD COLUMN IF NOT EXISTS trusted_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS monitoring_mode TEXT;            -- MANUAL | EVENINGS | AWAY_FROM_HOME
ALTER TABLE users ADD COLUMN IF NOT EXISTS escalation_on_no_response TEXT;  -- CONTACT_TRUSTED | NONE
-- Calls are no longer an escalation step.
UPDATE users SET escalation_on_no_response = 'CONTACT_TRUSTED' WHERE escalation_on_no_response = 'CALL_THEN_CONTACT';
UPDATE users SET escalation_on_no_response = 'NONE' WHERE escalation_on_no_response = 'CALL_USER';
ALTER TABLE users ADD COLUMN IF NOT EXISTS nudge_after_sec INTEGER;
ALTER TABLE users ADD COLUMN IF NOT EXISTS escalate_after_sec INTEGER;
ALTER TABLE users ADD COLUMN IF NOT EXISTS no_update_min INTEGER;
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarded_at TIMESTAMPTZ;
ALTER TABLE users DROP COLUMN IF EXISTS codeword;
ALTER TABLE users DROP COLUMN IF EXISTS emergency_action;

-- ---------------------------------------------------------------------------
-- location_pings (hypertable)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS location_pings (
  time          TIMESTAMPTZ NOT NULL,
  user_id       TEXT NOT NULL REFERENCES users(user_id),
  lat           DOUBLE PRECISION NOT NULL,
  lon           DOUBLE PRECISION NOT NULL,
  accuracy_m    DOUBLE PRECISION,
  geom          GEOGRAPHY(POINT, 4326) NOT NULL,
  cell          TEXT NOT NULL,
  walk_id       TEXT,
  short_address TEXT
);

SELECT create_hypertable('location_pings', 'time', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS location_pings_user_time_idx
  ON location_pings (user_id, time DESC);
CREATE INDEX IF NOT EXISTS location_pings_cell_idx
  ON location_pings (user_id, cell, time DESC);

-- ---------------------------------------------------------------------------
-- walks
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS walks (
  walk_id       TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(user_id),
  trigger       TEXT NOT NULL, -- 'prompt' | 'walk_me_home' | ...
  started_at    TIMESTAMPTZ NOT NULL,
  ended_at      TIMESTAMPTZ,
  origin_cell   TEXT,
  origin_lat    DOUBLE PRECISION,
  origin_lon    DOUBLE PRECISION,
  duration_s    INTEGER,
  status        TEXT NOT NULL DEFAULT 'WALKING',
  -- expected/late minutes snapshot when walk started
  expected_min  DOUBLE PRECISION,
  late_min      DOUBLE PRECISION
);

CREATE INDEX IF NOT EXISTS walks_user_started_idx ON walks (user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS walks_open_idx ON walks (user_id) WHERE ended_at IS NULL;

-- Safety state and the active destination (home, a shared Apple Maps place, or a safer stop).
ALTER TABLE walks ADD COLUMN IF NOT EXISTS safety_state TEXT;   -- safe | uneasy | immediate_danger
ALTER TABLE walks ADD COLUMN IF NOT EXISTS route_choice TEXT;   -- destination | busier
ALTER TABLE walks ADD COLUMN IF NOT EXISTS dest_name TEXT;
ALTER TABLE walks ADD COLUMN IF NOT EXISTS dest_lat DOUBLE PRECISION;
ALTER TABLE walks ADD COLUMN IF NOT EXISTS dest_lon DOUBLE PRECISION;
ALTER TABLE walks ADD COLUMN IF NOT EXISTS dest_address TEXT;
ALTER TABLE walks ADD COLUMN IF NOT EXISTS interim_name TEXT;
ALTER TABLE walks ADD COLUMN IF NOT EXISTS interim_lat DOUBLE PRECISION;
ALTER TABLE walks ADD COLUMN IF NOT EXISTS interim_lon DOUBLE PRECISION;

-- ---------------------------------------------------------------------------
-- voice_notes: iMessage voice notes (audio kept on disk under data/voice-notes)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS voice_notes (
  id            TEXT PRIMARY KEY,           -- iMessage message id
  user_id       TEXT NOT NULL REFERENCES users(user_id),
  walk_id       TEXT,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  path          TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  transcript    TEXT,
  status        TEXT NOT NULL,              -- transcribed | failed
  forwarded_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS voice_notes_user_idx ON voice_notes (user_id, received_at DESC);

-- ---------------------------------------------------------------------------
-- stops
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stops (
  id            BIGSERIAL PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(user_id),
  walk_id       TEXT REFERENCES walks(walk_id),
  started_at    TIMESTAMPTZ NOT NULL,
  ended_at      TIMESTAMPTZ,
  geom          GEOGRAPHY(POINT, 4326) NOT NULL,
  cell          TEXT NOT NULL,
  duration_s    INTEGER,
  outcome       TEXT
);

CREATE INDEX IF NOT EXISTS stops_user_cell_idx ON stops (user_id, cell);

-- ---------------------------------------------------------------------------
-- place_labels
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS place_labels (
  user_id       TEXT NOT NULL REFERENCES users(user_id),
  cell          TEXT NOT NULL,
  geom          GEOGRAPHY(POINT, 4326),
  label         TEXT,
  kind          TEXT, -- e.g. 'friend', 'bodega'
  ok_dwell_min  INTEGER,
  source        TEXT, -- 'seed' | 'user' | 'gemini'
  PRIMARY KEY (user_id, cell)
);

-- ---------------------------------------------------------------------------
-- confirmed_cells: off-route stretches the user said were intentional (R6)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS confirmed_cells (
  user_id       TEXT NOT NULL REFERENCES users(user_id),
  cell          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, cell)
);

-- ---------------------------------------------------------------------------
-- events (hypertable)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
  time          TIMESTAMPTZ NOT NULL,
  user_id       TEXT NOT NULL,
  walk_id       TEXT,
  type          TEXT NOT NULL, -- 'rule_fired' | ...
  rule_id       TEXT,
  detail        JSONB NOT NULL DEFAULT '{}'::jsonb
);

SELECT create_hypertable('events', 'time', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS events_user_time_idx ON events (user_id, time DESC);
CREATE INDEX IF NOT EXISTS events_rule_idx ON events (rule_id, time DESC);

-- ---------------------------------------------------------------------------
-- Continuous aggregate: presence_hourly
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM timescaledb_information.continuous_aggregates
    WHERE view_name = 'presence_hourly'
  ) THEN
    EXECUTE $cagg$
      CREATE MATERIALIZED VIEW presence_hourly
      WITH (timescaledb.continuous) AS
      SELECT
        time_bucket('1 hour', time) AS bucket,
        user_id,
        cell,
        count(*)::bigint AS ping_count
      FROM location_pings
      GROUP BY 1, 2, 3
      WITH NO DATA
    $cagg$;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Views: walk_baselines, known_stops
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW walk_baselines AS
SELECT
  user_id,
  origin_cell,
  count(*)::int AS n,
  (percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_s) / 60.0) AS p50_min,
  (percentile_cont(0.9) WITHIN GROUP (ORDER BY duration_s) / 60.0) AS p90_min
FROM walks
WHERE ended_at IS NOT NULL AND duration_s IS NOT NULL AND origin_cell IS NOT NULL
GROUP BY user_id, origin_cell;

CREATE OR REPLACE VIEW known_stops AS
SELECT
  s.user_id,
  s.cell,
  count(*)::int AS visits,
  (percentile_cont(0.9) WITHIN GROUP (ORDER BY s.duration_s) FILTER (WHERE s.duration_s IS NOT NULL) / 60.0) AS p90_dwell_min,
  pl.label,
  pl.kind,
  pl.ok_dwell_min,
  pl.geom
FROM stops s
LEFT JOIN place_labels pl ON pl.user_id = s.user_id AND pl.cell = s.cell
WHERE s.ended_at IS NOT NULL
GROUP BY s.user_id, s.cell, pl.label, pl.kind, pl.ok_dwell_min, pl.geom
HAVING count(*) >= 2;
