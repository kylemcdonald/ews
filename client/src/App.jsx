import { memo, startTransition, useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { geoEqualEarth, geoGraticule10, geoMercator, geoPath } from 'd3-geo'
import { feature } from 'topojson-client'
import worldAtlas from 'world-atlas/countries-110m.json'
import './App.css'

const DASHBOARD_URL = import.meta.env.VITE_DASHBOARD_URL || '/api/dashboard'
const BETA_DASHBOARD_URL = import.meta.env.VITE_BETA_DASHBOARD_URL || '/beta-dashboard.json'
const DASHBOARD_CACHE_BUSTER_MINUTES = 5
const DASHBOARD_POLL_INTERVAL_MS = 5 * 60_000
const MAP_WIDTH = 800
const MAP_HEIGHT = 410
const AIRCRAFT_MARKER_PATH = 'M0 -9 L2.2 -1.5 L8 1.2 L8 3.4 L1.8 2.1 L1.8 6.4 L4.2 8 L4.2 9 L0 7.5 L-4.2 9 L-4.2 8 L-1.8 6.4 L-1.8 2.1 L-8 3.4 L-8 1.2 L-2.2 -1.5 Z'
const ARCHIVE_DAY_MS = 24 * 60 * 60 * 1000
const worldGeographies = feature(worldAtlas, worldAtlas.objects.countries).features

const NARROW_HISTORY_BREAKPOINT = 820
const CHART_TICK_COLOR = '#000000'
const CHART_GRID_COLOR = '#d4d4d4'
const CHART_PRIMARY_COLOR = '#0000ee'
const CHART_SECONDARY_COLOR = '#808080'
const CHART_LONG_WINDOW_SECONDARY_COLOR = 'rgba(128, 128, 128, 0.48)'
const WORLD_FEATURE_COLLECTION = { type: 'FeatureCollection', features: worldGeographies }
const LOADING_ANIMATION_URL = '/animation.mp4'
const BACKGROUND_URL = '/backgrounds/soft-cartoon-tile-15.webp'
const BACKGROUND_PRELOAD_LINK_ID = 'background-preload'
const ARCHIVE_CHART_WIDTH = 960
const ARCHIVE_CHART_MOBILE_WIDTH = 440
const ARCHIVE_CHART_HEIGHT = 320
const ARCHIVE_DIVERGENCE_HEIGHT = 180
const ARCHIVE_CHART_MARGIN = { top: 16, right: 18, bottom: 28, left: 44 }
const ARCHIVE_CHART_MOBILE_MARGIN = { top: 18, right: 16, bottom: 42, left: 54 }
const MAP_MIN_ZOOM = 1
const MAP_ZOOM_STEP = 1.45
const MAP_MAX_ZOOM = MAP_ZOOM_STEP ** 5
const EMERGENCY_LEVEL_COUNT = 5
const EMERGENCY_SCHEME_TAP_WINDOW_MS = 700
const AIRCRAFT_MODEL_DETAIL_RANK_LIMIT = 40
const AIRCRAFT_MODEL_WIKIPEDIA_URLS = new Map([
  ['BOMBARDIER AEROSPACE INC BD-100-1A10', 'https://en.wikipedia.org/wiki/Bombardier_Challenger_300'],
  ['BOMBARDIER INC BD-100-1A10', 'https://en.wikipedia.org/wiki/Bombardier_Challenger_300'],
  ['EMBRAER EXECUTIVE AIRCRAFT INC EMB-505', 'https://en.wikipedia.org/wiki/Embraer_Phenom_300'],
  ['TEXTRON AVIATION INC 680A', 'https://en.wikipedia.org/wiki/Cessna_Citation_Latitude'],
  ['CESSNA 560XL', 'https://en.wikipedia.org/wiki/Cessna_Citation_Excel'],
  ['TEXTRON AVIATION INC 560XL', 'https://en.wikipedia.org/wiki/Cessna_Citation_Excel'],
  ['LEARJET INC 45', 'https://en.wikipedia.org/wiki/Learjet_45'],
  ['CESSNA 560', 'https://en.wikipedia.org/wiki/Cessna_Citation_V'],
  ['CESSNA 525B', 'https://en.wikipedia.org/wiki/Cessna_CitationJet/M2'],
  ['TEXTRON AVIATION INC 525B', 'https://en.wikipedia.org/wiki/Cessna_CitationJet/M2'],
  ['CESSNA 525A', 'https://en.wikipedia.org/wiki/Cessna_CitationJet/M2'],
  ['CESSNA 525', 'https://en.wikipedia.org/wiki/Cessna_CitationJet/M2'],
  ['TEXTRON AVIATION INC 525', 'https://en.wikipedia.org/wiki/Cessna_CitationJet/M2'],
  ['CESSNA 680', 'https://en.wikipedia.org/wiki/Cessna_Citation_Sovereign'],
  ['GULFSTREAM AEROSPACE GV-SP (G550)', 'https://en.wikipedia.org/wiki/Gulfstream_G550'],
  ['LEARJET INC 60', 'https://en.wikipedia.org/wiki/Learjet_60'],
  ['RAYTHEON AIRCRAFT COMPANY HAWKER 800XP', 'https://en.wikipedia.org/wiki/Hawker_800'],
  ['CESSNA 510', 'https://en.wikipedia.org/wiki/Cessna_Citation_Mustang'],
  ['CESSNA 550', 'https://en.wikipedia.org/wiki/Cessna_Citation_II'],
  ['DASSAULT AVIATION FALCON 2000EX', 'https://en.wikipedia.org/wiki/Dassault_Falcon_2000'],
  ['CESSNA 650', 'https://en.wikipedia.org/wiki/Cessna_Citation_III'],
  ['RAYTHEON AIRCRAFT COMPANY 400A', 'https://en.wikipedia.org/wiki/Hawker_400'],
  ['PILATUS AIRCRAFT LTD PC-24', 'https://en.wikipedia.org/wiki/Pilatus_PC-24'],
  ['TEXTRON AVIATION INC 525C', 'https://en.wikipedia.org/wiki/Cessna_CitationJet/M2'],
  ['GULFSTREAM AEROSPACE CORP GVII-G600', 'https://en.wikipedia.org/wiki/Gulfstream_G500/G600'],
  ['HAWKER BEECHCRAFT CORP HAWKER 900XP', 'https://en.wikipedia.org/wiki/Hawker_800'],
  ['CESSNA 501', 'https://en.wikipedia.org/wiki/Cessna_Citation_I'],
  ['DASSAULT AVIATION FALCON 7X', 'https://en.wikipedia.org/wiki/Dassault_Falcon_7X'],
  ['HONDA AIRCRAFT CO LLC HA-420', 'https://en.wikipedia.org/wiki/Honda_HA-420_HondaJet'],
  ['LEARJET INC 31A', 'https://en.wikipedia.org/wiki/Learjet_31'],
  ['RAYTHEON AIRCRAFT COMPANY 390', 'https://en.wikipedia.org/wiki/Beechcraft_Premier_I'],
  ['CESSNA AIRCRAFT CO 560XLS', 'https://en.wikipedia.org/wiki/Cessna_Citation_Excel'],
  ['DASSAULT AVIATION FALCON 2000', 'https://en.wikipedia.org/wiki/Dassault_Falcon_2000'],
  ['DASSAULT FALCON 2000EX', 'https://en.wikipedia.org/wiki/Dassault_Falcon_2000'],
  ['GULFSTREAM AEROSPACE G-V', 'https://en.wikipedia.org/wiki/Gulfstream_V'],
  ['HAWKER BEECHCRAFT CORP 390', 'https://en.wikipedia.org/wiki/Beechcraft_Premier_I'],
  ['DASSAULT-BREGUET FALCON 10', 'https://en.wikipedia.org/wiki/Dassault_Falcon_10'],
  ['DASSAULT-BREGUET FALCON 50', 'https://en.wikipedia.org/wiki/Dassault_Falcon_50'],
  ['ECLIPSE AVIATION CORP EA500', 'https://en.wikipedia.org/wiki/Eclipse_500'],
  ['EMBRAER EXECUTIVE AIRCRAFT INC EMB-500', 'https://en.wikipedia.org/wiki/Embraer_Phenom_100'],
  ['GATES LEARJET CORP. 35A', 'https://en.wikipedia.org/wiki/Learjet_35'],
])
const AIRCRAFT_MODEL_MAX_PASSENGERS = new Map([
  ['BOMBARDIER AEROSPACE INC BD-100-1A10', 10],
  ['BOMBARDIER INC BD-100-1A10', 10],
  ['EMBRAER EXECUTIVE AIRCRAFT INC EMB-505', 10],
  ['TEXTRON AVIATION INC 680A', 9],
  ['CESSNA 560XL', 10],
  ['TEXTRON AVIATION INC 560XL', 10],
  ['LEARJET INC 45', 9],
  ['CESSNA 560', 9],
  ['CESSNA 525B', 9],
  ['TEXTRON AVIATION INC 525B', 9],
  ['CESSNA 525A', 9],
  ['CESSNA 525', 7],
  ['TEXTRON AVIATION INC 525', 7],
  ['CESSNA 680', 12],
  ['GULFSTREAM AEROSPACE GV-SP (G550)', 19],
  ['LEARJET INC 60', 10],
  ['RAYTHEON AIRCRAFT COMPANY HAWKER 800XP', 9],
  ['CESSNA 510', 5],
  ['CESSNA 550', 8],
  ['DASSAULT AVIATION FALCON 2000EX', 10],
  ['CESSNA 650', 13],
  ['RAYTHEON AIRCRAFT COMPANY 400A', 9],
  ['PILATUS AIRCRAFT LTD PC-24', 10],
  ['TEXTRON AVIATION INC 525C', 10],
  ['GULFSTREAM AEROSPACE CORP GVII-G600', 19],
  ['HAWKER BEECHCRAFT CORP HAWKER 900XP', 8],
  ['CESSNA 501', 5],
  ['DASSAULT AVIATION FALCON 7X', 16],
  ['HONDA AIRCRAFT CO LLC HA-420', 7],
  ['LEARJET INC 31A', 8],
  ['RAYTHEON AIRCRAFT COMPANY 390', 7],
  ['CESSNA AIRCRAFT CO 560XLS', 10],
  ['DASSAULT AVIATION FALCON 2000', 10],
  ['DASSAULT FALCON 2000EX', 10],
  ['GULFSTREAM AEROSPACE G-V', 19],
  ['HAWKER BEECHCRAFT CORP 390', 7],
  ['DASSAULT-BREGUET FALCON 10', 7],
  ['DASSAULT-BREGUET FALCON 50', 9],
  ['ECLIPSE AVIATION CORP EA500', 5],
  ['EMBRAER EXECUTIVE AIRCRAFT INC EMB-500', 7],
  ['GATES LEARJET CORP. 35A', 8],
])

function formatCount(value) {
  return new Intl.NumberFormat().format(Math.round(value || 0))
}

function formatDelta(value) {
  if (!Number.isFinite(value)) {
    return '0'
  }

  const rounded = Math.round(value)
  return `${rounded > 0 ? '+' : ''}${rounded}`
}

function formatSigned(value) {
  if (!Number.isFinite(value)) {
    return '0.0σ'
  }

  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}σ`
}

function getEmergencyLevel(signal) {
  return Math.min(
    EMERGENCY_LEVEL_COUNT,
    Math.max(1, Math.round(Number(signal?.emergencyLevel || 1))),
  )
}

function roundDateToNearestHalfHour(value) {
  const date = new Date(value)
  const timestamp = date.getTime()
  if (!Number.isFinite(timestamp)) {
    return null
  }

  return new Date(Math.round(timestamp / (30 * 60 * 1000)) * 30 * 60 * 1000)
}

function formatTimestamp(value) {
  if (!value) {
    return 'No timestamp'
  }

  const roundedDate = roundDateToNearestHalfHour(value)
  if (!roundedDate) {
    return 'No timestamp'
  }

  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(roundedDate)
}

function formatArchiveRangeDate(value) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(value))
}

function formatArchiveTick(value, windowDays) {
  const date = new Date(value)
  if (windowDays <= 2) {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(date)
  }

  if (windowDays <= 30) {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
    }).format(date)
  }

  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
  }).format(date)
}

function formatAltitude(value) {
  if (!Number.isFinite(value)) {
    return 'n/a'
  }

  return `${Math.round(value / 100) * 100} ft`
}

function formatSpeed(value) {
  if (!Number.isFinite(value)) {
    return 'n/a'
  }

  return `${Math.round(value)} kt`
}

function formatCoordinate(value, positiveHemisphere, negativeHemisphere) {
  if (!Number.isFinite(value)) {
    return 'n/a'
  }

  const hemisphere = value >= 0 ? positiveHemisphere : negativeHemisphere
  return `${Math.abs(value).toFixed(2)}° ${hemisphere}`
}

function formatCoordinates(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return 'n/a'
  }

  return `${formatCoordinate(lat, 'N', 'S')}, ${formatCoordinate(lon, 'E', 'W')}`
}

function normalizeModelLabel(value) {
  const normalized = String(value || '')
    .replace(/\s+/g, ' ')
    .trim()

  return normalized || 'Unknown model'
}

function getAircraftModelWikipediaUrl(modelLabel) {
  return AIRCRAFT_MODEL_WIKIPEDIA_URLS.get(normalizeModelLabel(modelLabel).toUpperCase()) || null
}

function getAircraftModelMaxPassengers(modelLabel) {
  return AIRCRAFT_MODEL_MAX_PASSENGERS.get(normalizeModelLabel(modelLabel).toUpperCase()) || null
}

function estimateMaxSeatsAirborne(aircraft, totalAircraftCountOverride = null) {
  const airborneAircraft = aircraft.filter((plane) => plane?.isAirborne !== false)
  const totalAircraftCount = Number(totalAircraftCountOverride)
  const scaledAircraftCount =
    Number.isFinite(totalAircraftCount) && totalAircraftCount > 0
      ? totalAircraftCount
      : airborneAircraft.length
  let knownAircraftCount = 0
  let knownSeatCount = 0

  for (const plane of airborneAircraft) {
    const maxPassengers = getAircraftModelMaxPassengers(plane.label)
    if (!Number.isFinite(maxPassengers)) {
      continue
    }

    knownAircraftCount += 1
    knownSeatCount += maxPassengers
  }

  if (!scaledAircraftCount || !knownAircraftCount) {
    return null
  }

  return {
    estimatedSeats: Math.round((knownSeatCount / knownAircraftCount) * scaledAircraftCount),
    knownAircraftCount,
    totalAircraftCount: scaledAircraftCount,
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function clearCurrentTextSelection() {
  const selection = window.getSelection?.()
  if (selection?.rangeCount) {
    selection.removeAllRanges()
  }
}

function constrainMapTransform(transform) {
  const scale = clamp(transform.scale, MAP_MIN_ZOOM, MAP_MAX_ZOOM)
  const minTranslateX = MAP_WIDTH - MAP_WIDTH * scale
  const minTranslateY = MAP_HEIGHT - MAP_HEIGHT * scale

  return {
    scale,
    translateX: clamp(transform.translateX, minTranslateX, 0),
    translateY: clamp(transform.translateY, minTranslateY, 0),
  }
}

function normalizeDegrees(value) {
  if (!Number.isFinite(value)) {
    return null
  }

  return ((value % 360) + 360) % 360
}

function getProjectedAircraftRotation(plane, projection) {
  const path = Array.isArray(plane.path) ? [...plane.path] : []
  const currentPosition = { lat: plane.lat, lon: plane.lon }
  const latestPathPoint = path[path.length - 1]

  if (
    Number.isFinite(currentPosition.lat) &&
    Number.isFinite(currentPosition.lon) &&
    (!latestPathPoint ||
      latestPathPoint.lat !== currentPosition.lat ||
      latestPathPoint.lon !== currentPosition.lon)
  ) {
    path.push(currentPosition)
  }

  const projectedPath = path
    .map((point) => {
      if (!Number.isFinite(point?.lat) || !Number.isFinite(point?.lon)) {
        return null
      }

      return projection([point.lon, point.lat])
    })
    .filter(Boolean)

  for (let index = projectedPath.length - 1; index > 0; index -= 1) {
    const currentPoint = projectedPath[index]
    const previousPoint = projectedPath[index - 1]
    const deltaX = currentPoint[0] - previousPoint[0]
    const deltaY = currentPoint[1] - previousPoint[1]

    if (Math.hypot(deltaX, deltaY) < 0.5) {
      continue
    }

    return normalizeDegrees((Math.atan2(deltaX, -deltaY) * 180) / Math.PI)
  }

  return normalizeDegrees(Number(plane.track))
}

function findFirstIndexAtOrAfter(values, target) {
  let low = 0
  let high = values.length

  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (values[mid] < target) {
      low = mid + 1
    } else {
      high = mid
    }
  }

  return clamp(low, 0, Math.max(0, values.length - 1))
}

function findLastIndexAtOrBefore(values, target) {
  let low = 0
  let high = values.length

  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (values[mid] <= target) {
      low = mid + 1
    } else {
      high = mid
    }
  }

  return clamp(low - 1, 0, Math.max(0, values.length - 1))
}

function findNearestTimestampIndex(values, target) {
  if (!values.length) {
    return -1
  }

  const rightIndex = findFirstIndexAtOrAfter(values, target)
  const leftIndex = clamp(rightIndex - 1, 0, values.length - 1)
  const clampedRightIndex = clamp(rightIndex, 0, values.length - 1)

  return Math.abs(values[leftIndex] - target) <= Math.abs(values[clampedRightIndex] - target)
    ? leftIndex
    : clampedRightIndex
}

function getNiceNumber(value, round) {
  if (!Number.isFinite(value) || value <= 0) {
    return 1
  }

  const exponent = Math.floor(Math.log10(value))
  const fraction = value / 10 ** exponent
  let niceFraction = 1

  if (round) {
    if (fraction < 1.5) {
      niceFraction = 1
    } else if (fraction < 3) {
      niceFraction = 2
    } else if (fraction < 7) {
      niceFraction = 5
    } else {
      niceFraction = 10
    }
  } else if (fraction <= 1) {
    niceFraction = 1
  } else if (fraction <= 2) {
    niceFraction = 2
  } else if (fraction <= 5) {
    niceFraction = 5
  } else {
    niceFraction = 10
  }

  return niceFraction * 10 ** exponent
}

function buildNumericTicks(minValue, maxValue, targetCount = 5) {
  if (!Number.isFinite(minValue) || !Number.isFinite(maxValue)) {
    return [0, 1]
  }

  if (minValue === maxValue) {
    const padding = Math.max(1, Math.abs(minValue) * 0.05)
    return [minValue - padding, minValue, minValue + padding]
  }

  const span = maxValue - minValue
  const step = getNiceNumber(span / Math.max(1, targetCount - 1), true)
  const niceMin = Math.floor(minValue / step) * step
  const niceMax = Math.ceil(maxValue / step) * step
  const ticks = []

  for (let value = niceMin; value <= niceMax + step * 0.5; value += step) {
    ticks.push(Number(value.toFixed(8)))
  }

  return ticks
}

function buildTimeTicks(minTimestamp, maxTimestamp, tickCount = 5) {
  if (!Number.isFinite(minTimestamp) || !Number.isFinite(maxTimestamp)) {
    return []
  }

  if (minTimestamp === maxTimestamp) {
    return [minTimestamp]
  }

  const ticks = []
  const step = (maxTimestamp - minTimestamp) / Math.max(1, tickCount - 1)

  for (let index = 0; index < tickCount; index += 1) {
    ticks.push(minTimestamp + step * index)
  }

  return ticks
}

function getLocalDateKey(timestamp) {
  const date = new Date(timestamp)
  const resolvedTimestamp = date.getTime()
  if (!Number.isFinite(resolvedTimestamp)) {
    return null
  }

  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

function filterUniqueDayTicks(ticks) {
  const seenDays = new Set()

  return ticks.filter((tick) => {
    const dayKey = getLocalDateKey(tick)
    if (!dayKey || seenDays.has(dayKey)) {
      return false
    }

    seenDays.add(dayKey)
    return true
  })
}

function buildArchiveTimeTicks(minTimestamp, maxTimestamp, windowDays, isNarrowLayout) {
  const tickCount = isNarrowLayout ? 3 : windowDays <= 2 ? 6 : windowDays <= 3 ? 3 : 5
  const ticks = buildTimeTicks(minTimestamp, maxTimestamp, tickCount)

  return windowDays <= 2 ? ticks : filterUniqueDayTicks(ticks)
}

function buildSvgLinePath(data, xScale, yScale, accessor) {
  let path = ''

  for (let index = 0; index < data.length; index += 1) {
    const value = accessor(data[index])
    if (!Number.isFinite(value)) {
      continue
    }

    const command = path ? 'L' : 'M'
    path += `${command}${xScale(index).toFixed(2)},${yScale(value).toFixed(2)}`
  }

  return path
}

function buildSvgAreaPath(data, xScale, yScale, accessor, baselineValue) {
  if (!data.length) {
    return ''
  }

  let path = `M${xScale(0).toFixed(2)},${yScale(baselineValue).toFixed(2)}`

  for (let index = 0; index < data.length; index += 1) {
    const value = accessor(data[index])
    if (!Number.isFinite(value)) {
      continue
    }

    path += `L${xScale(index).toFixed(2)},${yScale(value).toFixed(2)}`
  }

  path += `L${xScale(data.length - 1).toFixed(2)},${yScale(baselineValue).toFixed(2)}Z`
  return path
}

function getContinuousEmergencyLevel(sigmaShift, alarmSigmaThreshold) {
  const alarmSigma = Number(alarmSigmaThreshold)
  if (!Number.isFinite(alarmSigma) || alarmSigma <= 0) {
    return 1
  }

  const normalizedSigma = Math.max(0, Number(sigmaShift || 0))
  return 1 + (normalizedSigma / alarmSigma) * (EMERGENCY_LEVEL_COUNT - 1)
}

function formatEmergencyLevel(value) {
  if (!Number.isFinite(value)) {
    return '1.0'
  }

  return value.toFixed(1)
}

function buildEmergencyLevelReferenceLines(strokeWidth) {
  return Array.from({ length: EMERGENCY_LEVEL_COUNT }, (_, index) => {
    const level = index + 1

    return {
      value: level,
      label: String(level),
      stroke: level === 1 ? '#666666' : '#8a8a8a',
      strokeWidth,
      opacity: level === 1 ? 0.68 : 0.44,
    }
  })
}

function ArchiveSvgChart({
  data,
  height,
  windowDays,
  yTickFormatter = (value) => String(value),
  lines = [],
  area = null,
  showZeroLine = false,
  referenceLines = [],
  yAxisTicks = null,
  tooltipFormatter,
}) {
  const isNarrowLayout = useIsNarrowLayout()
  const [hoverIndex, setHoverIndex] = useState(null)

  const chartState = useMemo(() => {
    if (!data.length) {
      return null
    }

    const width = isNarrowLayout ? ARCHIVE_CHART_MOBILE_WIDTH : ARCHIVE_CHART_WIDTH
    const resolvedHeight = isNarrowLayout ? Math.max(height, 230) : height
    const margin = isNarrowLayout ? ARCHIVE_CHART_MOBILE_MARGIN : ARCHIVE_CHART_MARGIN
    const tickFontSize = isNarrowLayout ? 16 : 12
    const innerWidth = width - margin.left - margin.right
    const innerHeight = resolvedHeight - margin.top - margin.bottom
    const timestamps = data.map((sample) => Date.parse(sample.sampledAt || 0))
    const xMin = timestamps[0]
    const xMax = timestamps[timestamps.length - 1]
    const allValues = []

    for (const line of lines) {
      for (const sample of data) {
        const value = line.accessor(sample)
        if (Number.isFinite(value)) {
          allValues.push(value)
        }
      }
    }

    if (area) {
      for (const sample of data) {
        const value = area.accessor(sample)
        if (Number.isFinite(value)) {
          allValues.push(value)
        }
      }
      allValues.push(area.baselineValue)
    }

    for (const referenceLine of referenceLines) {
      if (Number.isFinite(referenceLine.value)) {
        allValues.push(referenceLine.value)
      }
    }

    const resolvedYAxisTicks = Array.isArray(yAxisTicks)
      ? yAxisTicks.filter((tick) => Number.isFinite(tick.value))
      : null
    const visibleYAxisTicks = resolvedYAxisTicks?.length ? resolvedYAxisTicks : null

    if (visibleYAxisTicks) {
      for (const tick of visibleYAxisTicks) {
        allValues.push(tick.value)
      }
    }

    if (showZeroLine) {
      allValues.push(0)
    }

    if (!allValues.length) {
      allValues.push(0, 1)
    }

    const minValue = Math.min(...allValues)
    const maxValue = Math.max(...allValues)
    const domainTicks = buildNumericTicks(minValue, maxValue, 5)
    const yTicks = visibleYAxisTicks || domainTicks.map((value) => ({ value, label: yTickFormatter(value) }))
    const yMin = domainTicks[0]
    const yMax = domainTicks[domainTicks.length - 1]
    const xTicks = buildArchiveTimeTicks(xMin, xMax, windowDays, isNarrowLayout)
    const xScale = (index) => margin.left + ((timestamps[index] - xMin) / Math.max(1, xMax - xMin)) * innerWidth
    const xScaleFromTimestamp = (timestamp) => margin.left + ((timestamp - xMin) / Math.max(1, xMax - xMin)) * innerWidth
    const yScale = (value) => margin.top + innerHeight - ((value - yMin) / Math.max(1e-9, yMax - yMin)) * innerHeight

    return {
      width,
      height: resolvedHeight,
      margin,
      innerWidth,
      innerHeight,
      tickFontSize,
      timestamps,
      xMin,
      xMax,
      yTicks,
      xTicks,
      xScale,
      xScaleFromTimestamp,
      yScale,
      yMin,
      yMax,
      referenceLines: referenceLines.filter((referenceLine) => Number.isFinite(referenceLine.value)),
    }
  }, [area, data, height, isNarrowLayout, lines, referenceLines, showZeroLine, windowDays, yAxisTicks, yTickFormatter])

  if (!chartState) {
    return null
  }

  const hoverSample = hoverIndex != null ? data[hoverIndex] : null
  const hoverX = hoverIndex != null ? chartState.xScale(hoverIndex) : null

  return (
    <div className="archive-chart-shell">
      {hoverSample ? (
        <div className="archive-chart-tooltip">
          {tooltipFormatter(hoverSample)}
        </div>
      ) : null}
      <svg
        viewBox={`0 0 ${chartState.width} ${chartState.height}`}
        className="archive-chart-svg"
        role="img"
        aria-label="Historical aircraft activity chart"
        onMouseLeave={() => setHoverIndex(null)}
        onTouchEnd={() => setHoverIndex(null)}
        onMouseMove={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect()
          const relativeX = ((event.clientX - bounds.left) / bounds.width) * chartState.width
          const timestamp =
            chartState.xMin +
            ((relativeX - chartState.margin.left) / Math.max(1, chartState.innerWidth)) * (chartState.xMax - chartState.xMin)
          setHoverIndex(findNearestTimestampIndex(chartState.timestamps, timestamp))
        }}
        onTouchMove={(event) => {
          const touch = event.touches[0]
          if (!touch) {
            return
          }

          const bounds = event.currentTarget.getBoundingClientRect()
          const relativeX = ((touch.clientX - bounds.left) / bounds.width) * chartState.width
          const timestamp =
            chartState.xMin +
            ((relativeX - chartState.margin.left) / Math.max(1, chartState.innerWidth)) * (chartState.xMax - chartState.xMin)
          setHoverIndex(findNearestTimestampIndex(chartState.timestamps, timestamp))
        }}
      >
        {chartState.yTicks.map((tick) => (
          <g key={`y-${tick.label || tick.value}`}>
            {tick.showLine === false ? null : (
              <line
                x1={chartState.margin.left}
                x2={chartState.width - chartState.margin.right}
                y1={chartState.yScale(tick.value)}
                y2={chartState.yScale(tick.value)}
                stroke={tick.stroke || CHART_GRID_COLOR}
                strokeWidth={tick.strokeWidth || 1}
                strokeDasharray={tick.strokeDasharray || '2 2'}
                opacity={tick.opacity ?? 1}
              />
            )}
            <text
              x={chartState.margin.left - 8}
              y={chartState.yScale(tick.value)}
              textAnchor="end"
              dominantBaseline="middle"
              fill={CHART_TICK_COLOR}
              fontSize={chartState.tickFontSize}
            >
              {tick.label ?? yTickFormatter(tick.value)}
            </text>
          </g>
        ))}
        {chartState.xTicks.map((tick, index) => (
          <g key={`x-${tick}`}>
            <text
              x={chartState.xScaleFromTimestamp(tick)}
              y={chartState.height - 6}
              textAnchor={
                chartState.xTicks.length === 1
                  ? 'start'
                  : index === 0
                    ? 'start'
                    : index === chartState.xTicks.length - 1
                      ? 'end'
                      : 'middle'
              }
              fill={CHART_TICK_COLOR}
              fontSize={chartState.tickFontSize}
            >
              {formatArchiveTick(tick, windowDays)}
            </text>
          </g>
        ))}
        {showZeroLine ? (
          <line
            x1={chartState.margin.left}
            x2={chartState.width - chartState.margin.right}
            y1={chartState.yScale(0)}
            y2={chartState.yScale(0)}
            stroke="#999999"
            strokeDasharray="5 5"
          />
        ) : null}
        {area ? (
          <path
            d={buildSvgAreaPath(data, chartState.xScale, chartState.yScale, area.accessor, area.baselineValue)}
            fill={area.fill}
            stroke="none"
          />
        ) : null}
        {chartState.referenceLines.map((referenceLine) => (
          <line
            key={`reference-${referenceLine.label}-${referenceLine.value}`}
            x1={chartState.margin.left}
            x2={chartState.width - chartState.margin.right}
            y1={chartState.yScale(referenceLine.value)}
            y2={chartState.yScale(referenceLine.value)}
            stroke={referenceLine.stroke || '#999999'}
            strokeWidth={referenceLine.strokeWidth || 1}
            strokeDasharray={referenceLine.strokeDasharray}
            opacity={referenceLine.opacity ?? 1}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {lines.map((line) => (
          <path
            key={line.name}
            d={buildSvgLinePath(data, chartState.xScale, chartState.yScale, line.accessor)}
            fill="none"
            stroke={line.stroke}
            strokeWidth={line.strokeWidth}
            strokeDasharray={line.strokeDasharray}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {hoverSample && hoverX != null ? (
          <g>
            <line
              x1={hoverX}
              x2={hoverX}
              y1={chartState.margin.top}
              y2={chartState.height - chartState.margin.bottom}
              stroke="#666666"
              strokeDasharray="4 4"
            />
            {lines.map((line) => {
              const value = line.accessor(hoverSample)
              if (!Number.isFinite(value)) {
                return null
              }

              return (
                <circle
                  key={`hover-${line.name}`}
                  cx={hoverX}
                  cy={chartState.yScale(value)}
                  r="3.5"
                  fill={line.stroke}
                  stroke="#ffffff"
                  strokeWidth="1"
                />
              )
            })}
            {area ? (
              <circle
                cx={hoverX}
                cy={chartState.yScale(area.accessor(hoverSample))}
                r="3.5"
                fill={area.stroke}
                stroke="#ffffff"
                strokeWidth="1"
              />
            ) : null}
          </g>
        ) : null}
      </svg>
    </div>
  )
}

function useIsNarrowLayout(breakpoint = NARROW_HISTORY_BREAKPOINT) {
  const [isNarrowLayout, setIsNarrowLayout] = useState(() => {
    if (typeof window === 'undefined') {
      return false
    }

    return window.innerWidth <= breakpoint
  })

  useEffect(() => {
    function updateLayoutMode() {
      setIsNarrowLayout(window.innerWidth <= breakpoint)
    }

    updateLayoutMode()
    window.addEventListener('resize', updateLayoutMode)
    return () => {
      window.removeEventListener('resize', updateLayoutMode)
    }
  }, [breakpoint])

  return isNarrowLayout
}

function buildLiveModelSummary(aircraft) {
  const grouped = new Map()

  for (const plane of aircraft) {
    const modelLabel = normalizeModelLabel(plane.label || plane.registration || plane.hex?.toUpperCase())
    const existing = grouped.get(modelLabel) || { modelLabel, count: 0 }
    existing.count += 1
    grouped.set(modelLabel, existing)
  }

  return Array.from(grouped.values())
    .sort((left, right) => right.count - left.count || left.modelLabel.localeCompare(right.modelLabel))
    .map((entry, index, entries) => {
      const total = aircraft.length || 1
      return {
        ...entry,
        rank: index + 1,
        share: entry.count / total,
        totalModels: entries.length,
      }
    })
}

function buildDashboardRequestUrl(dashboardUrl) {
  const url = new URL(dashboardUrl, window.location.href)
  const bucketMs = DASHBOARD_CACHE_BUSTER_MINUTES * 60 * 1000
  url.searchParams.set('v', String(Math.floor(Date.now() / bucketMs)))
  return url.toString()
}

function toFiniteNumber(value, fallback = null) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function expandTimestampRuns(startTimestamp, timestampRuns) {
  const startMs = Date.parse(startTimestamp)
  if (!Number.isFinite(startMs)) {
    return []
  }

  const timestamps = [new Date(startMs).toISOString()]
  let currentMs = startMs
  for (const run of timestampRuns || []) {
    const [deltaMs, count] = run
    for (let index = 0; index < count; index += 1) {
      currentMs += deltaMs
      timestamps.push(new Date(currentMs).toISOString())
    }
  }

  return timestamps
}

function normalizeArchiveSample(sample) {
  const concurrentCount = toFiniteNumber(sample.concurrentCount, 0)
  const predictedConcurrentCount = toFiniteNumber(sample.predictedConcurrentCount, 0)
  const predictedConcurrentStdDev = toFiniteNumber(sample.predictedConcurrentStdDev)
  const divergence = toFiniteNumber(
    sample.divergence,
    concurrentCount - predictedConcurrentCount,
  )
  const sigmaShift = toFiniteNumber(
    sample.sigmaShift,
    predictedConcurrentStdDev ? divergence / predictedConcurrentStdDev : 0,
  )

  return {
    sampledAt: sample.sampledAt,
    concurrentCount,
    predictedConcurrentCount,
    predictedConcurrentStdDev,
    divergence,
    sigmaShift,
  }
}

function normalizeDashboardArchive(archive) {
  if (Array.isArray(archive)) {
    return archive.map(normalizeArchiveSample)
  }

  if (!archive || archive.v !== 1 || !Array.isArray(archive.c)) {
    return []
  }

  const timestamps = expandTimestampRuns(archive.t0, archive.tr)
  const rowCount = Math.max(timestamps.length, archive.c.length, archive.p?.length || 0, archive.s?.length || 0)

  return Array.from({ length: rowCount }, (_, index) =>
    normalizeArchiveSample({
      sampledAt: timestamps[index],
      concurrentCount: archive.c[index],
      predictedConcurrentCount: archive.p?.[index],
      predictedConcurrentStdDev: archive.s?.[index],
    }),
  )
}

function createWorldProjection() {
  return geoEqualEarth().fitExtent(
    [
      [20, 16],
      [780, 394],
    ],
    WORLD_FEATURE_COLLECTION,
  )
}

function createUnitedStatesProjection() {
  return geoMercator()
    .center([-98.5, 38.5])
    .scale(790)
    .translate([MAP_WIDTH / 2, MAP_HEIGHT / 2 + 24])
}

function EmergencySummary({
  signal,
  latestSweep,
  actualCount,
  expectedCount,
  trackedCount,
  maxSeatsAirborneEstimate,
  onEmergencyLevelTap,
}) {
  const sigmaShift = signal?.sigmaShift ?? signal?.zScore ?? 0
  const deviationCount = Number(actualCount || 0) - Number(expectedCount || 0)
  const emergencyLevel = getEmergencyLevel(signal)

  return (
    <section className={`panel dial-panel emergency-level-${emergencyLevel}`}>
      <div className="panel-header">
        <div>
          <h2>
            <button
              type="button"
              className="emergency-level-trigger"
              onClick={onEmergencyLevelTap}
              onMouseDown={(event) => {
                if (event.detail > 1) {
                  event.preventDefault()
                }
              }}
              aria-label={`Emergency level ${emergencyLevel} of 5`}
            >
              Emergency level {emergencyLevel}/5
            </button>
          </h2>
        </div>
      </div>
      <div className="summary-text-block">
        <p className="summary-count-line">
          <strong>{formatCount(actualCount)}</strong>/<strong>{formatCount(trackedCount)}</strong>
          <AirplaneIcon className="summary-inline-icon summary-airplane-icon" />
          {' planes airborne'}
        </p>
        {maxSeatsAirborneEstimate ? (
          <p
            className="summary-count-line"
            title={`Known capacities for ${formatCount(maxSeatsAirborneEstimate.knownAircraftCount)} of ${formatCount(maxSeatsAirborneEstimate.totalAircraftCount)} airborne aircraft; missing capacities are scaled by the known average.`}
          >
            <strong>{formatCount(maxSeatsAirborneEstimate.estimatedSeats)}</strong>
            <PersonIcon className="summary-inline-icon summary-person-icon" />
            {' max people airborne'}
          </p>
        ) : null}
        <p>
          <strong>Deviation:</strong> {formatDelta(deviationCount)}
          <AirplaneIcon className="summary-inline-icon summary-airplane-icon" />
          ({formatSigned(sigmaShift)})
        </p>
        <p><strong>Last Update:</strong> {latestSweep}</p>
      </div>
    </section>
  )
}

function ArchiveChart({ data, signal }) {
  const archiveData = useMemo(() => normalizeDashboardArchive(data), [data])
  return <ArchiveChartPanel key={`archive-${archiveData.length}`} data={archiveData} signal={signal} defaultWindowDays={3} />
}

function getArchivePositionSnapDays(windowDays) {
  if (windowDays >= 28) {
    return 28
  }

  if (windowDays >= 7) {
    return 7
  }

  return 1
}

function snapArchiveEndDaysAgo(value, snapDays, maxEndDaysAgo) {
  const maxAlignedEndDaysAgo = Math.floor(maxEndDaysAgo / snapDays) * snapDays
  const snappedEndDaysAgo = Math.round(value / snapDays) * snapDays

  return clamp(snappedEndDaysAgo, 0, maxAlignedEndDaysAgo)
}

function ArchiveChartPanel({ data, signal, defaultWindowDays }) {
  const hasData = data.length > 0
  const sampledAtTimestamps = useMemo(() => data.map((sample) => Date.parse(sample.sampledAt || 0)), [data])
  const latestTimestamp = sampledAtTimestamps[sampledAtTimestamps.length - 1] || 0
  const earliestTimestamp = sampledAtTimestamps[0] || 0
  const maxDaysAvailable = Math.max(1, Math.ceil((latestTimestamp - earliestTimestamp) / ARCHIVE_DAY_MS))
  const [archiveWindowDays, setArchiveWindowDaysState] = useState(defaultWindowDays)
  const [endDaysAgo, setEndDaysAgo] = useState(0)
  const effectiveWindowDays = clamp(archiveWindowDays, 1, maxDaysAvailable)
  const maxEndDaysAgo = Math.max(0, maxDaysAvailable - effectiveWindowDays)
  const archivePositionSnapDays = getArchivePositionSnapDays(archiveWindowDays)
  const clampedEndDaysAgo = snapArchiveEndDaysAgo(endDaysAgo, archivePositionSnapDays, maxEndDaysAgo)
  const maxArchivePositionStep = Math.floor(maxEndDaysAgo / archivePositionSnapDays)
  const currentArchivePositionStep = Math.round(clampedEndDaysAgo / archivePositionSnapDays)
  const startDaysAgo = clampedEndDaysAgo + effectiveWindowDays
  const sliderValue = maxArchivePositionStep - currentArchivePositionStep
  const sliderPercent = maxArchivePositionStep > 0 ? (sliderValue / maxArchivePositionStep) * 100 : 100
  const isLongWindow = effectiveWindowDays >= 28
  const isDenseWindow = archiveWindowDays >= 28
  const primaryLineWidth = isDenseWindow ? 1.45 : 2.5
  const secondaryLineWidth = isDenseWindow ? 1.15 : 2
  const referenceLineWidth = isDenseWindow ? 0.75 : 1

  function setArchiveWindowDays(nextWindowDays) {
    const nextWindowDaysClamped = clamp(nextWindowDays, 1, maxDaysAvailable)
    const nextMaxEndDaysAgo = Math.max(0, maxDaysAvailable - nextWindowDaysClamped)
    const nextSnapDays = getArchivePositionSnapDays(nextWindowDays)

    setArchiveWindowDaysState(nextWindowDays)
    setEndDaysAgo((currentEndDaysAgo) => snapArchiveEndDaysAgo(currentEndDaysAgo, nextSnapDays, nextMaxEndDaysAgo))
  }

  function setArchivePosition(nextSliderValue) {
    setEndDaysAgo((maxArchivePositionStep - nextSliderValue) * archivePositionSnapDays)
  }

  const visibleWindowDays = effectiveWindowDays

  const { visibleData, visibleStart, visibleEnd } = useMemo(() => {
    const lowerBound = latestTimestamp - startDaysAgo * ARCHIVE_DAY_MS
    const upperBound = latestTimestamp - clampedEndDaysAgo * ARCHIVE_DAY_MS
    const startIndex = findFirstIndexAtOrAfter(sampledAtTimestamps, lowerBound)
    const endIndex = findLastIndexAtOrBefore(sampledAtTimestamps, upperBound)
    const slicedData = startIndex <= endIndex ? data.slice(startIndex, endIndex + 1) : []

    return {
      visibleData: slicedData,
      visibleStart: slicedData[0]?.sampledAt,
      visibleEnd: slicedData[slicedData.length - 1]?.sampledAt,
    }
  }, [clampedEndDaysAgo, data, latestTimestamp, sampledAtTimestamps, startDaysAgo])
  const emergencyLevelReferenceLines = buildEmergencyLevelReferenceLines(referenceLineWidth)
  const getSampleEmergencyLevel = (sample) => getContinuousEmergencyLevel(sample.sigmaShift, signal?.alarmSigmaThreshold)

  if (!hasData) {
    return (
      <section className="panel chart-panel">
        <div className="panel-header">
          <div><h2>Traffic Archive</h2></div>
        </div>
        <div className="empty-state">No historical half-hour data is available yet.</div>
      </section>
    )
  }

  return (
    <section className="panel chart-panel history-panel">
      <div className="panel-header">
        <div><h2>Traffic Archive</h2></div>
      </div>
      <div className="chart-toolbar">
        <div className="chart-range-copy">
          <strong>
            {formatArchiveRangeDate(visibleStart)} to {formatArchiveRangeDate(visibleEnd)}
          </strong>
        </div>
      </div>
      <div className="chart-range-toolbar">
        <div className="chart-range-slider">
          <div className="chart-range-slider-copy">
            <span>Past</span>
            <span>Now</span>
          </div>
          <div className="chart-range-slider-stack">
            <div className="chart-range-track" />
            <div
              className="chart-range-track-active"
              style={{
                left: 0,
                right: `${100 - sliderPercent}%`,
              }}
            />
            <input
              className="chart-range-input"
              type="range"
              min="0"
              max={maxArchivePositionStep}
              step="1"
              value={sliderValue}
              onChange={(event) => setArchivePosition(Number(event.target.value))}
              disabled={maxArchivePositionStep === 0}
              aria-label="Archive position"
              aria-valuetext={clampedEndDaysAgo === 0 ? 'Now' : `${clampedEndDaysAgo} days before now`}
            />
          </div>
        </div>
      </div>
      <div className="chart-toolbar chart-toolbar-archive">
        <fieldset className="chart-radio-group">
          <legend className="sr-only">Historical archive window</legend>
          <label className="chart-radio-option">
            <input
              type="radio"
              name="archive-window"
              checked={archiveWindowDays === 3}
              onChange={() => setArchiveWindowDays(3)}
            />
            <span>3 days</span>
          </label>
          <label className="chart-radio-option">
            <input
              type="radio"
              name="archive-window"
              checked={archiveWindowDays === 7}
              onChange={() => setArchiveWindowDays(7)}
            />
            <span>1 week</span>
          </label>
          <label className="chart-radio-option">
            <input
              type="radio"
              name="archive-window"
              checked={archiveWindowDays === 28}
              onChange={() => setArchiveWindowDays(28)}
            />
            <span>1 month</span>
          </label>
        </fieldset>
      </div>
      <div className="chart-frame">
        <ArchiveSvgChart
          data={visibleData}
          height={ARCHIVE_CHART_HEIGHT}
          windowDays={visibleWindowDays}
          lines={[
            {
              name: 'Observed concurrent',
              accessor: (sample) => sample.concurrentCount,
              stroke: CHART_PRIMARY_COLOR,
              strokeWidth: primaryLineWidth,
            },
            {
              name: 'Predicted concurrent',
              accessor: (sample) => sample.predictedConcurrentCount,
              stroke: isLongWindow ? CHART_LONG_WINDOW_SECONDARY_COLOR : CHART_SECONDARY_COLOR,
              strokeWidth: secondaryLineWidth,
              strokeDasharray: isLongWindow ? undefined : '7 6',
            },
          ]}
          tooltipFormatter={(sample) => (
            <>
              <strong>{formatTimestamp(sample.sampledAt)}</strong>
              <span>Observed: {formatCount(sample.concurrentCount)}</span>
              <span>Predicted: {formatCount(sample.predictedConcurrentCount)}</span>
            </>
          )}
        />
      </div>
      <div className="chart-subsection">
        <div className="chart-subsection-header">
          <strong>Historical Emergency Level</strong>
          <span>Level 5 is calibrated so only the highest daily peak in the trailing year should exceed it.</span>
        </div>
        <div className="chart-frame chart-frame-secondary">
          <ArchiveSvgChart
            data={visibleData}
            height={ARCHIVE_DIVERGENCE_HEIGHT}
            windowDays={visibleWindowDays}
            yAxisTicks={emergencyLevelReferenceLines.map((line) => ({
              value: line.value,
              label: line.label,
              showLine: false,
            }))}
            referenceLines={emergencyLevelReferenceLines}
            area={{
              accessor: getSampleEmergencyLevel,
              baselineValue: 1,
              fill: 'rgba(0, 0, 238, 0.14)',
              stroke: CHART_PRIMARY_COLOR,
            }}
            lines={[
              {
                name: 'Emergency level',
                accessor: getSampleEmergencyLevel,
                stroke: CHART_PRIMARY_COLOR,
                strokeWidth: primaryLineWidth,
              },
            ]}
            tooltipFormatter={(sample) => (
              <>
                <strong>{formatTimestamp(sample.sampledAt)}</strong>
                <span>Level: {formatEmergencyLevel(getSampleEmergencyLevel(sample))}</span>
                <span>Difference: {formatDelta(sample.divergence)}</span>
                <span>Sigma: {formatSigned(sample.sigmaShift)}</span>
              </>
            )}
          />
        </div>
      </div>
    </section>
  )
}

const MapBaseLayer = memo(function MapBaseLayer({ geographyPaths, graticulePath, isNarrowLayout }) {
  return (
    <>
      {!isNarrowLayout ? <rect x="8" y="8" width="784" height="394" rx="198" className="map-sphere" /> : null}
      <path d={graticulePath} className="map-graticule" />
      {geographyPaths.map((geo) => (
        <path key={geo.key} d={geo.path} className="map-geography" />
      ))}
    </>
  )
})

const MapMarkerLayer = memo(function MapMarkerLayer({
  isNarrowLayout,
  markerHaloRadius,
  markerHitRadius,
  markerIconScale,
  markers,
  onMarkerActivate,
  onMarkerHoverEnd,
  onMarkerHoverStart,
  selectedPlaneHex,
}) {
  return markers.map((marker) => (
    <g
      key={marker.hex}
      data-plane-hex={marker.hex}
      className={`map-marker${marker.hex === selectedPlaneHex ? ' map-marker-active' : ''}${isNarrowLayout ? ' map-marker-touch' : ''}`}
      transform={`translate(${marker.x} ${marker.y})`}
      onMouseEnter={isNarrowLayout ? undefined : () => onMarkerHoverStart(marker.hex)}
      onMouseLeave={isNarrowLayout ? undefined : () => onMarkerHoverEnd(marker.hex)}
      onFocus={() => onMarkerHoverStart(marker.hex)}
      onBlur={() => onMarkerHoverEnd(marker.hex)}
      onClick={(event) => {
        if (isNarrowLayout) {
          return
        }

        event.stopPropagation()
        onMarkerActivate(marker.hex)
      }}
      onPointerDown={(event) => {
        clearCurrentTextSelection()

        if (!isNarrowLayout) {
          event.stopPropagation()
          return
        }

        event.preventDefault()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onMarkerActivate(marker.hex)
        }
      }}
      tabIndex={0}
      role="button"
      aria-pressed={marker.hex === selectedPlaneHex}
      aria-label={marker.ariaLabel}
    >
      <g className="map-marker-visual">
        <circle r={markerHitRadius} className="map-marker-hit" />
        <circle r={markerHaloRadius} className="map-marker-halo" />
        <g transform={`rotate(${marker.rotation}) scale(${markerIconScale})`}>
          <path d={AIRCRAFT_MARKER_PATH} className="map-marker-plane" />
        </g>
        <title>{marker.title}</title>
      </g>
    </g>
  ))
})

function GlobalMap({ aircraft }) {
  const isNarrowLayout = useIsNarrowLayout()
  const [selectedPlaneHex, setSelectedPlaneHex] = useState(null)
  const [hoveredPlaneHex, setHoveredPlaneHex] = useState(null)
  const [mapTransform, setMapTransform] = useState(() => constrainMapTransform({
    scale: 1,
    translateX: 0,
    translateY: 0,
  }))
  const svgRef = useRef(null)
  const panStateRef = useRef(null)
  const projection = useMemo(
    () => (isNarrowLayout ? createUnitedStatesProjection() : createWorldProjection()),
    [isNarrowLayout],
  )
  const mapPath = useMemo(() => geoPath(projection), [projection])
  const graticulePath = useMemo(() => mapPath(geoGraticule10()), [mapPath])
  const geographyPaths = useMemo(
    () =>
      worldGeographies.map((geo) => ({
        key: geo.id || geo.properties?.name,
        path: mapPath(geo),
      })),
    [mapPath],
  )
  const projectedAircraft = useMemo(
    () =>
      aircraft
        .map((plane) => {
          const point = projection([plane.lon, plane.lat])
          if (!point || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) {
            return null
          }

          return {
            hex: plane.hex,
            x: point[0],
            y: point[1],
            rotation: getProjectedAircraftRotation(plane, projection) ?? 0,
            title: `${plane.label} · ${formatAltitude(plane.altitudeFt)} · ${formatSpeed(plane.groundSpeedKt)}`,
            ariaLabel: `${plane.label || plane.registration || plane.hex?.toUpperCase()} at ${formatAltitude(plane.altitudeFt)}, ${formatSpeed(plane.groundSpeedKt)}`,
          }
        })
        .filter(Boolean),
    [aircraft, projection],
  )
  const displayedPlaneHex = hoveredPlaneHex || selectedPlaneHex
  const displayedPlane = useMemo(
    () => aircraft.find((plane) => plane.hex === displayedPlaneHex) ?? null,
    [displayedPlaneHex, aircraft],
  )
  const markerHaloRadius = isNarrowLayout ? 18 : 12
  const markerHitRadius = isNarrowLayout ? 30 : 16
  const markerIconScale = isNarrowLayout ? 1.65 : 1
  const mapTransformValue = `matrix(${mapTransform.scale} 0 0 ${mapTransform.scale} ${mapTransform.translateX} ${mapTransform.translateY})`
  const markerCounterScale = String(1 / mapTransform.scale)

  const selectPlane = useCallback((planeHex) => {
    setSelectedPlaneHex(planeHex)
  }, [])

  const showPlane = useCallback((planeHex) => {
    setHoveredPlaneHex(planeHex)
  }, [])

  const hidePlane = useCallback((planeHex) => {
    setHoveredPlaneHex((currentHex) => (currentHex === planeHex ? null : currentHex))
  }, [])

  function getSvgPoint(event) {
    const svg = svgRef.current
    const screenMatrix = svg?.getScreenCTM()
    if (!svg || !screenMatrix) {
      return null
    }

    const point = svg.createSVGPoint()
    point.x = event.clientX
    point.y = event.clientY
    return point.matrixTransform(screenMatrix.inverse())
  }

  function getVisibleAircraftCentroid() {
    const visiblePoints = []

    for (const marker of projectedAircraft) {
      const viewportX = mapTransform.scale * marker.x + mapTransform.translateX
      const viewportY = mapTransform.scale * marker.y + mapTransform.translateY

      if (viewportX < 0 || viewportX > MAP_WIDTH || viewportY < 0 || viewportY > MAP_HEIGHT) {
        continue
      }

      visiblePoints.push(marker)
    }

    if (!visiblePoints.length) {
      return null
    }

    return {
      x: visiblePoints.reduce((total, point) => total + point.x, 0) / visiblePoints.length,
      y: visiblePoints.reduce((total, point) => total + point.y, 0) / visiblePoints.length,
    }
  }

  function zoomMap(factor) {
    setMapTransform((currentTransform) => {
      const nextScale = clamp(currentTransform.scale * factor, MAP_MIN_ZOOM, MAP_MAX_ZOOM)
      const scaleRatio = nextScale / currentTransform.scale
      const centerX = MAP_WIDTH / 2
      const centerY = MAP_HEIGHT / 2

      return constrainMapTransform({
        scale: nextScale,
        translateX: centerX - scaleRatio * (centerX - currentTransform.translateX),
        translateY: centerY - scaleRatio * (centerY - currentTransform.translateY),
      })
    })
  }

  function zoomToVisibleAircraftCentroid(factor) {
    const centroid = getVisibleAircraftCentroid()
    if (!centroid) {
      zoomMap(factor)
      return
    }

    setMapTransform((currentTransform) => {
      const nextScale = clamp(currentTransform.scale * factor, MAP_MIN_ZOOM, MAP_MAX_ZOOM)

      return constrainMapTransform({
        scale: nextScale,
        translateX: MAP_WIDTH / 2 - nextScale * centroid.x,
        translateY: MAP_HEIGHT / 2 - nextScale * centroid.y,
      })
    })
  }

  function panMap(deltaX, deltaY) {
    setMapTransform((currentTransform) =>
      constrainMapTransform({
        ...currentTransform,
        translateX: currentTransform.translateX + deltaX,
        translateY: currentTransform.translateY + deltaY,
      }),
    )
  }

  function handleMapPointerDown(event) {
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return
    }

    event.preventDefault()
    clearCurrentTextSelection()

    const point = getSvgPoint(event)
    if (!point) {
      return
    }

    const markerElement = event.target.closest?.('.map-marker')

    panStateRef.current = {
      pointerId: event.pointerId,
      lastX: point.x,
      lastY: point.y,
      moved: false,
      markerHex: markerElement?.dataset?.planeHex || null,
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  function handleMapPointerMove(event) {
    const panState = panStateRef.current
    if (!panState || panState.pointerId !== event.pointerId) {
      return
    }

    const point = getSvgPoint(event)
    if (!point) {
      return
    }

    event.preventDefault()

    const deltaX = point.x - panState.lastX
    const deltaY = point.y - panState.lastY
    panState.lastX = point.x
    panState.lastY = point.y

    if (Math.abs(deltaX) > 0.25 || Math.abs(deltaY) > 0.25) {
      panState.moved = true
      clearCurrentTextSelection()
    }

    panMap(deltaX, deltaY)
  }

  function handleMapPointerUp(event) {
    const panState = panStateRef.current
    if (!panState || panState.pointerId !== event.pointerId) {
      return
    }

    event.currentTarget.releasePointerCapture?.(event.pointerId)
    panStateRef.current = null
    clearCurrentTextSelection()

    if (!panState.moved && panState.markerHex) {
      selectPlane(panState.markerHex)
    }
  }

  function handleMapPointerCancel(event) {
    const panState = panStateRef.current
    if (!panState || panState.pointerId !== event.pointerId) {
      return
    }

    event.currentTarget.releasePointerCapture?.(event.pointerId)
    panStateRef.current = null
    clearCurrentTextSelection()
  }

  return (
    <section className="panel map-panel">
      <div className="panel-header">
        <div><h2>Realtime Tracker</h2></div>
      </div>

      <div className="map-frame">
        <div className="map-controls" aria-label="Map controls">
          <button type="button" className="map-control-button map-zoom-button" onClick={() => zoomToVisibleAircraftCentroid(MAP_ZOOM_STEP)} aria-label="Zoom in">
            <span className="map-zoom-icon map-zoom-plus" aria-hidden="true" />
          </button>
          <button type="button" className="map-control-button map-zoom-button" onClick={() => zoomMap(1 / MAP_ZOOM_STEP)} aria-label="Zoom out">
            <span className="map-zoom-icon map-zoom-minus" aria-hidden="true" />
          </button>
        </div>
        {displayedPlane ? (
          <div className="map-hover-card map-hover-card-active">
            <>
              <div className="map-hover-header">
                <strong>{displayedPlane.label || displayedPlane.registration || displayedPlane.hex?.toUpperCase()}</strong>
                <span>{displayedPlane.registration || displayedPlane.hex?.toUpperCase() || 'Unknown aircraft'}</span>
              </div>
              <dl className="map-hover-grid">
                <div>
                  <dt>Last seen</dt>
                  <dd>{formatTimestamp(displayedPlane.observed_at)}</dd>
                </div>
                <div>
                  <dt>Altitude</dt>
                  <dd>{formatAltitude(displayedPlane.altitudeFt)}</dd>
                </div>
                <div>
                  <dt>Speed</dt>
                  <dd>{formatSpeed(displayedPlane.groundSpeedKt)}</dd>
                </div>
                <div className="map-hover-coordinates">
                  <dt>Coordinates</dt>
                  <dd>{formatCoordinates(displayedPlane.lat, displayedPlane.lon)}</dd>
                </div>
              </dl>
            </>
          </div>
        ) : null}
        <svg
          ref={svgRef}
          viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
          className={`map-svg${isNarrowLayout ? ' map-svg-narrow' : ''}`}
          draggable={false}
          role="img"
          aria-label="Current aircraft positions"
          onPointerDown={handleMapPointerDown}
          onPointerMove={handleMapPointerMove}
          onPointerUp={handleMapPointerUp}
          onPointerCancel={handleMapPointerCancel}
        >
          <g className="map-viewport" transform={mapTransformValue} style={{ '--map-marker-scale': markerCounterScale }}>
            <MapBaseLayer
              geographyPaths={geographyPaths}
              graticulePath={graticulePath}
              isNarrowLayout={isNarrowLayout}
            />
            <MapMarkerLayer
              isNarrowLayout={isNarrowLayout}
              markerHaloRadius={markerHaloRadius}
              markerHitRadius={markerHitRadius}
              markerIconScale={markerIconScale}
              markers={projectedAircraft}
              onMarkerActivate={selectPlane}
              onMarkerHoverEnd={hidePlane}
              onMarkerHoverStart={showPlane}
              selectedPlaneHex={selectedPlaneHex}
            />
          </g>
        </svg>
      </div>
    </section>
  )
}

function ExternalLinkIcon() {
  return (
    <svg className="model-external-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M6 4H3.5A1.5 1.5 0 0 0 2 5.5v7A1.5 1.5 0 0 0 3.5 14h7a1.5 1.5 0 0 0 1.5-1.5V10" />
      <path d="M9 2h5v5" />
      <path d="M8 8 14 2" />
    </svg>
  )
}

function AirplaneIcon({ className }) {
  return (
    <svg className={className} viewBox="-10 -10 20 20" aria-hidden="true" focusable="false">
      <path d={AIRCRAFT_MARKER_PATH} transform="rotate(90)" />
    </svg>
  )
}

function PersonIcon({ className = 'model-person-icon' }) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="4.5" r="2.4" />
      <path d="M3.8 14c.35-3 1.75-4.6 4.2-4.6s3.85 1.6 4.2 4.6" />
    </svg>
  )
}

function ModelSummaryList({ aircraft }) {
  const modelSummary = buildLiveModelSummary(aircraft)

  return (
    <section className="panel list-panel">
      <div className="panel-header">
        <div><h2>Aircraft By Model</h2></div>
        <span className="map-badge">{formatCount(modelSummary.length)} types</span>
      </div>
      {modelSummary.length ? (
        <ul className="flight-list model-list">
          {modelSummary.map((entry) => {
            const wikipediaUrl =
              entry.rank <= AIRCRAFT_MODEL_DETAIL_RANK_LIMIT ? getAircraftModelWikipediaUrl(entry.modelLabel) : null
            const maxPassengers =
              entry.rank <= AIRCRAFT_MODEL_DETAIL_RANK_LIMIT ? getAircraftModelMaxPassengers(entry.modelLabel) : null

            return (
              <li key={entry.modelLabel}>
                <div className="model-name-cell">
                  <div className="model-title-row">
                    {wikipediaUrl ? (
                      <a
                        className="model-wiki-link"
                        href={wikipediaUrl}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={`${entry.modelLabel} on Wikipedia`}
                      >
                        <strong>{entry.modelLabel}</strong>
                        <ExternalLinkIcon />
                      </a>
                    ) : (
                      <strong>{entry.modelLabel}</strong>
                    )}
                    {maxPassengers ? (
                      <span
                        className="model-passenger-label"
                        title={`Maximum passengers: ${maxPassengers}`}
                        aria-label={`Maximum passengers: ${maxPassengers}`}
                      >
                        <span>{maxPassengers}</span>
                        <PersonIcon />
                      </span>
                    ) : null}
                  </div>
                </div>
                <strong className="model-count">{formatCount(entry.count)}</strong>
              </li>
            )
          })}
        </ul>
      ) : (
        <div className="empty-state">
          No tracked aircraft are currently airborne in the latest cached heatmap.
        </div>
      )}
    </section>
  )
}

function AboutSystemCard({ cohort }) {
  const isGlobalCohort = cohort?.source === 'global_business_jet' || Number(cohort?.globalCount || 0) > 0

  return (
    <section className="panel about-panel">
      <div className="panel-header">
        <div><h2>How This Works</h2></div>
      </div>
      <div className="about-copy">
        <p>
          This site watches a fixed cohort of business jets and asks a simple question: is the number currently airborne
          unusual for this time? It is not tracking all aircraft. The tracked set is built from{' '}
          {isGlobalCohort ? (
            <>
              public global aircraft metadata, ADS-B Exchange lookups, Mictronics/tar1090 records, and{' '}
              <a
                href="https://www.faa.gov/licenses_certificates/aircraft_certification/aircraft_registry/releasable_aircraft_download"
                target="_blank"
                rel="noreferrer"
              >
                FAA registry data
              </a>
            </>
          ) : (
            <a
              href="https://www.faa.gov/licenses_certificates/aircraft_certification/aircraft_registry/releasable_aircraft_download"
              target="_blank"
              rel="noreferrer"
            >
              FAA registry data
            </a>
          )}{' '}
          with a practical business-jet filter, and each aircraft is matched by its{' '}
          <a
            href="https://en.wikipedia.org/wiki/Aviation_transponder_interrogation_modes#ICAO_24-bit_address"
            target="_blank"
            rel="noreferrer"
          >
            ICAO hex identifier
          </a>
          .
        </p>
        <p>
          The flight data comes from{' '}
          <a href="https://www.adsbexchange.com/" target="_blank" rel="noreferrer">
            ADS-B Exchange
          </a>{' '}
          heatmap files. Those files are published in half-hour slots and encode recent aircraft positions. The backend
          downloads the newest available heatmap, parses it, matches the aircraft in the heatmap against the tracked
          cohort, and stores the latest position, altitude, speed, heading, and airborne state for each match.
        </p>
        <p>
          Historical context comes from the same heatmap format. The backfill job walks through previous half-hour slots,
          counts how many tracked aircraft were airborne, and records those counts in SQLite. The dashboard then compares
          the current concurrent airborne count with a recent baseline for similar times of day and week.
        </p>
        <p>
          The deviation number is the current count minus the expected count. The sigma value puts that difference on the
          scale of recent model error, so a small positive count can matter more when the baseline is normally stable, and
          a larger count can matter less when that time slot is usually noisy. The emergency level is a compact display of
          that same standardized signal.
        </p>
        <p>
          The max-people estimate is intentionally rough. It maps known aircraft model labels to published maximum
          passenger capacities, sums the known matches, and scales missing capacities by the known average. It is a maximum
          seat estimate, not a passenger manifest.
        </p>
        <p>
          There are important limits. ADS-B coverage can be incomplete, aircraft may be blocked or misidentified, heatmaps
          arrive in coarse half-hour windows, and the {isGlobalCohort ? 'global' : 'FAA-derived'} cohort is a heuristic
          rather than a perfect definition of every relevant private jet. The dashboard is best read as an anomaly monitor
          for public flight signals, not as proof of intent, destination, ownership activity, or who is on board.
        </p>
        <p className="about-credit">
          Built by{' '}
          <a href="https://www.instagram.com/kcimc/" target="_blank" rel="noreferrer">
            Kyle McDonald
          </a>{' '}
          /{' '}
          <a href="https://kylemcdonald.net/" target="_blank" rel="noreferrer">
            kylemcdonald.net
          </a>
          .
        </p>
      </div>
    </section>
  )
}

function LoadingAnimation() {
  return (
    <main className="loading-screen" aria-label="Loading">
      <video
        className="loading-animation"
        src={LOADING_ANIMATION_URL}
        autoPlay
        loop
        muted
        playsInline
        preload="auto"
        aria-hidden="true"
      />
    </main>
  )
}

function DashboardApp({ dashboardUrl = DASHBOARD_URL }) {
  const [dashboard, setDashboard] = useState(null)
  const [error, setError] = useState(null)
  const [backgroundReady, setBackgroundReady] = useState(false)
  const [manualEmergencySchemeEnabled, setManualEmergencySchemeEnabled] = useState(false)
  const emergencySchemeTapTimesRef = useRef([])

  const applyDashboard = useEffectEvent((nextDashboard) => {
    startTransition(() => {
      setDashboard(nextDashboard)
      setError(null)
    })
  })

  function handleEmergencyLevelTap() {
    const now = window.performance?.now ? window.performance.now() : Date.now()
    const recentTapTimes = emergencySchemeTapTimesRef.current.filter(
      (tapTime) => now - tapTime <= EMERGENCY_SCHEME_TAP_WINDOW_MS,
    )

    recentTapTimes.push(now)

    if (recentTapTimes.length >= 3) {
      emergencySchemeTapTimesRef.current = []
      setManualEmergencySchemeEnabled((enabled) => !enabled)
      return
    }

    emergencySchemeTapTimesRef.current = recentTapTimes
  }

  useEffect(() => {
    let active = true
    const backgroundPreload = document.getElementById(BACKGROUND_PRELOAD_LINK_ID)
    const backgroundHref = new URL(BACKGROUND_URL, window.location.href).href

    function markBackgroundReady() {
      if (active) {
        setBackgroundReady(true)
      }
    }

    if (window.performance?.getEntriesByName(backgroundHref).some((entry) => entry.responseEnd > 0)) {
      markBackgroundReady()
    } else if (backgroundPreload) {
      backgroundPreload.addEventListener('load', markBackgroundReady)
      backgroundPreload.addEventListener('error', markBackgroundReady)
    } else {
      markBackgroundReady()
    }

    async function loadDashboard() {
      try {
        const response = await fetch(buildDashboardRequestUrl(dashboardUrl), {
          cache: 'no-store',
        })
        if (!response.ok) {
          throw new Error(`Dashboard request failed with ${response.status}`)
        }

        const nextDashboard = await response.json()
        if (active) {
          applyDashboard(nextDashboard)
        }
      } catch (nextError) {
        if (active) {
          setError(nextError.message)
        }
      }
    }

    loadDashboard()
    const intervalId = window.setInterval(loadDashboard, DASHBOARD_POLL_INTERVAL_MS)

    return () => {
      active = false
      backgroundPreload?.removeEventListener('load', markBackgroundReady)
      backgroundPreload?.removeEventListener('error', markBackgroundReady)
      window.clearInterval(intervalId)
    }
  }, [dashboardUrl])

  const shouldShowLoading = !dashboard || !backgroundReady

  useEffect(() => {
    if (shouldShowLoading && !(error && !dashboard)) {
      return undefined
    }

    const initialLoader = document.getElementById('initial-loader')
    document.documentElement.classList.remove('initial-loading')

    if (!initialLoader) {
      return undefined
    }

    initialLoader.classList.add('initial-loader-hidden')
    const removalTimer = window.setTimeout(() => {
      initialLoader.remove()
    }, 140)

    return () => {
      window.clearTimeout(removalTimer)
    }
  }, [dashboard, error, shouldShowLoading])

  const currentSignal = dashboard?.signals?.composite ?? dashboard?.current ?? null
  const currentEmergencyLevel = getEmergencyLevel(currentSignal)
  const emergencySchemeActive = manualEmergencySchemeEnabled || currentEmergencyLevel === EMERGENCY_LEVEL_COUNT

  useEffect(() => {
    document.documentElement.classList.toggle('emergency-color-scheme', emergencySchemeActive)

    return () => {
      document.documentElement.classList.remove('emergency-color-scheme')
    }
  }, [emergencySchemeActive])

  let content = null

  if (error && !dashboard) {
    content = (
      <main className="app-shell">
        <section className="panel error-panel">
          <h1>Data Unavailable</h1>
          <p>{error}</p>
        </section>
      </main>
    )
  } else if (shouldShowLoading) {
    content = document.getElementById('initial-loader') ? null : <LoadingAnimation />
  } else {
    const archiveData = dashboard.trends?.archive ?? []
    const liveAircraft = dashboard.liveAircraft ?? []
    const liveStatus = dashboard.liveStatus ?? null
    const compositeSignal = dashboard.signals?.composite ?? {
      asOf: dashboard.current?.asOf,
      actualConcurrentCount: dashboard.current?.concurrentCount,
      expectedConcurrentCount: dashboard.current?.baselineMean,
      expectedConcurrentStdDev: dashboard.current?.baselineStdDev,
      sigmaShift: dashboard.current?.zScore,
      alertLevel: dashboard.current?.alertLevel,
      emergencyLevel: dashboard.current?.emergencyLevel,
    }
    const maxSeatsAirborneEstimate = estimateMaxSeatsAirborne(liveAircraft, compositeSignal.actualConcurrentCount)

    content = (
      <main className="app-shell">
        {dashboard.warning ? (
          <section className="status-banner">
            <strong>{dashboard.mode === 'demo' ? 'Demo mode.' : 'Configuration required.'}</strong>
            <span>{dashboard.warning}</span>
          </section>
        ) : null}

        {!dashboard.warning && !liveStatus?.latestSampledAt ? (
          <section className="status-banner">
            <strong>No recent sweep.</strong>
            <span>The backend polls the newest heatmap every 30 minutes and serves the latest cached sample.</span>
          </section>
        ) : null}

        {liveStatus?.lastError ? (
          <section className="status-banner">
            <strong>Refresh error.</strong>
            <span>
              {liveStatus.lastError}
              {liveStatus.nextRefreshAt ? ` Next sweep: ${formatTimestamp(liveStatus.nextRefreshAt)}.` : ''}
            </span>
          </section>
        ) : null}

        <section className="focus-grid">
          <section className="panel hero-copy-panel">
            <h1>Apocalypse Early Warning System</h1>
            <p className="hero-caption">
              In the event of an imminent nuclear apocalypse, we suspect that many people who have access to private jets
              will immediately take to the skies and escape city centers. This site tracks this indicator in realtime.
              The current emergency level is reported on a scale of 1 to 5, with 5 being an indicator of a likely
              imminent apocalypse.
            </p>
            <p className="hero-credit">
              built by{' '}
              <a href="https://www.instagram.com/kcimc/" target="_blank" rel="noreferrer">
                Kyle McDonald
              </a>{' '}
              /{' '}
              <a href="https://github.com/kylemcdonald/ews" target="_blank" rel="noreferrer">
                GitHub
              </a>{' '}
              /{' '}
              <a href="https://t.me/apocalypse_ews" target="_blank" rel="noreferrer">
                Telegram Notifications
              </a>{' '}
              /{' '}
              <a href="https://ews.kylemcdonald.net/rss.xml" target="_blank" rel="noreferrer">
                RSS
              </a>
            </p>
          </section>
          <div className="dial-stack">
            <EmergencySummary
              signal={compositeSignal}
              latestSweep={formatTimestamp(dashboard.current?.asOf)}
              actualCount={compositeSignal.actualConcurrentCount}
              expectedCount={compositeSignal.expectedConcurrentCount}
              trackedCount={dashboard.cohort?.trackedCount ?? dashboard.watchlist?.trackedCount}
              maxSeatsAirborneEstimate={maxSeatsAirborneEstimate}
              onEmergencyLevelTap={handleEmergencyLevelTap}
            />
          </div>
        </section>

        <section className="focus-map-grid">
          <GlobalMap aircraft={liveAircraft} />
        </section>

        <section className="details-stack">
          <ArchiveChart data={archiveData} signal={compositeSignal} />
          <ModelSummaryList aircraft={liveAircraft} />
          <AboutSystemCard cohort={dashboard.cohort} />
        </section>
      </main>
    )
  }

  return (
    <>
      <div className="background-wallpaper" style={{ backgroundImage: `url("${BACKGROUND_URL}")` }} aria-hidden="true" />
      {content}
    </>
  )
}

function App() {
  if (window.location.pathname === '/beta' || window.location.pathname.startsWith('/beta/')) {
    return <DashboardApp dashboardUrl={BETA_DASHBOARD_URL} />
  }

  return <DashboardApp />
}

export default App
