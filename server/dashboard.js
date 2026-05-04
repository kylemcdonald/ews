const {
  getMetaValue,
  getConcurrentCount,
  getLiveAircraft,
  getAllRollingMetrics,
  getTrackedAircraftCount,
  getTrackingSummary,
  areAllTrackedAircraftDemo,
} = require("./db");
const { getDemoDashboard } = require("./demo-data");

const DAY_MS = 24 * 60 * 60 * 1000;
const HALF_HOUR_MS = 30 * 60 * 1000;
const MATCH_WINDOW_MS = 20 * 60 * 1000;
const HEATMAP_SOURCE = "adsbx_heatmap";
const HEATMAP_STATUS_META_KEY = "adsbx_heatmap_status";
const META_SLOT_KEY = "adsbx_heatmap_slot_key";
const META_SAMPLED_AT = "adsbx_heatmap_sampled_at";
const META_URL = "adsbx_heatmap_url";
const META_CACHE_PATH = "adsbx_heatmap_cache_path";

const CONCURRENT_LOOKBACK_DAYS = 28;
const CONCURRENT_SLOT_HALF_LIFE_DAYS = 2;
const CONCURRENT_WEEKDAY_SLOT_HALF_LIFE_DAYS = 3;
const CONCURRENT_SLOT_NEIGHBOR_WEIGHT = 1;
const CONCURRENT_WEEKDAY_SLOT_NEIGHBOR_WEIGHT = 1;
const CONCURRENT_WEEKDAY_SHRINKAGE = 2;
const CONCURRENT_MIN_HISTORY_SAMPLES = 7 * 48;
const CONCURRENT_MIN_STD_DEV = 8;
const CONCURRENT_CALENDAR_LOOKBACK_DAYS = 366 * 3;
const CONCURRENT_CALENDAR_MIN_AGE_DAYS = 180;
const CONCURRENT_CALENDAR_NEIGHBOR_DAYS = 7;
const CONCURRENT_CALENDAR_DISTANCE_SCALE_DAYS = 2.5;
const CONCURRENT_CALENDAR_HALF_LIFE_DAYS = 366 * 2;
const CONCURRENT_CALENDAR_WEEKDAY_MISMATCH_WEIGHT = 0.6;
const CONCURRENT_CALENDAR_SHRINKAGE = 2;
const CONCURRENT_ANNUAL_RATIO_MODEL = "smoothed-prior-year-ratio";
const CONCURRENT_ANNUAL_RATIO_TIME_ZONE = "America/Los_Angeles";
const CONCURRENT_ANNUAL_RATIO_YEAR_LOOKBACK = 3;
const CONCURRENT_ANNUAL_RATIO_DAY_RADIUS = 2;
const CONCURRENT_ANNUAL_RATIO_SLOT_RADIUS = 5;
const CONCURRENT_ANNUAL_RATIO_DAY_SIGMA = 1.25;
const CONCURRENT_ANNUAL_RATIO_SLOT_SIGMA = 3.125;
const CONCURRENT_ANNUAL_RATIO_YEAR_HALF_LIFE = 2;
const CONCURRENT_ANNUAL_RATIO_SHRINKAGE = 1;
const CONCURRENT_ANNUAL_RATIO_MIN = 0.25;
const CONCURRENT_ANNUAL_RATIO_MAX = 2.25;
const MIN_ALARM_SIGMA_THRESHOLD = 4;
const DEFAULT_ALARM_SIGMA_THRESHOLD = 7;
const ARCHIVE_DECIMAL_PLACES = 2;
const timeZonePartFormatters = new Map();

function mean(values) {
  const finiteValues = values.filter((value) => Number.isFinite(value));
  if (!finiteValues.length) {
    return null;
  }

  return finiteValues.reduce((total, value) => total + value, 0) / finiteValues.length;
}

function weightedMean(components) {
  const activeComponents = components.filter(
    (component) => component.weight > 0 && Number.isFinite(component.value),
  );
  if (!activeComponents.length) {
    return null;
  }

  const totalWeight = activeComponents.reduce((total, component) => total + component.weight, 0);
  return activeComponents.reduce((total, component) => total + component.weight * component.value, 0) / totalWeight;
}

function computeAlertLevel(sigmaShift, alarmSigmaThreshold) {
  const elevatedSigmaThreshold = Math.max(1.5, alarmSigmaThreshold / 2);
  if (sigmaShift >= alarmSigmaThreshold) {
    return "alarm";
  }

  if (sigmaShift >= elevatedSigmaThreshold) {
    return "elevated";
  }

  return "normal";
}

function computeGaugeValue(sigmaShift, alarmSigmaThreshold) {
  if (!alarmSigmaThreshold) {
    return 0;
  }

  const clampedShift = Math.max(0, Math.min(alarmSigmaThreshold, sigmaShift));
  return Math.max(0, Math.min(1, clampedShift / alarmSigmaThreshold));
}

function computeEmergencyLevel(sigmaShift, alarmSigmaThreshold) {
  const normalizedSigma = Math.max(0, Number(sigmaShift || 0));
  if (!alarmSigmaThreshold) {
    return 1;
  }

  if (normalizedSigma >= alarmSigmaThreshold) {
    return 5;
  }

  return Math.min(4, Math.max(1, Math.floor((normalizedSigma / alarmSigmaThreshold) * 4) + 1));
}

