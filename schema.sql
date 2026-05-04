CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tracked_aircraft (
  hex TEXT PRIMARY KEY,
  registration TEXT,
  label TEXT,
  source TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS aircraft_metadata (
  hex TEXT PRIMARY KEY,
  registration TEXT,
  icao_type TEXT,
  manufacturer TEXT,
  model TEXT,
  owner_operator TEXT,
  short_type TEXT,
  year TEXT,
  military INTEGER NOT NULL DEFAULT 0,
  faa_pia INTEGER NOT NULL DEFAULT 0,
  faa_ladd INTEGER NOT NULL DEFAULT 0,
  category TEXT NOT NULL,
  category_reason TEXT,
  sources_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_aircraft_metadata_category
  ON aircraft_metadata (category);

CREATE INDEX IF NOT EXISTS idx_aircraft_metadata_icao_type
  ON aircraft_metadata (icao_type);

CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  observed_at TEXT NOT NULL,
  hex TEXT NOT NULL,
  registration TEXT,
  source TEXT NOT NULL,
  lat REAL,
  lon REAL,
  altitude_ft REAL,
  ground_speed_kt REAL,
  is_airborne INTEGER NOT NULL DEFAULT 1,
  UNIQUE(hex, observed_at, source) ON CONFLICT IGNORE
);

CREATE INDEX IF NOT EXISTS idx_observations_observed_at
  ON observations (observed_at);

CREATE INDEX IF NOT EXISTS idx_observations_hex_time
  ON observations (hex, observed_at);

CREATE TABLE IF NOT EXISTS recent_history_activity (
  hex TEXT PRIMARY KEY,
  registration TEXT,
  last_observed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_recent_history_activity_last_observed_at
  ON recent_history_activity (last_observed_at);

CREATE TABLE IF NOT EXISTS rolling_metrics (
  sampled_at TEXT PRIMARY KEY,
  rolling_24h_count INTEGER NOT NULL,
  concurrent_count INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS daily_metrics (
  day TEXT PRIMARY KEY,
  unique_airborne_count INTEGER NOT NULL,
  peak_concurrent_count INTEGER NOT NULL,
  peak_rolling_24h_count INTEGER NOT NULL,
  sample_count INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS non_icao_activity (
  sampled_at TEXT NOT NULL,
  hex TEXT NOT NULL,
  message_type TEXT NOT NULL,
  observation_count INTEGER NOT NULL,
  airborne_observation_count INTEGER NOT NULL,
  first_lat REAL,
  first_lon REAL,
  last_lat REAL,
  last_lon REAL,
  min_altitude_ft REAL,
  max_altitude_ft REAL,
  max_ground_speed_kt REAL,
  flight TEXT,
  squawk TEXT,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (sampled_at, hex, message_type, source)
);

CREATE INDEX IF NOT EXISTS idx_non_icao_activity_hex_time
  ON non_icao_activity (hex, sampled_at);

CREATE TABLE IF NOT EXISTS non_icao_metrics (
  sampled_at TEXT PRIMARY KEY,
  unique_hex_count INTEGER NOT NULL,
  airborne_unique_hex_count INTEGER NOT NULL,
  observation_count INTEGER NOT NULL,
  airborne_observation_count INTEGER NOT NULL,
  message_type_counts_json TEXT NOT NULL,
  top_prefix_counts_json TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS live_snapshot (
  hex TEXT PRIMARY KEY,
  registration TEXT,
  label TEXT,
  observed_at TEXT NOT NULL,
  lat REAL,
  lon REAL,
  altitude_ft REAL,
  ground_speed_kt REAL,
  track REAL,
  is_airborne INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ingestion_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_type TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  details TEXT
);
