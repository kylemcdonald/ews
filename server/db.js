const fs = require("node:fs");
const Database = require("better-sqlite3");
const { DB_PATH, SCHEMA_PATH, ensureDirectories } = require("./config");

let database;
const DAY_MS = 24 * 60 * 60 * 1000;
const AIRCRAFT_PATH_POINT_LIMIT = 6;

function initDb() {
  if (database) {
    return database;
  }

  ensureDirectories();
  database = new Database(DB_PATH);
  database.pragma("journal_mode = WAL");
  database.pragma("synchronous = NORMAL");
  database.pragma("foreign_keys = ON");
  database.exec(fs.readFileSync(SCHEMA_PATH, "utf8"));

  return database;
}

function getDb() {
  return initDb();
}

function getMetaValue(key) {
  const db = getDb();
  const row = db
    .prepare(`
      SELECT value
      FROM meta
      WHERE key = ?
    `)
    .get(key);

  return row?.value ?? null;
}

function setMetaValue(key, value) {
  const db = getDb();
  db.prepare(`
    INSERT INTO meta (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value
  `).run(key, String(value));
}

function upsertTrackedAircraft(entries) {
  if (!entries.length) {
    return;
  }

  const db = getDb();
  const statement = db.prepare(`
    INSERT INTO tracked_aircraft (hex, registration, label, source, notes)
    VALUES (@hex, @registration, @label, @source, @notes)
    ON CONFLICT(hex) DO UPDATE SET
      registration = excluded.registration,
      label = excluded.label,
      source = excluded.source,
      notes = excluded.notes
  `);

  const transaction = db.transaction((aircraftEntries) => {
    for (const entry of aircraftEntries) {
      statement.run(entry);
    }
  });

  transaction(entries);
}

function getTrackedAircraftEntries() {
  const db = getDb();
  return db
    .prepare(`
      SELECT hex, registration, label, source, notes
      FROM tracked_aircraft
      WHERE source != 'demo'
      ORDER BY hex ASC
    `)
    .all();
}

function buildStats(row) {
  const mean = Number(row?.mean_count ?? 0);
  const meanSquare = Number(row?.mean_square_count ?? 0);
  const variance = Math.max(0, meanSquare - mean * mean);

  return {
    sampleCount: Number(row?.sample_count ?? 0),
    mean,
    standardDeviation: Math.sqrt(variance),
  };
}

function buildStatsFromValues(values) {
  const sampleCount = values.length;
  if (!sampleCount) {
    return {
      sampleCount: 0,
      mean: 0,
      standardDeviation: 0,
    };
  }

  const mean = values.reduce((total, value) => total + value, 0) / sampleCount;
  const meanSquare = values.reduce((total, value) => total + value * value, 0) / sampleCount;
  const variance = Math.max(0, meanSquare - mean * mean);

  return {
    sampleCount,
    mean,
    standardDeviation: Math.sqrt(variance),
  };
}

function getBaselineStats() {
  const db = getDb();
  const row = db
    .prepare(`
      SELECT
        COUNT(*) AS sample_count,
        AVG(rolling_24h_count) AS mean_count,
        AVG(rolling_24h_count * rolling_24h_count) AS mean_square_count
      FROM rolling_metrics
    `)
    .get();

  return buildStats(row);
}

function getWeekdayBaselineStats(referenceIso) {
  const db = getDb();
  const row = db
    .prepare(`
      SELECT
        COUNT(*) AS sample_count,
        AVG(rolling_24h_count) AS mean_count,
        AVG(rolling_24h_count * rolling_24h_count) AS mean_square_count
      FROM rolling_metrics
      WHERE strftime('%w', sampled_at) = strftime('%w', ?)
    `)
    .get(referenceIso);

  return buildStats(row);
}