function computeBaselineSignal(currentValue, baselineMean, baselineStdDev, alarmSigmaThreshold) {
  if (!baselineStdDev) {
    return {
      sigmaShift: 0,
      gaugeValue: 0,
      alertLevel: "normal",
      emergencyLevel: 1,
    };
  }

  const sigmaShift = (currentValue - baselineMean) / baselineStdDev;
  return {
    sigmaShift,
    gaugeValue: computeGaugeValue(sigmaShift, alarmSigmaThreshold),
    alertLevel: computeAlertLevel(sigmaShift, alarmSigmaThreshold),
    emergencyLevel: computeEmergencyLevel(sigmaShift, alarmSigmaThreshold),
  };
}

function roundNumber(value, decimalPlaces) {
  if (!Number.isFinite(value) || Number.isInteger(value)) {
    return value;
  }

  const factor = 10 ** decimalPlaces;
  return Math.round(value * factor) / factor;
}

function encodeRuns(values) {
  const runs = [];
  for (const value of values) {
    const previous = runs[runs.length - 1];
    if (previous && previous[0] === value) {
      previous[1] += 1;
    } else {
      runs.push([value, 1]);
    }
  }

  return runs;
}

function buildTimestampDeltaRuns(records) {
  const deltas = [];
  for (let index = 1; index < records.length; index += 1) {
    const previousTimestamp = Date.parse(records[index - 1].sampledAt);
    const currentTimestamp = Date.parse(records[index].sampledAt);

    if (!Number.isFinite(previousTimestamp) || !Number.isFinite(currentTimestamp)) {
      return null;
    }

    deltas.push(currentTimestamp - previousTimestamp);
  }

  return encodeRuns(deltas);
}

function compactArchiveSeries(records) {
  if (!records.length) {
    return {
      v: 1,
      t0: null,
      tr: [],
      c: [],
      p: [],
      s: [],
    };
  }

  const timestampDeltaRuns = buildTimestampDeltaRuns(records);
  if (!timestampDeltaRuns) {
    return records.map((record) => ({
      sampledAt: record.sampledAt,
      concurrentCount: record.concurrentCount,
      predictedConcurrentCount: roundNumber(
        record.expectedConcurrentCount ?? record.predictedConcurrentCount,
        ARCHIVE_DECIMAL_PLACES,
      ),
      predictedConcurrentStdDev: roundNumber(
        record.expectedConcurrentStdDev ?? record.predictedConcurrentStdDev,
        ARCHIVE_DECIMAL_PLACES,
      ),
    }));
  }

  return {
    v: 1,
    t0: records[0].sampledAt,
    tr: timestampDeltaRuns,
    c: records.map((record) => record.concurrentCount),
    p: records.map((record) =>
      roundNumber(record.expectedConcurrentCount ?? record.predictedConcurrentCount, ARCHIVE_DECIMAL_PLACES),
    ),
    s: records.map((record) =>
      roundNumber(record.expectedConcurrentStdDev ?? record.predictedConcurrentStdDev, ARCHIVE_DECIMAL_PLACES),
    ),
  };
}

function roundIsoToNearestHalfHour(referenceIso) {
  const timestamp = Date.parse(referenceIso);
  if (!Number.isFinite(timestamp)) {
    return referenceIso;
  }

  return new Date(Math.round(timestamp / HALF_HOUR_MS) * HALF_HOUR_MS).toISOString();
}

function normalizeSlot(slot) {
  return (slot + 48) % 48;
}

function getSlotFromIso(referenceIso) {
  const date = new Date(referenceIso);
  return date.getUTCHours() * 2 + (date.getUTCMinutes() >= 30 ? 1 : 0);
}

function getWeekdayFromIso(referenceIso) {
  return new Date(referenceIso).getUTCDay();
}

function getDayOfYearFromIso(referenceIso) {
  const date = new Date(referenceIso);
  const dayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  return Math.floor((dayStart - yearStart) / DAY_MS);
}

function getTimeZonePartFormatter(timeZone) {
  const resolvedTimeZone = timeZone || "UTC";
  if (!timeZonePartFormatters.has(resolvedTimeZone)) {
    timeZonePartFormatters.set(
      resolvedTimeZone,
      new Intl.DateTimeFormat("en-US", {
        timeZone: resolvedTimeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }),
    );
  }

  return timeZonePartFormatters.get(resolvedTimeZone);
}

function getTimeZoneCalendarParts(referenceIso, timeZone) {
  const formatter = getTimeZonePartFormatter(timeZone);
  const parts = {};
  for (const part of formatter.formatToParts(new Date(referenceIso))) {
    if (part.type !== "literal") {
      parts[part.type] = Number(part.value);
    }
  }

  const hour = parts.hour === 24 ? 0 : parts.hour;
  const minute = parts.minute >= 30 ? 30 : 0;
  const slot = hour * 2 + (minute >= 30 ? 1 : 0);

  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour,
    minute,
    slot,
  };
}

