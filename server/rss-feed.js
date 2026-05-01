const { getMetaValue, setMetaValue } = require("./db");
const {
  DEFAULT_ALERT_URL,
  formatEmergencyLevelAlert,
  getEmergencySnapshotSignal,
  getLatestSlotKey,
} = require("./telegram-alert");

const RSS_FEED_ITEMS_META_KEY = "rss_level5_items_v1";
const MAX_RSS_ITEMS = 100;
const DEFAULT_RSS_URL = "https://ews.kylemcdonald.net/rss.xml";
const EMPTY_FEED_DATE = "Thu, 01 Jan 1970 00:00:00 GMT";

function getRssConfig(env = process.env) {
  return {
    siteUrl: String(env.EWS_PUBLIC_URL || DEFAULT_ALERT_URL).trim() || DEFAULT_ALERT_URL,
    feedUrl: String(env.EWS_RSS_URL || DEFAULT_RSS_URL).trim() || DEFAULT_RSS_URL,
  };
}

function escapeXml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function parseRssItems() {
  const savedValue = getMetaValue(RSS_FEED_ITEMS_META_KEY);
  if (!savedValue) {
    return [];
  }

  try {
    const items = JSON.parse(savedValue);
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

function saveRssItems(items) {
  setMetaValue(RSS_FEED_ITEMS_META_KEY, JSON.stringify(items.slice(0, MAX_RSS_ITEMS)));
}

function getRssItems() {
  return parseRssItems();
}

function getEmergencyLevel(snapshot) {
  const signal = getEmergencySnapshotSignal(snapshot);
  return Math.round(Number(signal?.emergencyLevel || 1));
}

function buildRssItem(snapshot, status = null, env = process.env) {
  const config = getRssConfig(env);
  const signal = getEmergencySnapshotSignal(snapshot);
  const latestSlotKey = getLatestSlotKey(snapshot, status);
  const alertText = formatEmergencyLevelAlert(snapshot, {
    alertUrl: config.siteUrl,
  });
  const [title, summary] = alertText.split("\n");
  const timestamp =
    signal?.asOf ||
    snapshot?.current?.asOf ||
    status?.latestSampledAt ||
    snapshot?.snapshotGeneratedAt ||
    new Date().toISOString();
  const publishedAt = new Date(timestamp);

  return {
    slotKey: latestSlotKey,
    guid: `ews-emergency-level-5-${latestSlotKey || timestamp}`,
    title,
    summary,
    description: alertText,
    link: config.siteUrl,
    pubDate: Number.isFinite(publishedAt.getTime()) ? publishedAt.toUTCString() : new Date().toUTCString(),
  };
}

function maybeRecordEmergencyLevelRssItem({ snapshot, status = null, env = process.env, dryRun = false } = {}) {
  const emergencyLevel = getEmergencyLevel(snapshot);
  if (emergencyLevel !== 5) {
    return {
      ok: true,
      updated: false,
      reason: "emergency_level_not_5",
      emergencyLevel,
    };
  }

  const nextItem = buildRssItem(snapshot, status, env);
  const items = getRssItems();
  if (items.some((item) => item.guid === nextItem.guid || (nextItem.slotKey && item.slotKey === nextItem.slotKey))) {
    return {
      ok: true,
      updated: false,
      reason: "already_recorded_for_slot",
      latestSlotKey: nextItem.slotKey,
    };
  }

  if (!dryRun) {
    saveRssItems([nextItem, ...items]);
  }

  return {
    ok: true,
    updated: true,
    reason: dryRun ? "dry_run" : "recorded",
    latestSlotKey: nextItem.slotKey,
    item: nextItem,
  };
}

function buildEmergencyRssFeedXml({ items = getRssItems(), env = process.env } = {}) {
  const config = getRssConfig(env);
  const lastBuildDate = items[0]?.pubDate || EMPTY_FEED_DATE;

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Apocalypse Early Warning System</title>
    <link>${escapeXml(config.siteUrl)}</link>
    <description>Emergency level 5 alerts from the Apocalypse Early Warning System.</description>
    <language>en-us</language>
    <lastBuildDate>${escapeXml(lastBuildDate)}</lastBuildDate>
    <ttl>30</ttl>
    <atom:link href="${escapeXml(config.feedUrl)}" rel="self" type="application/rss+xml"/>
${items
  .map(
    (item) => `    <item>
      <title>${escapeXml(item.title)}</title>
      <link>${escapeXml(item.link || config.siteUrl)}</link>
      <description>${escapeXml(item.description || item.summary || "")}</description>
      <guid isPermaLink="false">${escapeXml(item.guid)}</guid>
      <pubDate>${escapeXml(item.pubDate)}</pubDate>
    </item>`,
  )
  .join("\n")}
  </channel>
</rss>
`;
}

module.exports = {
  DEFAULT_RSS_URL,
  RSS_FEED_ITEMS_META_KEY,
  buildEmergencyRssFeedXml,
  buildRssItem,
  getRssConfig,
  getRssItems,
  maybeRecordEmergencyLevelRssItem,
};
