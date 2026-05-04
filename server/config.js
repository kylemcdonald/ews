const fs = require("node:fs");
const path = require("node:path");

const ROOT_DIR = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT_DIR, "data");
const CONFIG_DIR = path.join(ROOT_DIR, "config");
const DB_PATH = process.env.EWS_DB_PATH
  ? path.resolve(process.env.EWS_DB_PATH)
  : path.join(DATA_DIR, "ews.sqlite");
const SCHEMA_PATH = path.join(ROOT_DIR, "schema.sql");
const WATCHLIST_PATH = path.join(CONFIG_DIR, "watchlist.json");
const WATCHLIST_EXAMPLE_PATH = path.join(CONFIG_DIR, "watchlist.example.json");
const CLIENT_DIST_DIR = path.join(ROOT_DIR, "client", "dist");

function ensureDirectories() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

function normalizeHex(value) {
  if (!value) {
    return null;
  }

  const cleaned = String(value).trim().toLowerCase().replace(/^~/, "").replace(/^0x/, "");
  if (!/^[0-9a-f]{6}$/.test(cleaned)) {
    return null;
  }

  return cleaned;
}

function normalizeWatchlistEntry(entry, index) {
  const hex = normalizeHex(entry?.hex);
  if (!hex) {
    return {
      error: `Entry ${index + 1} is missing a valid 6-character hex code.`,
    };
  }

  return {
    hex,
    registration: entry?.registration ? String(entry.registration).trim().toUpperCase() : null,
    label: entry?.label ? String(entry.label).trim() : null,
    notes: entry?.notes ? String(entry.notes).trim() : null,
    source: "local_watchlist",
  };
}

function readWatchlist() {
  ensureDirectories();

  if (!fs.existsSync(WATCHLIST_PATH)) {
    return {
      configured: false,
      reason: `No watchlist found at ${WATCHLIST_PATH}. Copy ${WATCHLIST_EXAMPLE_PATH} to create one.`,
      entries: [],
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(WATCHLIST_PATH, "utf8"));
  } catch (error) {
    return {
      configured: false,
      reason: `Could not parse ${WATCHLIST_PATH}: ${error.message}`,
      entries: [],
    };
  }

  if (!Array.isArray(parsed)) {
    return {
      configured: false,
      reason: "Watchlist JSON must be an array of aircraft entries.",
      entries: [],
    };
  }

  const errors = [];
  const entries = parsed
    .map((entry, index) => normalizeWatchlistEntry(entry, index))
    .filter((entry) => {
      if (entry.error) {
        errors.push(entry.error);
        return false;
      }

      return true;
    });

  return {
    configured: entries.length > 0 && errors.length === 0,
    reason: errors.join(" "),
    entries,
  };
}

module.exports = {
  ROOT_DIR,
  DATA_DIR,
  CONFIG_DIR,
  DB_PATH,
  SCHEMA_PATH,
  WATCHLIST_PATH,
  WATCHLIST_EXAMPLE_PATH,
  CLIENT_DIST_DIR,
  ensureDirectories,
  normalizeHex,
  readWatchlist,
};
