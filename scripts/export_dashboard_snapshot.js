#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

function parseArgs(argv) {
  const args = {
    output: null,
    db: process.env.EWS_DB_PATH || path.join(__dirname, "..", "data", "ews-main.sqlite"),
    endpoint: "main",
    cohort: "global_business_jet",
  };

  for (let index = 2; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--output") {
      args.output = path.resolve(argv[index + 1]);
      index += 1;
    } else if (value === "--db") {
      args.db = path.resolve(argv[index + 1]);
      index += 1;
    } else if (value === "--endpoint") {
      args.endpoint = argv[index + 1];
      index += 1;
    } else if (value === "--cohort") {
      args.cohort = argv[index + 1];
      index += 1;
    } else if (value === "--help" || value === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(
    "Usage: node scripts/export_dashboard_snapshot.js [--db path] [--output path] [--endpoint name] [--cohort id]",
  );
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  if (args.db) {
    process.env.EWS_DB_PATH = args.db;
  }

  const { ensureDirectories, DATA_DIR, DB_PATH } = require("../server/config");
  const { initDb } = require("../server/db");
  const {
    buildDashboardSnapshot,
    CONCURRENT_WEEKLY_BASELINE_TIME_ZONE,
    CONCURRENT_WEEKLY_US_HOLIDAY_MODEL,
  } = require("../server/dashboard");
  const output =
    args.output ||
    path.join(DATA_DIR, "published", args.endpoint === "main" ? "dashboard.json" : `${args.endpoint}-dashboard.json`);
  const concurrentPredictionOptions = {
    concurrentPredictionModel: CONCURRENT_WEEKLY_US_HOLIDAY_MODEL,
    weeklyBaselineTimeZone: process.env.EWS_MODEL_TIME_ZONE || CONCURRENT_WEEKLY_BASELINE_TIME_ZONE,
  };

  ensureDirectories();
  initDb();

  const snapshot = {
    ...buildDashboardSnapshot({ concurrentPredictionOptions }),
    page: {
      enabled: true,
      endpoint: args.endpoint,
      dbPath: DB_PATH,
      cohort: args.cohort,
      predictionModel: concurrentPredictionOptions.concurrentPredictionModel,
      predictionTimeZone: concurrentPredictionOptions.weeklyBaselineTimeZone,
    },
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(snapshot)}\n`);
  console.log(
    JSON.stringify({
      ok: true,
      output,
      dbPath: DB_PATH,
      snapshotGeneratedAt: snapshot.snapshotGeneratedAt,
      asOf: snapshot.current?.asOf ?? null,
      trackedCount: snapshot.cohort?.trackedCount ?? null,
    }),
  );
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