function getRecentWeekdayBaselineStats(referenceIso, weeks = 4, maxDifferenceHours = 12) {
  const referenceDate = new Date(referenceIso);
  const samples = [];

  for (let weekOffset = 1; weekOffset <= weeks; weekOffset += 1) {
    const targetIso = new Date(referenceDate.getTime() - weekOffset * 7 * DAY_MS).toISOString();
    const match = getRollingMetricNear(targetIso, maxDifferenceHours);
    if (!match) {
      continue;
    }

    samples.push({
      targetAt: targetIso,
      sampledAt: match.sampledAt,
      rolling24hCount: match.rolling24hCount,
      differenceSeconds: match.differenceSeconds,
    });
  }

  const sampleCount = samples.length;
  if (!sampleCount) {
    return {
      sampleCount: 0,
      mean: 0,
      standardDeviation: 0,
      samples,
    };
  }

  const mean = samples.reduce((total, sample) => total + sample.rolling24hCount, 0) / sampleCount;
  const meanSquare =
    samples.reduce((total, sample) => total + sample.rolling24hCount * sample.rolling24hCount, 0) / sampleCount;
  const variance = Math.max(0, meanSquare - mean * mean);

  return {
    sampleCount,
    mean,
    standardDeviation: Math.sqrt(variance),
    samples,
  };
}

function getRecentTimeOfDayBaseline(referenceIso, days = 7, maxDifferenceHours = 1) {
  const referenceDate = new Date(referenceIso);
  const samples = [];

  for (let dayOffset = 1; dayOffset <= days; dayOffset += 1) {
    const targetIso = new Date(referenceDate.getTime() - dayOffset * DAY_MS).toISOString();
    const match = getRollingMetricNear(targetIso, maxDifferenceHours);
    if (!match) {
      continue;
    }

    const rolling24hCount = Number(match.rolling24hCount ?? 0);
    const concurrentCount = Number(match.concurrentCount ?? 0);
    const ratio = rolling24hCount > 0 ? concurrentCount / rolling24hCount : 0;

    samples.push({
      targetAt: targetIso,
      sampledAt: match.sampledAt,
      rolling24hCount,
      concurrentCount,
      ratio,
      differenceSeconds: match.differenceSeconds,
    });
  }

  const concurrentStats = buildStatsFromValues(samples.map((sample) => sample.concurrentCount));
  const rollingStats = buildStatsFromValues(samples.map((sample) => sample.rolling24hCount));
  const ratioStats = buildStatsFromValues(samples.map((sample) => sample.ratio));

  return {
    sampleCount: samples.length,
    concurrentMean: concurrentStats.mean,
    concurrentStandardDeviation: concurrentStats.standardDeviation,
    rollingMean: rollingStats.mean,
    rollingStandardDeviation: rollingStats.standardDeviation,
    ratioMean: ratioStats.mean,
    ratioStandardDeviation: ratioStats.standardDeviation,
    samples,
  };
}

function getRollingMetricNear(referenceIso, maxDifferenceHours = 12) {
  const db = getDb();
  const referenceTimeMs = Date.parse(referenceIso);
  if (!Number.isFinite(referenceTimeMs)) {
    return null;
  }

  const beforeRow = db
    .prepare(`
      SELECT
        sampled_at AS sampledAt,
        rolling_24h_count AS rolling24hCount,
        concurrent_count AS concurrentCount
      FROM rolling_metrics
      WHERE sampled_at <= ?
      ORDER BY sampled_at DESC
      LIMIT 1
    `)
    .get(referenceIso);
  const afterRow = db
    .prepare(`
      SELECT
        sampled_at AS sampledAt,
        rolling_24h_count AS rolling24hCount,
        concurrent_count AS concurrentCount
      FROM rolling_metrics
      WHERE sampled_at >= ?
      ORDER BY sampled_at ASC
      LIMIT 1
    `)
    .get(referenceIso);

  const candidates = [beforeRow, afterRow]
    .filter(Boolean)
    .map((row) => ({
      sampledAt: row.sampledAt,
      rolling24hCount: Number(row.rolling24hCount ?? 0),
      concurrentCount: Number(row.concurrentCount ?? 0),
      differenceSeconds: Math.abs(Date.parse(row.sampledAt) - referenceTimeMs) / 1000,
    }))
    .sort((left, right) => left.differenceSeconds - right.differenceSeconds);
  const match = candidates[0];

  if (!match || match.differenceSeconds > maxDifferenceHours * 60 * 60) {
    return null;
  }

  return match;
}