function buildLocalDateSlotKey(year, month, day, slot) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}-${String(
    normalizeSlot(slot),
  ).padStart(2, "0")}`;
}

function buildLocalPartsSlotKey(parts) {
  return buildLocalDateSlotKey(parts.year, parts.month, parts.day, parts.slot);
}

function buildOffsetLocalPartsSlotKey(parts, yearOffset, dayOffset, slotOffset) {
  const offsetSlot = parts.slot + slotOffset;
  const dayCarry = Math.floor(offsetSlot / 48);
  const normalizedSlot = normalizeSlot(offsetSlot);
  const date = new Date(
    Date.UTC(parts.year - yearOffset, parts.month - 1, parts.day + dayOffset + dayCarry),
  );

  return buildLocalDateSlotKey(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    normalizedSlot,
  );
}

function getNeighborSlots(slot) {
  return [normalizeSlot(slot - 1), normalizeSlot(slot), normalizeSlot(slot + 1)];
}

function trimHistoryQueue(queue, cutoffTimestampMs) {
  while (queue.length && queue[0].timestampMs < cutoffTimestampMs) {
    queue.shift();
  }
}

function computeDecayedMean(entries, referenceTimestampMs, halfLifeDays, valueKey) {
  if (!entries.length) {
    return null;
  }

  const lambda = Math.log(2) / Math.max(0.01, halfLifeDays);
  let totalWeight = 0;
  let weightedSum = 0;

  for (const entry of entries) {
    const value = Number(entry[valueKey]);
    if (!Number.isFinite(value)) {
      continue;
    }

    const ageDays = Math.max(0, (referenceTimestampMs - entry.timestampMs) / DAY_MS);
    const weight = Math.exp(-lambda * ageDays);
    totalWeight += weight;
    weightedSum += weight * value;
  }

  return totalWeight ? weightedSum / totalWeight : null;
}

function computeDecayedRootMeanSquare(entries, referenceTimestampMs, halfLifeDays, valueKey) {
  if (!entries.length) {
    return null;
  }

  const lambda = Math.log(2) / Math.max(0.01, halfLifeDays);
  let totalWeight = 0;
  let weightedSquareSum = 0;

  for (const entry of entries) {
    const value = Number(entry[valueKey]);
    if (!Number.isFinite(value)) {
      continue;
    }

    const ageDays = Math.max(0, (referenceTimestampMs - entry.timestampMs) / DAY_MS);
    const weight = Math.exp(-lambda * ageDays);
    totalWeight += weight;
    weightedSquareSum += weight * value * value;
  }

  return totalWeight ? Math.sqrt(weightedSquareSum / totalWeight) : null;
}

function buildNeighborhoodValue(entriesBySlot, referenceTimestampMs, halfLifeDays, neighborWeight, valueKey) {
  const [previousEntries, currentEntries, nextEntries] = entriesBySlot;
  const value = weightedMean([
    {
      weight: neighborWeight,
      value: computeDecayedMean(previousEntries, referenceTimestampMs, halfLifeDays, valueKey),
    },
    {
      weight: 1,
      value: computeDecayedMean(currentEntries, referenceTimestampMs, halfLifeDays, valueKey),
    },
    {
      weight: neighborWeight,
      value: computeDecayedMean(nextEntries, referenceTimestampMs, halfLifeDays, valueKey),
    },
  ]);

  const exactSampleCount = currentEntries.length;
  const effectiveSampleCount =
    currentEntries.length + neighborWeight * (previousEntries.length + nextEntries.length);

  return {
    value,
    exactSampleCount,
    effectiveSampleCount,
  };
}

function buildNeighborhoodScale(entriesBySlot, referenceTimestampMs, halfLifeDays, neighborWeight, valueKey) {
  return weightedMean([
    {
      weight: neighborWeight,
      value: computeDecayedRootMeanSquare(entriesBySlot[0], referenceTimestampMs, halfLifeDays, valueKey),
    },
    {
      weight: 1,
      value: computeDecayedRootMeanSquare(entriesBySlot[1], referenceTimestampMs, halfLifeDays, valueKey),
    },
    {
      weight: neighborWeight,
      value: computeDecayedRootMeanSquare(entriesBySlot[2], referenceTimestampMs, halfLifeDays, valueKey),
    },
  ]);
}

function normalizeDayOfYear(dayOfYear) {
  return (dayOfYear + 366) % 366;
}

function calendarDistanceDays(leftDayOfYear, rightDayOfYear) {
  const directDistance = Math.abs(leftDayOfYear - rightDayOfYear);
  return Math.min(directDistance, 366 - directDistance);
}

function buildCalendarResidualAdjustment(state, referenceIso, referenceTimestampMs) {
  const referenceDayOfYear = getDayOfYearFromIso(referenceIso);
  const referenceWeekday = getWeekdayFromIso(referenceIso);
  const minAgeMs = CONCURRENT_CALENDAR_MIN_AGE_DAYS * DAY_MS;
  const maxAgeMs = CONCURRENT_CALENDAR_LOOKBACK_DAYS * DAY_MS;
  const decayLambda = Math.log(2) / CONCURRENT_CALENDAR_HALF_LIFE_DAYS;
  let totalWeight = 0;
  let weightedResidual = 0;
  let sampleCount = 0;

  for (
    let offset = -CONCURRENT_CALENDAR_NEIGHBOR_DAYS;
    offset <= CONCURRENT_CALENDAR_NEIGHBOR_DAYS;
    offset += 1
  ) {
    const bucket = state.calendarDayResidualHistory[normalizeDayOfYear(referenceDayOfYear + offset)];
    for (const entry of bucket) {
      const ageMs = referenceTimestampMs - entry.timestampMs;
      if (ageMs < minAgeMs || ageMs > maxAgeMs) {
        continue;
      }

      const distanceDays = calendarDistanceDays(entry.dayOfYear, referenceDayOfYear);
      if (distanceDays > CONCURRENT_CALENDAR_NEIGHBOR_DAYS) {
        continue;
      }

      const calendarWeight = Math.exp(
        -0.5 * (distanceDays / CONCURRENT_CALENDAR_DISTANCE_SCALE_DAYS) ** 2,
      );
      const ageWeight = Math.exp(-decayLambda * (ageMs / DAY_MS));
      const weekdayWeight =
        entry.weekday === referenceWeekday ? 1 : CONCURRENT_CALENDAR_WEEKDAY_MISMATCH_WEIGHT;
      const sampleWeight = Math.max(1, Math.sqrt(entry.sampleCount || 1));
      const weight = calendarWeight * ageWeight * weekdayWeight * sampleWeight;
      totalWeight += weight;
      weightedResidual += weight * entry.residual;
      sampleCount += 1;
    }
  }

  if (!totalWeight) {
    return {
      calendarAdjustment: 0,
      calendarSampleCount: 0,
      calendarEffectiveWeight: 0,
      calendarBlendWeight: 0,
    };
  }

  const calendarBlendWeight = Math.max(
    0,
    Math.min(1, totalWeight / (totalWeight + CONCURRENT_CALENDAR_SHRINKAGE)),
  );

  return {
    calendarAdjustment: weightedResidual / totalWeight,
    calendarSampleCount: sampleCount,
    calendarEffectiveWeight: totalWeight,
    calendarBlendWeight,
  };
}

function buildAnnualRatioAdjustment(state, referenceIso, baseExpectedConcurrentCount, options = {}) {
  if (
    options.concurrentPredictionModel !== CONCURRENT_ANNUAL_RATIO_MODEL ||
    !Number.isFinite(baseExpectedConcurrentCount) ||
    baseExpectedConcurrentCount <= 0
  ) {
    return null;
  }

  const referenceParts = getTimeZoneCalendarParts(
    referenceIso,
    options.annualRatioTimeZone || CONCURRENT_ANNUAL_RATIO_TIME_ZONE,
  );
  const dayRadius = options.annualRatioDayRadius ?? CONCURRENT_ANNUAL_RATIO_DAY_RADIUS;
  const slotRadius = options.annualRatioSlotRadius ?? CONCURRENT_ANNUAL_RATIO_SLOT_RADIUS;
  const daySigma = options.annualRatioDaySigma ?? CONCURRENT_ANNUAL_RATIO_DAY_SIGMA;
  const slotSigma = options.annualRatioSlotSigma ?? CONCURRENT_ANNUAL_RATIO_SLOT_SIGMA;
  const yearLookback = options.annualRatioYearLookback ?? CONCURRENT_ANNUAL_RATIO_YEAR_LOOKBACK;
  const yearHalfLife = options.annualRatioYearHalfLife ?? CONCURRENT_ANNUAL_RATIO_YEAR_HALF_LIFE;
  const shrinkage = options.annualRatioShrinkage ?? CONCURRENT_ANNUAL_RATIO_SHRINKAGE;
  const minRatio = options.annualRatioMin ?? CONCURRENT_ANNUAL_RATIO_MIN;
  const maxRatio = options.annualRatioMax ?? CONCURRENT_ANNUAL_RATIO_MAX;
  const yearDecayLambda = Math.log(2) / Math.max(0.01, yearHalfLife);
  let totalWeight = 0;
  let weightedRatio = 0;
  let sampleCount = 0;

  for (let yearOffset = 1; yearOffset <= yearLookback; yearOffset += 1) {
    const yearWeight = Math.exp(-yearDecayLambda * (yearOffset - 1));
    for (let dayOffset = -dayRadius; dayOffset <= dayRadius; dayOffset += 1) {
      const dayWeight = Math.exp(-0.5 * (dayOffset / Math.max(0.01, daySigma)) ** 2);
      for (let slotOffset = -slotRadius; slotOffset <= slotRadius; slotOffset += 1) {
        const key = buildOffsetLocalPartsSlotKey(referenceParts, yearOffset, dayOffset, slotOffset);
        const entries = state.annualRatioHistory.get(key);
        if (!entries?.length) {
          continue;
        }

        const slotWeight = Math.exp(-0.5 * (slotOffset / Math.max(0.01, slotSigma)) ** 2);
        const weight = yearWeight * dayWeight * slotWeight;
        for (const entry of entries) {
          totalWeight += weight;
          weightedRatio += weight * entry.ratio;
          sampleCount += 1;
        }
      }
    }
  }

  if (!totalWeight) {
    return null;
  }

  const calendarBlendWeight = Math.max(0, Math.min(1, totalWeight / (totalWeight + shrinkage)));
  const ratio = Math.max(minRatio, Math.min(maxRatio, weightedRatio / totalWeight));
  const annualExpectedConcurrentCount = baseExpectedConcurrentCount * ratio;
  const calendarAdjustment = annualExpectedConcurrentCount - baseExpectedConcurrentCount;

  return {
    calendarAdjustment,
    calendarSampleCount: sampleCount,
    calendarEffectiveWeight: totalWeight,
    calendarBlendWeight,
    annualRatio: ratio,
    annualExpectedConcurrentCount,
  };
}

function trimRelevantHistories(state, weekday, slot, cutoffTimestampMs) {
  for (const neighborSlot of getNeighborSlots(slot)) {
    trimHistoryQueue(state.slotHistory[neighborSlot], cutoffTimestampMs);
    trimHistoryQueue(state.slotResidualHistory[neighborSlot], cutoffTimestampMs);
    trimHistoryQueue(state.weekdaySlotHistory[weekday][neighborSlot], cutoffTimestampMs);
    trimHistoryQueue(state.weekdaySlotResidualHistory[weekday][neighborSlot], cutoffTimestampMs);
  }
}

function buildConcurrentPredictionFromState(referenceIso, concurrentCount, state, options = {}) {
  const canonicalReferenceIso = roundIsoToNearestHalfHour(referenceIso);
  const referenceTimestampMs = Date.parse(canonicalReferenceIso);
  if (!Number.isFinite(referenceTimestampMs)) {
    return {
      canonicalReferenceIso,
      modelReady: false,
      expectedConcurrentCount: Number(concurrentCount || 0),
      expectedConcurrentStdDev: CONCURRENT_MIN_STD_DEV,
      timeOfDayExpected: null,
      timeOfWeekExpected: null,
      timeOfDaySampleCount: 0,
      timeOfWeekSampleCount: 0,
      timeOfWeekBlendWeight: 0,
      sigmaShift: 0,
      divergence: 0,
    };
  }

  const slot = getSlotFromIso(canonicalReferenceIso);
  const weekday = getWeekdayFromIso(canonicalReferenceIso);
  const cutoffTimestampMs = referenceTimestampMs - CONCURRENT_LOOKBACK_DAYS * DAY_MS;
  trimRelevantHistories(state, weekday, slot, cutoffTimestampMs);

  const neighborSlots = getNeighborSlots(slot);
  const slotCountHistories = neighborSlots.map((neighborSlot) => state.slotHistory[neighborSlot]);
  const weekdaySlotCountHistories = neighborSlots.map(
    (neighborSlot) => state.weekdaySlotHistory[weekday][neighborSlot],
  );
  const slotResidualHistories = neighborSlots.map((neighborSlot) => state.slotResidualHistory[neighborSlot]);
  const weekdaySlotResidualHistories = neighborSlots.map(
    (neighborSlot) => state.weekdaySlotResidualHistory[weekday][neighborSlot],
  );

  const timeOfDayComponent = buildNeighborhoodValue(
    slotCountHistories,
    referenceTimestampMs,
    CONCURRENT_SLOT_HALF_LIFE_DAYS,
    CONCURRENT_SLOT_NEIGHBOR_WEIGHT,
    "count",
  );
  const timeOfWeekComponent = buildNeighborhoodValue(
    weekdaySlotCountHistories,
    referenceTimestampMs,
    CONCURRENT_WEEKDAY_SLOT_HALF_LIFE_DAYS,
    CONCURRENT_WEEKDAY_SLOT_NEIGHBOR_WEIGHT,
    "count",
  );

  const timeOfDayResidualScale =
    buildNeighborhoodScale(
      slotResidualHistories,
      referenceTimestampMs,
      CONCURRENT_SLOT_HALF_LIFE_DAYS,
      CONCURRENT_SLOT_NEIGHBOR_WEIGHT,
      "residual",
    ) ??
    buildNeighborhoodScale(
      slotCountHistories,
      referenceTimestampMs,
      CONCURRENT_SLOT_HALF_LIFE_DAYS,
      CONCURRENT_SLOT_NEIGHBOR_WEIGHT,
      "count",
    );
  const timeOfWeekResidualScale =
    buildNeighborhoodScale(
      weekdaySlotResidualHistories,
      referenceTimestampMs,
      CONCURRENT_WEEKDAY_SLOT_HALF_LIFE_DAYS,
      CONCURRENT_WEEKDAY_SLOT_NEIGHBOR_WEIGHT,
      "residual",
    ) ??
    buildNeighborhoodScale(
      weekdaySlotCountHistories,
      referenceTimestampMs,
      CONCURRENT_WEEKDAY_SLOT_HALF_LIFE_DAYS,
      CONCURRENT_WEEKDAY_SLOT_NEIGHBOR_WEIGHT,
      "count",
    );

  const timeOfWeekBlendWeight = Math.max(
    0,
    Math.min(
      1,
      timeOfWeekComponent.effectiveSampleCount /
        (timeOfWeekComponent.effectiveSampleCount + CONCURRENT_WEEKDAY_SHRINKAGE),
    ),
  );
  const baseExpectedConcurrentCount =
    weightedMean([
      { weight: 1 - timeOfWeekBlendWeight, value: timeOfDayComponent.value },
      { weight: timeOfWeekBlendWeight, value: timeOfWeekComponent.value },
    ]) ?? Number(concurrentCount || 0);
  const residualCalendarAdjustment = buildCalendarResidualAdjustment(
    state,
    canonicalReferenceIso,
    referenceTimestampMs,
  );
  const annualRatioAdjustment = buildAnnualRatioAdjustment(
    state,
    canonicalReferenceIso,
    baseExpectedConcurrentCount,
    options,
  );
  const calendarAdjustment = annualRatioAdjustment || residualCalendarAdjustment;
  const expectedConcurrentCount =
    baseExpectedConcurrentCount +
    calendarAdjustment.calendarAdjustment * calendarAdjustment.calendarBlendWeight;
  const expectedConcurrentStdDev = Math.max(
    CONCURRENT_MIN_STD_DEV,
    weightedMean([
      { weight: 1 - timeOfWeekBlendWeight, value: timeOfDayResidualScale },
      { weight: timeOfWeekBlendWeight, value: timeOfWeekResidualScale },
    ]) ?? CONCURRENT_MIN_STD_DEV,
  );
  const modelReady =
    state.historySampleCount >= CONCURRENT_MIN_HISTORY_SAMPLES &&
    (Number.isFinite(timeOfDayComponent.value) || Number.isFinite(timeOfWeekComponent.value));
  const divergence = modelReady ? Number(concurrentCount || 0) - expectedConcurrentCount : 0;
  const calendarLearningResidual = modelReady
    ? Number(concurrentCount || 0) - baseExpectedConcurrentCount
    : 0;
  const sigmaShift = modelReady ? divergence / expectedConcurrentStdDev : 0;

  return {
    canonicalReferenceIso,
    modelReady,
    slot,
    weekday,
    timeOfDayExpected: timeOfDayComponent.value,
    timeOfWeekExpected: timeOfWeekComponent.value,
    timeOfDayResidualScale,
    timeOfWeekResidualScale,
    timeOfDaySampleCount: timeOfDayComponent.exactSampleCount,
    timeOfWeekSampleCount: timeOfWeekComponent.exactSampleCount,
    timeOfWeekBlendWeight,
    baseExpectedConcurrentCount,
    calendarAdjustment: calendarAdjustment.calendarAdjustment,
    calendarSampleCount: calendarAdjustment.calendarSampleCount,
    calendarEffectiveWeight: calendarAdjustment.calendarEffectiveWeight,
    calendarBlendWeight: calendarAdjustment.calendarBlendWeight,
    annualRatio: calendarAdjustment.annualRatio ?? null,
    annualExpectedConcurrentCount: calendarAdjustment.annualExpectedConcurrentCount ?? null,
    concurrentPredictionModel: options.concurrentPredictionModel || "calendar-residual",
    concurrentPredictionTimeZone: annualRatioAdjustment
      ? options.annualRatioTimeZone || CONCURRENT_ANNUAL_RATIO_TIME_ZONE
      : null,
    expectedConcurrentCount: modelReady ? expectedConcurrentCount : Number(concurrentCount || 0),
    expectedConcurrentStdDev: modelReady ? expectedConcurrentStdDev : CONCURRENT_MIN_STD_DEV,
    calendarLearningResidual,
    sigmaShift,
    divergence,
  };
}

function calibrateConcurrentAlarmThreshold(records) {
  if (!records.length) {
    return DEFAULT_ALARM_SIGMA_THRESHOLD;
  }

  const latestTimestamp = Date.parse(records[records.length - 1].sampledAt);
  const lowerBound = latestTimestamp - 365 * DAY_MS;
  const dailyPeaks = new Map();

  for (const record of records) {
    const sampledAtMs = Date.parse(record.sampledAt);
    if (!Number.isFinite(sampledAtMs) || sampledAtMs < lowerBound || !record.modelReady) {
      continue;
    }

    const day = record.sampledAt.slice(0, 10);
    dailyPeaks.set(day, Math.max(dailyPeaks.get(day) ?? -Infinity, record.sigmaShift));
  }

  const sortedPeaks = Array.from(dailyPeaks.values()).sort((left, right) => right - left);
  if (!sortedPeaks.length) {
    return DEFAULT_ALARM_SIGMA_THRESHOLD;
  }

  if (sortedPeaks.length === 1) {
    return Math.max(MIN_ALARM_SIGMA_THRESHOLD, Math.ceil(sortedPeaks[0] * 10) / 10);
  }

  const secondHighestPeak = sortedPeaks[1];
  return Math.max(MIN_ALARM_SIGMA_THRESHOLD, Math.ceil((secondHighestPeak + 0.05) * 10) / 10);
}

function buildConcurrentPredictionContext(rows, options = {}) {
  const normalizedRows = rows.map((row) => ({
    sampledAt: row.sampledAt,
    concurrentCount: Number(row.concurrentCount || 0),
  }));
  const state = {
    slotHistory: Array.from({ length: 48 }, () => []),
    weekdaySlotHistory: Array.from({ length: 7 }, () => Array.from({ length: 48 }, () => [])),
    slotResidualHistory: Array.from({ length: 48 }, () => []),
    weekdaySlotResidualHistory: Array.from({ length: 7 }, () => Array.from({ length: 48 }, () => [])),
    calendarDayResidualHistory: Array.from({ length: 366 }, () => []),
    annualRatioHistory: new Map(),
    historySampleCount: 0,
    alarmSigmaThreshold: DEFAULT_ALARM_SIGMA_THRESHOLD,
  };
  const provisionalRecords = [];
  let pendingCalendarDay = null;
  let pendingCalendarResiduals = [];

  function flushPendingCalendarDay() {
    if (!pendingCalendarDay || !pendingCalendarResiduals.length) {
      pendingCalendarDay = null;
      pendingCalendarResiduals = [];
      return;
    }

    const residual = mean(pendingCalendarResiduals);
    if (Number.isFinite(residual)) {
      state.calendarDayResidualHistory[pendingCalendarDay.dayOfYear].push({
        ...pendingCalendarDay,
        residual,
        sampleCount: pendingCalendarResiduals.length,
      });
    }

    pendingCalendarDay = null;
    pendingCalendarResiduals = [];
  }

  for (const row of normalizedRows) {
    const canonicalRowIso = roundIsoToNearestHalfHour(row.sampledAt);
    const rowDayKey = canonicalRowIso.slice(0, 10);
    if (pendingCalendarDay && pendingCalendarDay.dayKey !== rowDayKey) {
      flushPendingCalendarDay();
    }
    if (!pendingCalendarDay) {
      const timestampMs = Date.parse(canonicalRowIso);
      pendingCalendarDay = {
        dayKey: rowDayKey,
        timestampMs,
        dayOfYear: getDayOfYearFromIso(canonicalRowIso),
        weekday: getWeekdayFromIso(canonicalRowIso),
      };
    }

    const prediction = buildConcurrentPredictionFromState(row.sampledAt, row.concurrentCount, state, options);
    provisionalRecords.push({
      sampledAt: row.sampledAt,
      concurrentCount: row.concurrentCount,
      ...prediction,
    });

    const timestampMs = Date.parse(row.sampledAt);
    const historyEntry = {
      timestampMs,
      count: row.concurrentCount,
    };
    state.slotHistory[prediction.slot].push(historyEntry);
    state.weekdaySlotHistory[prediction.weekday][prediction.slot].push(historyEntry);

    if (prediction.modelReady) {
      const residualEntry = {
        timestampMs,
        residual: prediction.divergence,
      };
      state.slotResidualHistory[prediction.slot].push(residualEntry);
      state.weekdaySlotResidualHistory[prediction.weekday][prediction.slot].push(residualEntry);
    }

    if (prediction.modelReady && Number.isFinite(prediction.calendarLearningResidual)) {
      pendingCalendarResiduals.push(prediction.calendarLearningResidual);
    }

    if (
      prediction.modelReady &&
      Number.isFinite(prediction.baseExpectedConcurrentCount) &&
      prediction.baseExpectedConcurrentCount > 0
    ) {
      const annualRatioKey = buildLocalPartsSlotKey(
        getTimeZoneCalendarParts(
          prediction.canonicalReferenceIso,
          options.annualRatioTimeZone || CONCURRENT_ANNUAL_RATIO_TIME_ZONE,
        ),
      );
      const annualRatioEntries = state.annualRatioHistory.get(annualRatioKey) || [];
      annualRatioEntries.push({
        timestampMs,
        ratio: row.concurrentCount / prediction.baseExpectedConcurrentCount,
      });
      state.annualRatioHistory.set(annualRatioKey, annualRatioEntries);
    }

    state.historySampleCount += 1;
  }
  flushPendingCalendarDay();

  const alarmSigmaThreshold = calibrateConcurrentAlarmThreshold(provisionalRecords);
  state.alarmSigmaThreshold = alarmSigmaThreshold;
  const elevatedSigmaThreshold = Math.max(1.5, alarmSigmaThreshold / 2);
  const records = provisionalRecords.map((record) => ({
    ...record,
    ...computeBaselineSignal(
      Number(record.concurrentCount || 0),
      Number(record.expectedConcurrentCount || 0),
      Number(record.expectedConcurrentStdDev || CONCURRENT_MIN_STD_DEV),
      alarmSigmaThreshold,
    ),
  }));
  const bySampledAt = new Map(records.map((record) => [record.sampledAt, record]));

  return {
    records,
    bySampledAt,
    alarmSigmaThreshold,
    elevatedSigmaThreshold,
    state,
  };
}

function getNearestConcurrentRecord(context, referenceIso) {
  const exactMatch = context.bySampledAt.get(referenceIso);
  if (exactMatch) {
    return exactMatch;
  }

  const referenceTimestamp = Date.parse(referenceIso);
  if (!Number.isFinite(referenceTimestamp)) {
    return null;
  }

  let nearestRecord = null;
  let nearestDifferenceMs = Number.POSITIVE_INFINITY;
  for (const record of context.records) {
    const differenceMs = Math.abs(Date.parse(record.sampledAt) - referenceTimestamp);
    if (differenceMs < nearestDifferenceMs) {
      nearestDifferenceMs = differenceMs;
      nearestRecord = record;
    }
  }

  return nearestDifferenceMs <= MATCH_WINDOW_MS ? nearestRecord : null;
}

function computeConcurrentPredictionModel(
  referenceIso,
  concurrentCount,
  concurrentContext = null,
  options = {},
) {
  const context = concurrentContext || buildConcurrentPredictionContext(getAllRollingMetrics(), options);
  const referenceRecord = getNearestConcurrentRecord(context, referenceIso);

  if (referenceRecord) {
    const resolvedConcurrentCount = Number(concurrentCount ?? referenceRecord.concurrentCount ?? 0);
    const compositeSignal = computeBaselineSignal(
      resolvedConcurrentCount,
      Number(referenceRecord.expectedConcurrentCount || 0),
      Number(referenceRecord.expectedConcurrentStdDev || CONCURRENT_MIN_STD_DEV),
      context.alarmSigmaThreshold,
    );

    return {
      ...referenceRecord,
      concurrentCount: resolvedConcurrentCount,
      divergence: resolvedConcurrentCount - Number(referenceRecord.expectedConcurrentCount || 0),
      sigmaShift: compositeSignal.sigmaShift,
      gaugeValue: compositeSignal.gaugeValue,
      alertLevel: compositeSignal.alertLevel,
      emergencyLevel: compositeSignal.emergencyLevel,
      alarmSigmaThreshold: context.alarmSigmaThreshold,
      elevatedSigmaThreshold: context.elevatedSigmaThreshold,
      compositeSignal,
    };
  }

  const prediction = buildConcurrentPredictionFromState(referenceIso, concurrentCount, context.state, options);
  const compositeSignal = computeBaselineSignal(
    Number(concurrentCount || 0),
    Number(prediction.expectedConcurrentCount || 0),
    Number(prediction.expectedConcurrentStdDev || CONCURRENT_MIN_STD_DEV),
    context.alarmSigmaThreshold,
  );

  return {
    ...prediction,
    alarmSigmaThreshold: context.alarmSigmaThreshold,
    elevatedSigmaThreshold: context.elevatedSigmaThreshold,
    compositeSignal,
  };
}

function parseSavedHeatmapStatus() {
  const savedValue = getMetaValue(HEATMAP_STATUS_META_KEY);
  if (!savedValue) {
    return null;
  }

  try {
    return JSON.parse(savedValue);
  } catch {
    return null;
  }
}

function buildStoredHeatmapStatus(overrides = {}) {
  const savedStatus = parseSavedHeatmapStatus() || {};
  return {
    provider: HEATMAP_SOURCE,
    providerLabel: "ADS-B Exchange heatmap",
    cadenceMinutes: 30,
    refreshing: false,
    nextRefreshAt: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
    latestSampledAt: getMetaValue(META_SAMPLED_AT),
    latestSlotKey: getMetaValue(META_SLOT_KEY),
    latestUrl: getMetaValue(META_URL),
    cachePath: getMetaValue(META_CACHE_PATH),
    usedCache: null,
    matchedCount: null,
    airborneCount: null,
    concurrentCount: null,
    ...savedStatus,
    latestSampledAt: getMetaValue(META_SAMPLED_AT),
    latestSlotKey: getMetaValue(META_SLOT_KEY),
    latestUrl: getMetaValue(META_URL),
    cachePath: getMetaValue(META_CACHE_PATH),
    ...overrides,
  };
}

function getTrailingConcurrentRecords(records, days = 365) {
  if (!records.length) {
    return [];
  }

  const latestTimestamp = Date.parse(records[records.length - 1].sampledAt);
  const lowerBound = latestTimestamp - days * DAY_MS;
  return records.filter((record) => Date.parse(record.sampledAt) >= lowerBound);
}

function buildDashboardPayload({
  liveStatus: liveStatusOverride = null,
  concurrentPredictionOptions = {},
} = {}) {
  const tracking = getTrackingSummary();
  const liveStatus = buildStoredHeatmapStatus(liveStatusOverride || {});
  const referenceIso = liveStatus.latestSampledAt || new Date().toISOString();
  const concurrentCount = getConcurrentCount(HEATMAP_SOURCE);
  const rollingHistory = getAllRollingMetrics();
  const concurrentContext = buildConcurrentPredictionContext(rollingHistory, concurrentPredictionOptions);
  const currentModel = computeConcurrentPredictionModel(
    referenceIso,
    concurrentCount,
    concurrentContext,
    concurrentPredictionOptions,
  );
  const archiveSeries = compactArchiveSeries(getTrailingConcurrentRecords(concurrentContext.records));

  return {
    mode: tracking.configured ? "configured" : "empty",
    warning: tracking.configured ? null : tracking.reason,
    cohort: tracking,
    watchlist: tracking,
    liveStatus: {
      ...liveStatus,
      concurrentCount,
    },
    current: {
      asOf: referenceIso,
      concurrentCount,
      baselineMean: currentModel.expectedConcurrentCount,
      baselineStdDev: currentModel.expectedConcurrentStdDev,
      zScore: currentModel.compositeSignal.sigmaShift,
      gaugeValue: currentModel.compositeSignal.gaugeValue,
      alertLevel: currentModel.compositeSignal.alertLevel,
      emergencyLevel: currentModel.compositeSignal.emergencyLevel,
      alarmSigmaThreshold: currentModel.alarmSigmaThreshold,
      elevatedSigmaThreshold: currentModel.elevatedSigmaThreshold,
    },
    signals: {
      composite: {
        asOf: referenceIso,
        actualConcurrentCount: concurrentCount,
        expectedConcurrentCount: currentModel.expectedConcurrentCount,
        expectedConcurrentStdDev: currentModel.expectedConcurrentStdDev,
        timeOfDayExpected: currentModel.timeOfDayExpected,
        timeOfWeekExpected: currentModel.timeOfWeekExpected,
        calendarAdjustment: currentModel.calendarAdjustment,
        calendarSampleCount: currentModel.calendarSampleCount,
        calendarEffectiveWeight: currentModel.calendarEffectiveWeight,
        calendarBlendWeight: currentModel.calendarBlendWeight,
        annualRatio: currentModel.annualRatio,
        annualExpectedConcurrentCount: currentModel.annualExpectedConcurrentCount,
        concurrentPredictionModel: currentModel.concurrentPredictionModel,
        concurrentPredictionTimeZone: currentModel.concurrentPredictionTimeZone,
        timeOfDaySampleCount: currentModel.timeOfDaySampleCount,
        timeOfWeekSampleCount: currentModel.timeOfWeekSampleCount,
        timeOfWeekBlendWeight: currentModel.timeOfWeekBlendWeight,
        sigmaShift: currentModel.compositeSignal.sigmaShift,
        gaugeValue: currentModel.compositeSignal.gaugeValue,
        alertLevel: currentModel.compositeSignal.alertLevel,
        emergencyLevel: currentModel.compositeSignal.emergencyLevel,
        alarmSigmaThreshold: currentModel.alarmSigmaThreshold,
        elevatedSigmaThreshold: currentModel.elevatedSigmaThreshold,
      },
    },
    liveAircraft: getLiveAircraft(HEATMAP_SOURCE),
    trends: {
      archive: archiveSeries,
    },
  };
}

function buildDashboardSnapshot({
  liveStatus = null,
  snapshotGeneratedAt = new Date().toISOString(),
  concurrentPredictionOptions = {},
} = {}) {
  const trackedCount = getTrackedAircraftCount();
  const hasAnyHistoricalData = getAllRollingMetrics().length > 0;
  const onlyDemoData = areAllTrackedAircraftDemo();

  if ((!trackedCount && !hasAnyHistoricalData) || onlyDemoData) {
    const demoDashboard = getDemoDashboard();
    return {
      ...demoDashboard,
      trends: {
        ...demoDashboard.trends,
        archive: compactArchiveSeries(demoDashboard.trends?.archive ?? []),
      },
      snapshotGeneratedAt,
    };
  }

  return {
    ...buildDashboardPayload({ liveStatus, concurrentPredictionOptions }),
    snapshotGeneratedAt,
  };
}

module.exports = {
  buildDashboardPayload,
  buildDashboardSnapshot,
  buildStoredHeatmapStatus,
  buildConcurrentPredictionContext,
  computeConcurrentPredictionModel,
  CONCURRENT_ANNUAL_RATIO_MODEL,
  CONCURRENT_ANNUAL_RATIO_TIME_ZONE,
  HEATMAP_SOURCE,
};
