#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { loadEnvFile } = require("../server/env");
const { DATA_DIR, ensureDirectories } = require("../server/config");
const { initDb } = require("../server/db");
const { buildDashboardSnapshot, buildStoredHeatmapStatus } = require("../server/dashboard");
const { buildEmergencyRssFeedXml, getRssItems, maybeRecordEmergencyLevelRssItem } = require("../server/rss-feed");

function parseArgs(argv) {
  const args = {
    dryRun: false,
    output: path.join(DATA_DIR, "published", "rss.xml"),
  };

  for (let index = 2; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--dry-run") {
      args.dryRun = true;
    } else if (value === "--output") {
      args.output = path.resolve(argv[index + 1]);
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
  console.log("Usage: node scripts/update_rss_feed.js [--output path] [--dry-run]");
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  loadEnvFile();
  ensureDirectories();
  initDb();

  const liveStatus = buildStoredHeatmapStatus();
  const snapshot = buildDashboardSnapshot({
    liveStatus,
  });
  const result = maybeRecordEmergencyLevelRssItem({
    snapshot,
    status: liveStatus,
    dryRun: args.dryRun,
  });
  const items = getRssItems();
  const rssXml = buildEmergencyRssFeedXml({
    items: result.updated && result.item && args.dryRun ? [result.item, ...items] : items,
  });

  if (args.output) {
    fs.mkdirSync(path.dirname(args.output), { recursive: true });
    fs.writeFileSync(args.output, rssXml);
  }

  console.log(
    JSON.stringify({
      ...result,
      output: args.output,
      itemCount: items.length + (result.updated && args.dryRun ? 1 : 0),
      emergencyLevel: snapshot.signals?.composite?.emergencyLevel ?? snapshot.current?.emergencyLevel ?? null,
      asOf: snapshot.current?.asOf ?? null,
    }),
  );
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