function getCurrentRollingCount(nowIso, { liveSource = null } = {}) {
  const db = getDb();
  const lowerBound = new Date(new Date(nowIso).getTime() - 24 * 60 * 60 * 1000).toISOString();
  const row = db
    .prepare(`
      SELECT COUNT(DISTINCT hex) AS rolling_count
      FROM (
        SELECT hex
        FROM observations
        WHERE observed_at >= ?
          AND observed_at <= ?
          AND is_airborne = 1
          AND (? IS NULL OR source = ?)
        UNION
        SELECT hex
        FROM recent_history_activity
        WHERE last_observed_at >= ?
      )
    `)
    .get(lowerBound, nowIso, liveSource, liveSource, lowerBound);

  return Number(row?.rolling_count ?? 0);
}

function getConcurrentCount(liveSource = null) {
  const db = getDb();
  const row = db
    .prepare(`
      SELECT COUNT(*) AS concurrent_count
      FROM live_snapshot
      WHERE is_airborne = 1
        AND source != 'demo'
        AND (? IS NULL OR source = ?)
    `)
    .get(liveSource, liveSource);

  return Number(row?.concurrent_count ?? 0);
}

function getLiveAircraftPathMap(db, hexes, liveSource = null) {
  if (!hexes.length) {
    return new Map();
  }

  const placeholders = hexes.map(() => "?").join(", ");
  const rows = db
    .prepare(`
      SELECT
        hex,
        observed_at AS observedAt,
        lat,
        lon
      FROM (
        SELECT
          hex,
          observed_at,
          lat,
          lon,
          ROW_NUMBER() OVER (PARTITION BY hex ORDER BY observed_at DESC) AS path_rank
        FROM observations
        WHERE source != 'demo'
          AND (? IS NULL OR source = ?)
          AND hex IN (${placeholders})
          AND is_airborne = 1
          AND lat IS NOT NULL
          AND lon IS NOT NULL
      )
      WHERE path_rank <= ?
      ORDER BY hex ASC, observed_at ASC
    `)
    .all(liveSource, liveSource, ...hexes, AIRCRAFT_PATH_POINT_LIMIT);

  const pathsByHex = new Map();
  for (const row of rows) {
    const path = pathsByHex.get(row.hex) || [];
    path.push({
      observedAt: row.observedAt,
      lat: Number(row.lat),
      lon: Number(row.lon),
    });
    pathsByHex.set(row.hex, path);
  }

  return pathsByHex;
}

function getLiveAircraft(liveSource = null) {
  const db = getDb();
  const rows = db
    .prepare(`
      SELECT
        hex,
        registration,
        COALESCE(label, registration, hex) AS label,
        observed_at,
        lat,
        lon,
        altitude_ft AS altitudeFt,
        ground_speed_kt AS groundSpeedKt,
        track,
        is_airborne AS isAirborne
      FROM live_snapshot
      WHERE is_airborne = 1
        AND source != 'demo'
        AND (? IS NULL OR source = ?)
        AND lat IS NOT NULL
        AND lon IS NOT NULL
      ORDER BY observed_at DESC, label ASC
    `)
    .all(liveSource, liveSource);
  const pathsByHex = getLiveAircraftPathMap(
    db,
    rows.map((row) => row.hex),
    liveSource,
  );

  return rows.map((row) => ({
    ...row,
    track: row.track == null ? null : Number(row.track),
    isAirborne: Boolean(row.isAirborne),
    path: pathsByHex.get(row.hex) || [],
  }));
}

function getRecentDailyMetrics(limit = 365) {
  const db = getDb();
  return db
    .prepare(`
      SELECT
        day,
        unique_airborne_count AS uniqueAirborneCount,
        peak_concurrent_count AS peakConcurrentCount,
        peak_rolling_24h_count AS peakRolling24hCount,
        sample_count AS sampleCount
      FROM daily_metrics
      ORDER BY day DESC
      LIMIT ?
    `)
    .all(limit)
    .reverse();
}

function getAllDailyMetrics() {
  const db = getDb();
  return db
    .prepare(`
      SELECT
        day,
        unique_airborne_count AS uniqueAirborneCount,
        peak_concurrent_count AS peakConcurrentCount,
        peak_rolling_24h_count AS peakRolling24hCount,
        sample_count AS sampleCount
      FROM daily_metrics
      ORDER BY day ASC
    `)
    .all();
}

function getRecentRollingMetrics(limit = 120) {
  const db = getDb();
  return db
    .prepare(`
      SELECT
        sampled_at AS sampledAt,
        rolling_24h_count AS rolling24hCount,
        concurrent_count AS concurrentCount
      FROM rolling_metrics
      ORDER BY sampled_at DESC
      LIMIT ?
    `)
    .all(limit)
    .reverse();
}

function getAllRollingMetrics() {
  const db = getDb();
  return db
    .prepare(`
      SELECT
        sampled_at AS sampledAt,
        rolling_24h_count AS rolling24hCount,
        concurrent_count AS concurrentCount
      FROM rolling_metrics
      ORDER BY sampled_at ASC
    `)
    .all();
}

function getTrackedAircraftCount() {
  const db = getDb();
  const row = db
    .prepare(`
      SELECT COUNT(*) AS tracked_count
      FROM tracked_aircraft
      WHERE source != 'demo'
    `)
    .get();

  return Number(row?.tracked_count ?? 0);
}

function getTrackingSummary() {
  const db = getDb();
  const row = db
    .prepare(`
      SELECT
        COUNT(*) AS tracked_count,
        SUM(CASE WHEN source = 'faa_business_jet' THEN 1 ELSE 0 END) AS faa_count,
        SUM(CASE WHEN source = 'global_business_jet' THEN 1 ELSE 0 END) AS global_count,
        SUM(CASE WHEN source = 'local_watchlist' THEN 1 ELSE 0 END) AS watchlist_count
      FROM tracked_aircraft
      WHERE source != 'demo'
    `)
    .get();

  const trackedCount = Number(row?.tracked_count ?? 0);
  const faaCount = Number(row?.faa_count ?? 0);
  const globalCount = Number(row?.global_count ?? 0);
  const watchlistCount = Number(row?.watchlist_count ?? 0);

  if (!trackedCount) {
    return {
      configured: false,
      trackedCount: 0,
      reason: "No cohort loaded yet. Run `npm run import:faa` to build the private-jet set.",
    };
  }

  return {
    configured: true,
    trackedCount,
    faaCount,
    globalCount,
    watchlistCount,
    reason: null,
    source: globalCount ? "global_business_jet" : faaCount ? "faa_business_jet" : watchlistCount ? "local_watchlist" : "custom",
    sourceLabel: globalCount ? "Global public metadata + FAA" : faaCount ? "FAA registry" : watchlistCount ? "Local watchlist" : "Custom",
  };
}

function areAllTrackedAircraftDemo() {
  const db = getDb();
  const row = db
    .prepare(`
      SELECT
        COUNT(*) AS tracked_count,
        SUM(CASE WHEN source = 'demo' THEN 1 ELSE 0 END) AS demo_count
      FROM tracked_aircraft
    `)
    .get();

  const trackedCount = Number(row?.tracked_count ?? 0);
  const demoCount = Number(row?.demo_count ?? 0);
  return trackedCount > 0 && trackedCount === demoCount;
}

module.exports = {
  getDb,
  initDb,
  getMetaValue,
  setMetaValue,
  upsertTrackedAircraft,
  getTrackedAircraftEntries,
  getBaselineStats,
  getWeekdayBaselineStats,
  getRecentWeekdayBaselineStats,
  getRecentTimeOfDayBaseline,
  getRollingMetricNear,
  getCurrentRollingCount,
  getConcurrentCount,
  getLiveAircraft,
  getAllDailyMetrics,
  getRecentDailyMetrics,
  getAllRollingMetrics,
  getRecentRollingMetrics,
  getTrackedAircraftCount,
  getTrackingSummary,
  areAllTrackedAircraftDemo,
};
