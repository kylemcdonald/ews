import { Suspense, lazy, startTransition, useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { parsePhoneNumberFromString } from 'libphonenumber-js/min'
import proj4 from 'proj4'
import './App.css'

const EventSignalExplainer = lazy(() => import('./EventSignalExplainer.jsx'))

const PUBLIC_DASHBOARD_BASE_URL = 'https://pub-49bb6a6f314c47be9b481c25e5f6ca9e.r2.dev'
const DASHBOARD_URL = import.meta.env.VITE_DASHBOARD_URL || `${PUBLIC_DASHBOARD_BASE_URL}/dashboard.json`
const MILITARY_DASHBOARD_URL = import.meta.env.VITE_MILITARY_DASHBOARD_URL || `${PUBLIC_DASHBOARD_BASE_URL}/military-dashboard.json`
const UNTRACKED_DASHBOARD_URL = import.meta.env.VITE_UNTRACKED_DASHBOARD_URL || `${PUBLIC_DASHBOARD_BASE_URL}/untracked-dashboard.json`
const DISCORD_BOT_URL = 'https://jamiew.github.io/apocalypse-ews-discord/'
const COHORT_CONFIGS = [
  { id: 'business', label: 'Business jets', dashboardUrl: DASHBOARD_URL },
  { id: 'military', label: 'Military', dashboardUrl: MILITARY_DASHBOARD_URL },
  { id: 'untracked', label: 'Untracked', dashboardUrl: UNTRACKED_DASHBOARD_URL },
]
const COHORT_LOADING_DELAY_MS = 1000
const DASHBOARD_CACHE_BUSTER_MINUTES = 5
const DASHBOARD_POLL_INTERVAL_MS = 5 * 60_000
const DASHBOARD_JSON_CONTENT_TYPE_PATTERN = /\b(?:application\/json|[\w.+-]+\/[\w.+-]+\+json)\b/i
const AIRCRAFT_MARKER_PATH = 'M0 -9 L2.2 -1.5 L8 1.2 L8 3.4 L1.8 2.1 L1.8 6.4 L4.2 8 L4.2 9 L0 7.5 L-4.2 9 L-4.2 8 L-1.8 6.4 L-1.8 2.1 L-8 3.4 L-8 1.2 L-2.2 -1.5 Z'
const ARCHIVE_DAY_MS = 24 * 60 * 60 * 1000
const ADSB_DATA_UNAVAILABLE_THRESHOLD_MS = ARCHIVE_DAY_MS

const NARROW_HISTORY_BREAKPOINT = 820
const CHART_TICK_COLOR = '#000000'
const CHART_GRID_COLOR = '#d4d4d4'
const CHART_PRIMARY_COLOR = '#0000ee'
const CHART_PREDICTION_BAND_FILL = 'rgba(128, 128, 128, 0.18)'
const CHART_HOLIDAY_REGION_FILL = 'rgba(255, 196, 0, 0.16)'
const CHART_HOLIDAY_REGION_STROKE = 'rgba(160, 112, 0, 0.34)'
const CONCURRENT_WEEKLY_BASELINE_MODEL = 'all-history-weekly-baseline'
const CONCURRENT_WEEKLY_DAY_RATIO_MODEL = 'weekly-baseline-prior-year-day-ratio'
const CONCURRENT_WEEKLY_US_HOLIDAY_MODEL = 'weekly-baseline-us-holiday-adjusted'
const PREDICTION_BAND_MODELS = new Set([
  CONCURRENT_WEEKLY_BASELINE_MODEL,
  CONCURRENT_WEEKLY_DAY_RATIO_MODEL,
  CONCURRENT_WEEKLY_US_HOLIDAY_MODEL,
])
const LOADING_ANIMATION_URL = '/animation.mp4'
const BACKGROUND_URL = '/backgrounds/soft-cartoon-tile-15.webp'
const BACKGROUND_PRELOAD_LINK_ID = 'background-preload'
const SUBSCRIBERS_PER_PAGE = 20
const SUBSCRIPTION_GROSS_DOLLARS = 5
const MESSAGE_HISTORY_POLL_INTERVAL_MS = 15_000
const ADMIN_REPLY_MAX_LENGTH = 1600
const PHONE_VALIDATION_MESSAGE = 'Enter a valid phone number. Use 10 digits for US/Canada, or + and country code for international numbers.'
const NON_US_CANADA_PHONE_WARNING = 'We do not currently support non-US/Canada phone numbers, continue anyway?'
const SUPPORTED_SMS_COUNTRY_CODES = new Set(['US', 'CA'])
const ARCHIVE_CHART_WIDTH = 960
const ARCHIVE_CHART_MOBILE_WIDTH = 440
const ARCHIVE_CHART_HEIGHT = 320
const ARCHIVE_DIVERGENCE_HEIGHT = 180
const ARCHIVE_CHART_MARGIN = { top: 16, right: 18, bottom: 28, left: 44 }
const ARCHIVE_CHART_MOBILE_MARGIN = { top: 18, right: 16, bottom: 42, left: 54 }
const MAPLIBRE_ZOOM_STEP = Math.log2(1.45)
const MAPLIBRE_MAX_ZOOM_DELTA = 4
const MAPLIBRE_ZOOM_EPSILON = 0.01
const MAPLIBRE_AIRCRAFT_SOURCE_ID = 'aircraft'
const MAPLIBRE_AIRCRAFT_HALO_LAYER_ID = 'aircraft-halo'
const MAPLIBRE_AIRCRAFT_ICON_LAYER_ID = 'aircraft-icons'
const MAPLIBRE_WORLD_BOUNDS = [[-180, -65.542], [180, 65.542]]
const MAPLIBRE_CONUS_GEOGRAPHIC_BOUNDS = [[-124.85, 24.4], [-66.9, 49.6]]
const MAPLIBRE_WORLD_FIT_PADDING = 12
const MAPLIBRE_EQUAL_EARTH_GRID_FACTOR = 20037508.3427892 / 17243959.06
const MAPLIBRE_EQUAL_EARTH_PATCH_BASE_URL = 'https://cdn.jsdelivr.net/gh/kylemcdonald/equal-earth-web-mapping@c78a447adc643a4ecada3049f8fe6a92c00c88a9/static/map-patches'
const EMERGENCY_LEVEL_COUNT = 5
const EMERGENCY_SCHEME_TAP_WINDOW_MS = 700
const MIN_ALARM_SIGMA_THRESHOLD = 4
const DEFAULT_ALARM_SIGMA_THRESHOLD = 7
const AIRCRAFT_MODEL_DETAIL_RANK_LIMIT = 40
const AIRCRAFT_MODEL_WIKIPEDIA_URLS = new Map([
  ['BOMBARDIER AEROSPACE INC BD-100-1A10', 'https://en.wikipedia.org/wiki/Bombardier_Challenger_300'],
  ['BOMBARDIER BD-100 CHALLENGER 350', 'https://en.wikipedia.org/wiki/Bombardier_Challenger_300'],
  ['BOMBARDIER INC BD-100-1A10', 'https://en.wikipedia.org/wiki/Bombardier_Challenger_300'],
  ['EMBRAER EXECUTIVE AIRCRAFT INC EMB-505', 'https://en.wikipedia.org/wiki/Embraer_Phenom_300'],
  ['EMBRAER EMB-505 PHENOM 300', 'https://en.wikipedia.org/wiki/Embraer_Phenom_300'],
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
  ['RAYTHEON AIRCRAFT COMPANY HAWKER 850XP', 'https://en.wikipedia.org/wiki/Hawker_800'],
  ['CESSNA 510', 'https://en.wikipedia.org/wiki/Cessna_Citation_Mustang'],
  ['CESSNA 550', 'https://en.wikipedia.org/wiki/Cessna_Citation_II'],
  ['CESSNA S550', 'https://en.wikipedia.org/wiki/Cessna_Citation_II'],
  ['DASSAULT AVIATION FALCON 2000EX', 'https://en.wikipedia.org/wiki/Dassault_Falcon_2000'],
  ['CESSNA 650', 'https://en.wikipedia.org/wiki/Cessna_Citation_III'],
  ['RAYTHEON AIRCRAFT COMPANY 400A', 'https://en.wikipedia.org/wiki/Hawker_400'],
  ['PILATUS AIRCRAFT LTD PC-24', 'https://en.wikipedia.org/wiki/Pilatus_PC-24'],
  ['PILATUS PC-24', 'https://en.wikipedia.org/wiki/Pilatus_PC-24'],
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
  ['BEECH 400A', 'https://en.wikipedia.org/wiki/Hawker_400'],
  ['BOMBARDIER BD-700 GLOBAL 6000/6500', 'https://en.wikipedia.org/wiki/Bombardier_Global_Express'],
  ['BOMBARDIER BD-700 GLOBAL 7000/7500', 'https://en.wikipedia.org/wiki/Bombardier_Global_7500'],
  ['BOMBARDIER CL-600 CHALLENGER', 'https://en.wikipedia.org/wiki/Bombardier_Challenger_600_series'],
  ['BOMBARDIER INC BD-700-1A10', 'https://en.wikipedia.org/wiki/Bombardier_Global_Express'],
  ['BOMBARDIER INC BD-700-1A11', 'https://en.wikipedia.org/wiki/Bombardier_Global_Express'],
  ['BOMBARDIER INC BD-700-2A12', 'https://en.wikipedia.org/wiki/Bombardier_Global_7500'],
  ['BOMBARDIER INC CL-600-2B16', 'https://en.wikipedia.org/wiki/Bombardier_Challenger_600_series'],
  ['BOMBARDIER INC. CL-600-2B16 (SERIES 604)', 'https://en.wikipedia.org/wiki/Bombardier_Challenger_600_series'],
  ['CANADAIR LTD CL-600-2B16', 'https://en.wikipedia.org/wiki/Bombardier_Challenger_600_series'],
  ['CESSNA 525B CITATION CJ3', 'https://en.wikipedia.org/wiki/Cessna_CitationJet/M2'],
  ['CESSNA 525C', 'https://en.wikipedia.org/wiki/Cessna_CitationJet/M2'],
  ['CESSNA 680 CITATION LATITUDE', 'https://en.wikipedia.org/wiki/Cessna_Citation_Latitude'],
  ['CESSNA 750', 'https://en.wikipedia.org/wiki/Cessna_Citation_X'],
  ['CIRRUS DESIGN CORP SF50', 'https://en.wikipedia.org/wiki/Cirrus_Vision_SF50'],
  ['DASSAULT AVIATION FALCON 900EX', 'https://en.wikipedia.org/wiki/Dassault_Falcon_900'],
  ['EMBRAER EMB-145XR', 'https://en.wikipedia.org/wiki/Embraer_ERJ_family'],
  ['EMBRAER EMB545 PRAETOR 500', 'https://en.wikipedia.org/wiki/Embraer_Praetor_500/600'],
  ['EMBRAER PHENOM', 'https://en.wikipedia.org/wiki/Embraer_Phenom_300'],
  ['EMBRAER S A EMB-505', 'https://en.wikipedia.org/wiki/Embraer_Phenom_300'],
  ['EMBRAER S A EMB-545', 'https://en.wikipedia.org/wiki/Embraer_Praetor_500/600'],
  ['EMBRAER SA EMB-550', 'https://en.wikipedia.org/wiki/Embraer_Praetor_500/600'],
  ['EMBRAER-EMPRESA BRASILEIRA DE EMB-500', 'https://en.wikipedia.org/wiki/Embraer_Phenom_100'],
  ['GULFSTREAM AEROSPACE CORP GVI (G650)', 'https://en.wikipedia.org/wiki/Gulfstream_G650/G700/G800'],
  ['GULFSTREAM AEROSPACE CORP GVI (G650ER)', 'https://en.wikipedia.org/wiki/Gulfstream_G650/G700/G800'],
  ['GULFSTREAM AEROSPACE CORP GVII-G500', 'https://en.wikipedia.org/wiki/Gulfstream_G500/G600'],
  ['GULFSTREAM AEROSPACE G-IV', 'https://en.wikipedia.org/wiki/Gulfstream_IV'],
  ['GULFSTREAM AEROSPACE GIV-X (G450)', 'https://en.wikipedia.org/wiki/Gulfstream_IV'],
  ['GULFSTREAM G650', 'https://en.wikipedia.org/wiki/Gulfstream_G650/G700/G800'],
  ['IAI LTD GULFSTREAM G280', 'https://en.wikipedia.org/wiki/Gulfstream_G280'],
  ['ISRAEL AIRCRAFT INDUSTRIES ASTRA SPX', 'https://en.wikipedia.org/wiki/Gulfstream_G100'],
  ['ISRAEL AIRCRAFT INDUSTRIES GULFSTREAM 200', 'https://en.wikipedia.org/wiki/Gulfstream_G200'],
  ['TEXTRON AVIATION INC 680', 'https://en.wikipedia.org/wiki/Cessna_Citation_Sovereign'],
  ['TEXTRON AVIATION INC 700', 'https://en.wikipedia.org/wiki/Cessna_Citation_Longitude'],
  ['TEXTRON AVIATION INC. 525B', 'https://en.wikipedia.org/wiki/Cessna_CitationJet/M2'],
  ['AERMACCHI M-346 MASTER', 'https://en.wikipedia.org/wiki/Alenia_Aermacchi_M-346_Master'],
  ['ALENIA AERMACCHI M-346 MASTER', 'https://en.wikipedia.org/wiki/Alenia_Aermacchi_M-346_Master'],
  ['BEECH C-12R HURON', 'https://en.wikipedia.org/wiki/Beechcraft_C-12_Huron'],
  ['BEECH C-12V HURON', 'https://en.wikipedia.org/wiki/Beechcraft_C-12_Huron'],
  ['BEECH T-44A PEGASUS', 'https://en.wikipedia.org/wiki/Beechcraft_King_Air#T-44_Pegasus'],
  ['BELL-BOEING V-22 OSPREY', 'https://en.wikipedia.org/wiki/Bell_Boeing_V-22_Osprey'],
  ['BOEING C-17A GLOBEMASTER III', 'https://en.wikipedia.org/wiki/Boeing_C-17_Globemaster_III'],
  ['BOEING-VERTOL CH-47 CHINOOK', 'https://en.wikipedia.org/wiki/Boeing_CH-47_Chinook'],
  ['BRITISH AEROSPACE T-45 GOSHAWK', 'https://en.wikipedia.org/wiki/McDonnell_Douglas_T-45_Goshawk'],
  ['EMBRAER EMB-312 TUCANO', 'https://en.wikipedia.org/wiki/Embraer_EMB_312_Tucano'],
  ['EUROCOPTER UH-72A LAKOTA', 'https://en.wikipedia.org/wiki/Eurocopter_UH-72_Lakota'],
  ['LOCKHEED C-130H HERCULES', 'https://en.wikipedia.org/wiki/Lockheed_C-130_Hercules'],
  ['MCDONNELL DOUGLAS AH-64 APACHE', 'https://en.wikipedia.org/wiki/Boeing_AH-64_Apache'],
  ['MCDONNELL DOUGLAS C-17A GLOBEMASTER III', 'https://en.wikipedia.org/wiki/Boeing_C-17_Globemaster_III'],
  ['NORTHROP T-38C TALON', 'https://en.wikipedia.org/wiki/Northrop_T-38_Talon'],
  ['RAYTHEON CT-156 HARVARD II', 'https://en.wikipedia.org/wiki/Beechcraft_T-6_Texan_II'],
  ['RAYTHEON T-6A TEXAN II', 'https://en.wikipedia.org/wiki/Beechcraft_T-6_Texan_II'],
  ['RAYTHEON T-6B TEXAN II', 'https://en.wikipedia.org/wiki/Beechcraft_T-6_Texan_II'],
  ['SIKORSKY MH-60R SEAHAWK', 'https://en.wikipedia.org/wiki/Sikorsky_SH-60_Seahawk'],
  ['SIKORSKY UH-60 BLACK HAWK', 'https://en.wikipedia.org/wiki/Sikorsky_UH-60_Black_Hawk'],
  ['SIKORSKY UH-60M BLACK HAWK', 'https://en.wikipedia.org/wiki/Sikorsky_UH-60_Black_Hawk'],
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
  ['BEECH 400A', 9],
  ['BOMBARDIER BD-700 GLOBAL 6000/6500', 19],
  ['BOMBARDIER BD-700 GLOBAL 7000/7500', 19],
  ['BOMBARDIER CL-600 CHALLENGER', 14],
  ['BOMBARDIER INC BD-700-1A10', 19],
  ['BOMBARDIER INC BD-700-1A11', 19],
  ['BOMBARDIER INC BD-700-2A12', 19],
  ['BOMBARDIER INC CL-600-2B16', 12],
  ['BOMBARDIER INC. CL-600-2B16 (SERIES 604)', 12],
  ['CANADAIR LTD CL-600-2B16', 12],
  ['CESSNA 525B CITATION CJ3', 9],
  ['CESSNA 525C', 10],
  ['CESSNA 680 CITATION LATITUDE', 9],
  ['CESSNA 750', 12],
  ['CIRRUS DESIGN CORP SF50', 6],
  ['DASSAULT AVIATION FALCON 900EX', 19],
  ['EMBRAER EMB-145XR', 50],
  ['EMBRAER EMB545 PRAETOR 500', 9],
  ['EMBRAER PHENOM', 10],
  ['EMBRAER S A EMB-505', 10],
  ['EMBRAER S A EMB-545', 9],
  ['EMBRAER SA EMB-550', 12],
  ['EMBRAER-EMPRESA BRASILEIRA DE EMB-500', 7],
  ['GULFSTREAM AEROSPACE CORP GVI (G650)', 19],
  ['GULFSTREAM AEROSPACE CORP GVI (G650ER)', 19],
  ['GULFSTREAM AEROSPACE CORP GVII-G500', 19],
  ['GULFSTREAM AEROSPACE G-IV', 19],
  ['GULFSTREAM AEROSPACE GIV-X (G450)', 19],
  ['GULFSTREAM G650', 19],
  ['IAI LTD GULFSTREAM G280', 10],
  ['ISRAEL AIRCRAFT INDUSTRIES GULFSTREAM 200', 10],
  ['TEXTRON AVIATION INC 700', 12],
  ['TEXTRON AVIATION INC. 525B', 9],
])

function getPhoneCandidate(raw, digits, withPlus) {
  if (withPlus) {
    return `+${digits}`
  }

  if (digits.startsWith('00') && digits.length > 2) {
    return `+${digits.slice(2)}`
  }

  if (digits.length === 10) {
    return `+1${digits}`
  }

  if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`
  }

  throw new Error(PHONE_VALIDATION_MESSAGE)
}

function normalizePhoneInput(value) {
  const raw = String(value || '').trim()
  if (!raw) {
    return ''
  }

  const digits = raw.replace(/[^\d]/g, '')
  if (!digits) {
    throw new Error('Enter a valid phone number.')
  }

  const parsed = parsePhoneNumberFromString(getPhoneCandidate(raw, digits, raw.startsWith('+')))
  if (!parsed?.isValid()) {
    throw new Error(PHONE_VALIDATION_MESSAGE)
  }

  return parsed.number
}

function isSupportedSmsCountry(phone) {
  const parsed = parsePhoneNumberFromString(phone)
  return SUPPORTED_SMS_COUNTRY_CODES.has(parsed?.country)
}

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

function formatTimestamp(value, options = {}) {
  if (!value) {
    return 'No timestamp'
  }

  const roundedDate = roundDateToNearestHalfHour(value)
  if (!roundedDate) {
    return 'No timestamp'
  }

  return new Intl.DateTimeFormat('en-US', {
    ...(options.weekday ? { weekday: 'short' } : {}),
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

function getCohortKind(cohort) {
  if (cohort?.cohortType === 'combined' || cohort?.source === 'combined_selected_aircraft') {
    return 'combined'
  }

  if (cohort?.cohortType === 'military' || cohort?.source === 'global_military_aircraft') {
    return 'military'
  }

  if (cohort?.cohortType === 'non_icao' || cohort?.source === 'non_icao_untracked') {
    return 'untracked'
  }

  return 'business'
}

function getCohortCopy(cohort) {
  const kind = getCohortKind(cohort)
  if (kind === 'combined') {
    return {
      kind,
      trackedNoun: 'selected aircraft',
      trackedSingular: 'selected aircraft',
      trackedDescription: 'the currently selected aircraft categories',
      filterDescription: 'category-specific filters',
      sourceDescription: 'public aircraft metadata and ADS-B Exchange heatmaps',
      sourceShort: 'selected-category',
      modelSummaryTitle: 'Aircraft By Model',
      emptyLiveText: 'No identified selected aircraft are currently airborne in the latest cached heatmap.',
      showSeatEstimate: true,
      heroCaption: (
        <>
          In the event of an imminent nuclear apocalypse, we suspect that unusual aircraft activity may appear across
          multiple public flight signals. This view can combine business jets, military aircraft, and non-ICAO addresses
          while recalibrating the emergency level for the selected total.
        </>
      ),
    }
  }

  if (kind === 'military') {
    return {
      kind,
      trackedNoun: 'military aircraft',
      trackedSingular: 'military aircraft',
      trackedDescription: 'a fixed global cohort of military aircraft visible in public aircraft metadata',
      filterDescription: 'a public metadata military flag',
      sourceDescription: 'global public aircraft metadata, ADS-B Exchange lookups, and Mictronics/tar1090 records',
      sourceShort: 'global military',
      modelSummaryTitle: 'Aircraft By Model',
      emptyLiveText: 'No tracked military aircraft are currently airborne in the latest cached heatmap.',
      showSeatEstimate: false,
      heroCaption: (
        <>
          This view tracks military aircraft visible in public ADS-B Exchange data and asks whether the number currently
          airborne is unusual for the time of week and the U.S. holiday calendar. It uses the same anomaly model as the
          main dashboard, but with a military-aircraft cohort instead of business jets.
        </>
      ),
    }
  }

  if (kind === 'untracked') {
    return {
      kind,
      trackedNoun: 'non-ICAO aircraft',
      trackedSingular: 'non-ICAO aircraft',
      trackedDescription: 'all aircraft using readsb non-ICAO ~hex addresses in ADS-B Exchange heatmaps',
      filterDescription: 'the readsb non-ICAO address marker',
      sourceDescription: 'ADS-B Exchange heatmaps',
      sourceShort: 'non-ICAO',
      modelSummaryTitle: 'Aircraft By Identifier',
      emptyLiveText: 'No non-ICAO aircraft are currently airborne in the latest cached heatmap.',
      showSeatEstimate: false,
      heroCaption: (
        <>
          This view tracks aircraft using non-ICAO <code>~hex</code> addresses in public ADS-B Exchange heatmaps and asks
          whether that activity is unusual for the time of week and the U.S. holiday calendar. It is intended to surface
          address-use anomalies separately from the business-jet cohort.
        </>
      ),
    }
  }

  return {
    kind,
    trackedNoun: 'business jets',
    trackedSingular: 'business jet',
    trackedDescription: 'a fixed cohort of business jets',
    filterDescription: 'a practical business-jet filter',
    sourceDescription: 'public global aircraft metadata, ADS-B Exchange lookups, Mictronics/tar1090 records, and FAA registry data',
    sourceShort: Number(cohort?.globalCount || 0) > 0 ? 'global' : 'FAA-derived',
    modelSummaryTitle: 'Aircraft By Model',
    emptyLiveText: 'No tracked aircraft are currently airborne in the latest cached heatmap.',
    showSeatEstimate: true,
    heroCaption: (
      <>
        In the event of an imminent nuclear apocalypse, we suspect that many people who have access to private jets will
        immediately take to the skies and escape city centers. This site tracks this indicator in realtime. The current
        emergency level is reported on a scale of 1 to 5, with 5 being an indicator of a likely imminent apocalypse.
      </>
    ),
  }
}

function getAdsbDataUnavailableStatus(liveStatus) {
  const latestTimestamp = Date.parse(liveStatus?.latestSampledAt || 0)
  const ageMs = Date.now() - latestTimestamp
  const isStale = !Number.isFinite(latestTimestamp) || ageMs > ADSB_DATA_UNAVAILABLE_THRESHOLD_MS

  return {
    isUnavailable: isStale,
    isStale,
    ageMs: Number.isFinite(ageMs) ? ageMs : null,
  }
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

function quantile(values, percentile) {
  const finiteValues = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right)
  if (!finiteValues.length) {
    return null
  }

  const index = (finiteValues.length - 1) * percentile
  const lowerIndex = Math.floor(index)
  const upperIndex = Math.ceil(index)
  const fraction = index - lowerIndex
  return finiteValues[lowerIndex] + (finiteValues[upperIndex] - finiteValues[lowerIndex]) * fraction
}

function median(values) {
  return quantile(values, 0.5)
}

function clearCurrentTextSelection() {
  const selection = window.getSelection?.()
  if (selection?.rangeCount) {
    selection.removeAllRanges()
  }
}

function normalizeDegrees(value) {
  if (!Number.isFinite(value)) {
    return null
  }

  return ((value % 360) + 360) % 360
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

function buildSvgBandPath(data, xScale, yScale, lowerAccessor, upperAccessor) {
  const upperPoints = []
  const lowerPoints = []

  for (let index = 0; index < data.length; index += 1) {
    const lowerValue = lowerAccessor(data[index])
    const upperValue = upperAccessor(data[index])
    if (!Number.isFinite(lowerValue) || !Number.isFinite(upperValue)) {
      continue
    }

    upperPoints.push([xScale(index), yScale(upperValue)])
    lowerPoints.push([xScale(index), yScale(lowerValue)])
  }

  if (!upperPoints.length) {
    return ''
  }

  let path = upperPoints
    .map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`)
    .join('')

  for (let index = lowerPoints.length - 1; index >= 0; index -= 1) {
    const [x, y] = lowerPoints[index]
    path += `L${x.toFixed(2)},${y.toFixed(2)}`
  }

  return `${path}Z`
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
  yDomainMin = null,
  yTickFormatter = (value) => String(value),
  lines = [],
  bands = [],
  regions = [],
  area = null,
  showZeroLine = false,
  referenceLines = [],
  yAxisTicks = null,
  hoverIndex: controlledHoverIndex = null,
  onHoverIndexChange = null,
  tooltipFormatter,
}) {
  const isNarrowLayout = useIsNarrowLayout()
  const [internalHoverIndex, setInternalHoverIndex] = useState(null)
  const hoverIndex = onHoverIndexChange ? controlledHoverIndex : internalHoverIndex
  const setHoverIndex = onHoverIndexChange || setInternalHoverIndex

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

    for (const band of bands) {
      for (const sample of data) {
        const lowerValue = band.lowerAccessor(sample)
        const upperValue = band.upperAccessor(sample)
        if (Number.isFinite(lowerValue)) {
          allValues.push(lowerValue)
        }
        if (Number.isFinite(upperValue)) {
          allValues.push(upperValue)
        }
      }
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

    const forcedYMin = Number.isFinite(yDomainMin) ? yDomainMin : null
    const minValue = forcedYMin ?? Math.min(...allValues)
    const maxObservedValue = Math.max(...allValues)
    const maxValue = forcedYMin == null ? maxObservedValue : Math.max(maxObservedValue, forcedYMin + 1)
    let domainTicks = buildNumericTicks(minValue, maxValue, 5)

    if (forcedYMin != null) {
      domainTicks = domainTicks.filter((value) => value >= forcedYMin)
      if (!domainTicks.length || domainTicks[0] !== forcedYMin) {
        domainTicks = [forcedYMin, ...domainTicks.filter((value) => value > forcedYMin)]
      }
      if (domainTicks.length === 1) {
        domainTicks.push(forcedYMin + 1)
      }
    }

    const yTicks = visibleYAxisTicks || domainTicks.map((value) => ({ value, label: yTickFormatter(value) }))
    const yMin = forcedYMin ?? domainTicks[0]
    const yMax = domainTicks[domainTicks.length - 1]
    const xTicks = buildArchiveTimeTicks(xMin, xMax, windowDays, isNarrowLayout)
    const xScale = (index) => margin.left + ((timestamps[index] - xMin) / Math.max(1, xMax - xMin)) * innerWidth
    const xScaleFromTimestamp = (timestamp) => margin.left + ((timestamp - xMin) / Math.max(1, xMax - xMin)) * innerWidth
    const yScale = (value) => {
      const clampedValue = forcedYMin == null ? value : Math.max(value, forcedYMin)
      return margin.top + innerHeight - ((clampedValue - yMin) / Math.max(1e-9, yMax - yMin)) * innerHeight
    }

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
  }, [area, bands, data, height, isNarrowLayout, lines, referenceLines, showZeroLine, windowDays, yAxisTicks, yDomainMin, yTickFormatter])

  if (!chartState) {
    return null
  }

  const effectiveHoverIndex = hoverIndex != null && hoverIndex >= 0 && hoverIndex < data.length ? hoverIndex : null
  const hoverSample = effectiveHoverIndex != null ? data[effectiveHoverIndex] : null
  const hoverX = effectiveHoverIndex != null ? chartState.xScale(effectiveHoverIndex) : null

  function setHoverIndexFromClientX(clientX, target) {
    const bounds = target.getBoundingClientRect()
    const relativeX = ((clientX - bounds.left) / bounds.width) * chartState.width
    const timestamp =
      chartState.xMin +
      ((relativeX - chartState.margin.left) / Math.max(1, chartState.innerWidth)) * (chartState.xMax - chartState.xMin)
    setHoverIndex(findNearestTimestampIndex(chartState.timestamps, timestamp))
  }

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
          setHoverIndexFromClientX(event.clientX, event.currentTarget)
        }}
        onTouchStart={(event) => {
          clearCurrentTextSelection()
          if (event.cancelable) {
            event.preventDefault()
          }

          const touch = event.touches[0]
          if (touch) {
            setHoverIndexFromClientX(touch.clientX, event.currentTarget)
          }
        }}
        onTouchMove={(event) => {
          clearCurrentTextSelection()
          if (event.cancelable) {
            event.preventDefault()
          }

          const touch = event.touches[0]
          if (!touch) {
            return
          }

          setHoverIndexFromClientX(touch.clientX, event.currentTarget)
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
        {bands.map((band) => (
          <path
            key={band.name}
            d={buildSvgBandPath(data, chartState.xScale, chartState.yScale, band.lowerAccessor, band.upperAccessor)}
            fill={band.fill}
            stroke="none"
          />
        ))}
        {regions.map((region) => {
          const startsAt = Date.parse(region.startsAt)
          const endsAt = Date.parse(region.endsAt)
          if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || endsAt <= chartState.xMin || startsAt >= chartState.xMax) {
            return null
          }

          const xStart = chartState.xScaleFromTimestamp(Math.max(startsAt, chartState.xMin))
          const xEnd = chartState.xScaleFromTimestamp(Math.min(endsAt, chartState.xMax))
          const width = Math.max(1, xEnd - xStart)
          return (
            <g key={`${region.id}-${region.holidayDateKey}-${region.startsAt}`}>
              <rect
                x={xStart}
                y={chartState.margin.top}
                width={width}
                height={chartState.height - chartState.margin.top - chartState.margin.bottom}
                fill={region.fill || CHART_HOLIDAY_REGION_FILL}
                stroke={region.stroke || CHART_HOLIDAY_REGION_STROKE}
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
              {width >= 52 ? (
                <text
                  x={xStart + 5}
                  y={chartState.margin.top + 14}
                  fill="#6c4a00"
                  fontSize={chartState.tickFontSize}
                >
                  {region.label}
                </text>
              ) : null}
            </g>
          )
        })}
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
  const modelAircraft = aircraft.filter((plane) => plane?.cohortKind !== 'untracked')

  for (const plane of modelAircraft) {
    const modelLabel = normalizeModelLabel(plane.label || plane.registration || plane.hex?.toUpperCase())
    const existing = grouped.get(modelLabel) || { modelLabel, count: 0, cohortKinds: new Set() }
    existing.count += 1
    existing.cohortKinds.add(plane.cohortKind || 'business')
    grouped.set(modelLabel, existing)
  }

  return Array.from(grouped.values())
    .sort((left, right) => right.count - left.count || left.modelLabel.localeCompare(right.modelLabel))
    .map((entry, index, entries) => {
      const total = modelAircraft.length || 1
      return {
        ...entry,
        cohortKinds: Array.from(entry.cohortKinds),
        hasMilitary: entry.cohortKinds.has('military'),
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

function createDashboardLoadError(message, details, cause = null) {
  const error = new Error(message)
  if (cause) {
    error.cause = cause
  }
  error.dashboardDetails = details
  return error
}

async function fetchDashboardSnapshot(dashboardUrl) {
  const requestUrl = buildDashboardRequestUrl(dashboardUrl)
  const response = await fetch(requestUrl, {
    cache: 'no-store',
  })
  const contentType = response.headers.get('content-type') || ''
  const responseText = await response.text()
  const details = {
    requestUrl,
    status: response.status,
    statusText: response.statusText,
    contentType,
    responseText,
  }

  if (!response.ok) {
    throw createDashboardLoadError(`Dashboard request failed with ${response.status}`, details)
  }

  try {
    return JSON.parse(responseText)
  } catch (cause) {
    const contentTypeHint =
      contentType && !DASHBOARD_JSON_CONTENT_TYPE_PATTERN.test(contentType)
        ? `; received ${contentType}`
        : ''
    throw createDashboardLoadError(`Dashboard response was not valid JSON${contentTypeHint}`, details, cause)
  }
}

function getDashboardLoadErrorMessage(error) {
  return error instanceof Error ? error.message : String(error || 'Dashboard data could not be loaded.')
}

function logDashboardLoadError(label, error) {
  console.error(label, error)
  if (error?.dashboardDetails) {
    console.error(`${label} response details`, error.dashboardDetails)
  }
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
  const rowCount = Math.max(
    timestamps.length,
    archive.c.length,
    archive.p?.length || 0,
    archive.s?.length || 0,
    archive.z?.length || 0,
  )

  return Array.from({ length: rowCount }, (_, index) =>
    normalizeArchiveSample({
      sampledAt: timestamps[index],
      concurrentCount: archive.c[index],
      predictedConcurrentCount: archive.p?.[index],
      predictedConcurrentStdDev: archive.s?.[index],
      sigmaShift: archive.z?.[index],
    }),
  )
}

function canonicalSampledAt(value) {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) {
    return null
  }

  return new Date(Math.round(timestamp / (30 * 60 * 1000)) * 30 * 60 * 1000).toISOString()
}

function buildClientSignalCalibration(records) {
  const residuals = []
  const positiveResiduals = []
  const baselineStdDevs = []

  for (const record of records) {
    const residual = Number(record.concurrentCount || 0) - Number(record.predictedConcurrentCount || 0)
    const baselineStdDev = Number(record.predictedConcurrentStdDev || 0)

    if (Number.isFinite(residual)) {
      residuals.push(residual)
      if (residual > 0) {
        positiveResiduals.push(residual)
      }
    }

    if (Number.isFinite(baselineStdDev) && baselineStdDev > 0) {
      baselineStdDevs.push(baselineStdDev)
    }
  }

  const stdDevFloor =
    median(residuals.map((residual) => Math.abs(residual)).filter((residual) => residual > 0)) ??
    median(baselineStdDevs) ??
    0
  const positiveExcessScale = median(positiveResiduals) ?? stdDevFloor

  return {
    stdDevFloor,
    positiveExcessScale,
  }
}

function computeClientSignal(currentValue, baselineMean, baselineStdDev, alarmSigmaThreshold, signalCalibration = null) {
  const divergence = Number(currentValue || 0) - Number(baselineMean || 0)
  const effectiveBaselineStdDev = Math.max(
    Number(baselineStdDev || 0),
    Number(signalCalibration?.stdDevFloor || 0),
  )

  if (!effectiveBaselineStdDev) {
    return {
      divergence,
      sigmaShift: 0,
      rawSigmaShift: 0,
      varianceAdjustedSigmaShift: 0,
      effectiveBaselineStdDev: 0,
      absoluteExcessWeight: 1,
      emergencyLevel: 1,
    }
  }

  const rawSigmaShift = baselineStdDev ? divergence / baselineStdDev : 0
  const varianceAdjustedSigmaShift = divergence / effectiveBaselineStdDev
  const positiveExcessScale = Number(signalCalibration?.positiveExcessScale || 0)
  const absoluteExcessWeight =
    divergence > 0 && positiveExcessScale > 0
      ? divergence / (divergence + positiveExcessScale)
      : 1
  const sigmaShift =
    varianceAdjustedSigmaShift > 0
      ? varianceAdjustedSigmaShift * absoluteExcessWeight
      : varianceAdjustedSigmaShift
  const emergencyLevel = Math.min(
    EMERGENCY_LEVEL_COUNT,
    Math.max(1, Math.floor((Math.max(0, sigmaShift) / Math.max(1, alarmSigmaThreshold || 0)) * 4) + 1),
  )

  return {
    divergence,
    sigmaShift,
    rawSigmaShift,
    varianceAdjustedSigmaShift,
    effectiveBaselineStdDev,
    absoluteExcessWeight,
    emergencyLevel,
  }
}

function calibrateClientAlarmThreshold(records) {
  if (!records.length) {
    return DEFAULT_ALARM_SIGMA_THRESHOLD
  }

  const latestTimestamp = Date.parse(records[records.length - 1].sampledAt)
  const lowerBound = latestTimestamp - 365 * ARCHIVE_DAY_MS
  const dailyPeaks = new Map()

  for (const record of records) {
    const sampledAtMs = Date.parse(record.sampledAt)
    if (!Number.isFinite(sampledAtMs) || sampledAtMs < lowerBound) {
      continue
    }

    const day = record.sampledAt.slice(0, 10)
    dailyPeaks.set(day, Math.max(dailyPeaks.get(day) ?? -Infinity, Number(record.sigmaShift || 0)))
  }

  const sortedPeaks = Array.from(dailyPeaks.values()).sort((left, right) => right - left)
  if (!sortedPeaks.length) {
    return DEFAULT_ALARM_SIGMA_THRESHOLD
  }

  if (sortedPeaks.length === 1) {
    return Math.max(MIN_ALARM_SIGMA_THRESHOLD, Math.ceil(sortedPeaks[0] * 10) / 10)
  }

  return Math.max(MIN_ALARM_SIGMA_THRESHOLD, Math.ceil((sortedPeaks[1] + 0.05) * 10) / 10)
}

function buildCombinedArchive(dashboards) {
  const archiveMaps = dashboards
    .map((dashboard) => {
      const archive = normalizeDashboardArchive(dashboard?.trends?.archive ?? [])
      return new Map(
        archive
          .map((sample) => {
            const sampledAt = canonicalSampledAt(sample.sampledAt)
            return sampledAt ? [sampledAt, { ...sample, sampledAt }] : null
          })
          .filter(Boolean),
      )
    })
    .filter((archiveMap) => archiveMap.size > 0)

  if (archiveMaps.length !== dashboards.length || !archiveMaps.length) {
    return []
  }

  const sampledAtKeys = Array.from(archiveMaps[0].keys())
    .filter((sampledAt) => archiveMaps.every((archiveMap) => archiveMap.has(sampledAt)))
    .sort((left, right) => Date.parse(left) - Date.parse(right))

  const provisionalRecords = sampledAtKeys.map((sampledAt) => {
    const samples = archiveMaps.map((archiveMap) => archiveMap.get(sampledAt))
    const concurrentCount = samples.reduce((total, sample) => total + Number(sample.concurrentCount || 0), 0)
    const predictedConcurrentCount = samples.reduce(
      (total, sample) => total + Number(sample.predictedConcurrentCount || 0),
      0,
    )
    const predictedConcurrentStdDev = Math.sqrt(
      samples.reduce((total, sample) => total + Number(sample.predictedConcurrentStdDev || 0) ** 2, 0),
    )

    return {
      sampledAt,
      concurrentCount,
      predictedConcurrentCount,
      predictedConcurrentStdDev,
    }
  })

  const signalCalibration = buildClientSignalCalibration(provisionalRecords)
  const scoredForCalibration = provisionalRecords.map((record) => ({
    ...record,
    ...computeClientSignal(
      record.concurrentCount,
      record.predictedConcurrentCount,
      record.predictedConcurrentStdDev,
      DEFAULT_ALARM_SIGMA_THRESHOLD,
      signalCalibration,
    ),
  }))
  const alarmSigmaThreshold = calibrateClientAlarmThreshold(scoredForCalibration)

  return provisionalRecords.map((record) => {
    const signal = computeClientSignal(
      record.concurrentCount,
      record.predictedConcurrentCount,
      record.predictedConcurrentStdDev,
      alarmSigmaThreshold,
      signalCalibration,
    )

    return {
      ...record,
      divergence: signal.divergence,
      sigmaShift: signal.sigmaShift,
      rawSigmaShift: signal.rawSigmaShift,
      varianceAdjustedSigmaShift: signal.varianceAdjustedSigmaShift,
      effectiveBaselineStdDev: signal.effectiveBaselineStdDev,
      absoluteExcessWeight: signal.absoluteExcessWeight,
      emergencyLevel: signal.emergencyLevel,
      alarmSigmaThreshold,
      signalStdDevFloor: signalCalibration.stdDevFloor,
      signalPositiveExcessScale: signalCalibration.positiveExcessScale,
    }
  })
}

function withAircraftCohortKind(aircraft, cohortKind) {
  return (aircraft || []).map((plane, index) => ({
    ...plane,
    cohortKind,
    markerId: `${cohortKind}:${plane.hex || plane.registration || plane.label || index}`,
  }))
}

function getSelectedDashboardEntries(primaryDashboard, selectedCohorts, extraDashboards, primaryKind = 'business') {
  if (!primaryDashboard) {
    return []
  }

  const entries = []
  if (selectedCohorts[primaryKind] !== false) {
    entries.push({ kind: primaryKind, dashboard: primaryDashboard })
  }

  for (const kind of ['military', 'untracked']) {
    if (selectedCohorts[kind] && extraDashboards[kind]) {
      entries.push({ kind, dashboard: extraDashboards[kind] })
    }
  }

  return entries
}

function mergeHolidayWindows(dashboards) {
  const windowsByKey = new Map()

  for (const dashboard of dashboards) {
    for (const window of dashboard?.trends?.holidayWindows ?? []) {
      const keyParts = [
        window.id,
        window.holidayDateKey,
        window.startsAt,
        window.endsAt,
      ].filter(Boolean)
      if (!keyParts.length) {
        continue
      }

      const key = keyParts.join('|')
      if (!windowsByKey.has(key)) {
        windowsByKey.set(key, window)
      }
    }
  }

  return Array.from(windowsByKey.values()).sort(
    (left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt),
  )
}

function buildCombinedDashboardView(primaryDashboard, selectedCohorts, extraDashboards, primaryKind = 'business') {
  const selectedEntries = getSelectedDashboardEntries(primaryDashboard, selectedCohorts, extraDashboards, primaryKind)
  if (!selectedEntries.length) {
    return primaryDashboard
  }

  const selectedDashboards = selectedEntries.map((entry) => entry.dashboard)
  const holidayWindows = mergeHolidayWindows(selectedDashboards)
  const liveAircraft = selectedEntries.flatMap((entry) =>
    withAircraftCohortKind(entry.dashboard.liveAircraft, entry.kind),
  )

  if (selectedEntries.length === 1) {
    const [{ kind, dashboard }] = selectedEntries
    return {
      ...dashboard,
      liveAircraft,
      trends: {
        ...dashboard.trends,
        holidayWindows,
      },
      selectedCohorts: { [kind]: true },
      combinedCohortKinds: [kind],
    }
  }

  const combinedArchive = buildCombinedArchive(selectedDashboards)
  const latestArchiveSample = combinedArchive[combinedArchive.length - 1]
  const selectedCurrentCounts = selectedDashboards.map((dashboard) => Number(dashboard.current?.concurrentCount))
  const actualConcurrentCount = selectedCurrentCounts.some((count) => Number.isFinite(count))
    ? selectedCurrentCounts.reduce((sum, count) => sum + (Number.isFinite(count) ? count : 0), 0)
    : latestArchiveSample?.concurrentCount ?? 0
  const expectedConcurrentCount = selectedDashboards.reduce(
    (sum, dashboard) => sum + Number(dashboard.current?.baselineMean || dashboard.signals?.composite?.expectedConcurrentCount || 0),
    0,
  ) || latestArchiveSample?.predictedConcurrentCount || 0
  const expectedConcurrentStdDev = Math.sqrt(
    selectedDashboards.reduce(
      (sum, dashboard) => sum + Number(dashboard.current?.baselineStdDev || dashboard.signals?.composite?.expectedConcurrentStdDev || 0) ** 2,
      0,
    ),
  ) || latestArchiveSample?.predictedConcurrentStdDev || 0
  const signalStdDevFloor = latestArchiveSample?.signalStdDevFloor
  const signalPositiveExcessScale = latestArchiveSample?.signalPositiveExcessScale
  const alarmSigmaThreshold = latestArchiveSample?.alarmSigmaThreshold ?? Math.max(
    MIN_ALARM_SIGMA_THRESHOLD,
    ...selectedDashboards.map((dashboard) => Number(dashboard.current?.alarmSigmaThreshold || 0)),
  )
  const currentSignal = computeClientSignal(
    actualConcurrentCount,
    expectedConcurrentCount,
    expectedConcurrentStdDev,
    alarmSigmaThreshold,
    {
      stdDevFloor: signalStdDevFloor ?? 0,
      positiveExcessScale: signalPositiveExcessScale ?? 0,
    },
  )
  const trackedCounts = selectedDashboards.map((dashboard) => Number(dashboard.cohort?.trackedCount))
  const hasUnboundedCohort = selectedEntries.some((entry) => entry.kind === 'untracked')
  const trackedCount =
    hasUnboundedCohort || trackedCounts.some((count) => !Number.isFinite(count))
      ? null
      : trackedCounts.reduce((sum, count) => sum + count, 0)
  const latestSampledAt =
    latestArchiveSample?.sampledAt ??
    selectedDashboards
      .map((dashboard) => dashboard.current?.asOf)
      .filter(Boolean)
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ??
    primaryDashboard.current?.asOf

  return {
    ...primaryDashboard,
    cohort: {
      ...primaryDashboard.cohort,
      trackedCount,
      source: 'combined_selected_aircraft',
      sourceLabel: 'Selected aircraft categories',
      cohortType: 'combined',
    },
    liveStatus: {
      ...primaryDashboard.liveStatus,
      latestSampledAt,
      concurrentCount: actualConcurrentCount,
    },
    current: {
      ...primaryDashboard.current,
      asOf: latestSampledAt,
      concurrentCount: actualConcurrentCount,
      baselineMean: expectedConcurrentCount,
      baselineStdDev: expectedConcurrentStdDev,
      effectiveBaselineStdDev: currentSignal.effectiveConcurrentStdDev ?? currentSignal.effectiveBaselineStdDev,
      zScore: currentSignal.sigmaShift,
      rawZScore: currentSignal.rawSigmaShift,
      varianceAdjustedZScore: currentSignal.varianceAdjustedSigmaShift,
      absoluteExcessWeight: currentSignal.absoluteExcessWeight,
      emergencyLevel: currentSignal.emergencyLevel,
      alarmSigmaThreshold,
      elevatedSigmaThreshold: Math.max(1.5, alarmSigmaThreshold / 2),
    },
    signals: {
      ...primaryDashboard.signals,
      composite: {
        ...primaryDashboard.signals?.composite,
        asOf: latestSampledAt,
        actualConcurrentCount,
        expectedConcurrentCount,
        expectedConcurrentStdDev,
        effectiveConcurrentStdDev: currentSignal.effectiveConcurrentStdDev ?? currentSignal.effectiveBaselineStdDev,
        rawSigmaShift: currentSignal.rawSigmaShift,
        varianceAdjustedSigmaShift: currentSignal.varianceAdjustedSigmaShift,
        absoluteExcessWeight: currentSignal.absoluteExcessWeight,
        signalStdDevFloor,
        signalPositiveExcessScale,
        sigmaShift: currentSignal.sigmaShift,
        emergencyLevel: currentSignal.emergencyLevel,
        alarmSigmaThreshold,
        elevatedSigmaThreshold: Math.max(1.5, alarmSigmaThreshold / 2),
        concurrentPredictionModel: CONCURRENT_WEEKLY_US_HOLIDAY_MODEL,
      },
    },
    liveAircraft,
    trends: {
      ...primaryDashboard.trends,
      archive: combinedArchive,
      holidayWindows,
    },
    selectedCohorts,
    combinedCohortKinds: selectedEntries.map((entry) => entry.kind),
  }
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
          <strong>{formatCount(actualCount)}</strong>
          {Number.isFinite(Number(trackedCount)) ? (
            <>
              /<strong>{formatCount(trackedCount)}</strong>
            </>
          ) : null}
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

function ArchiveChart({ data, signal, holidayWindows = [], cohortControls = null }) {
  const archiveData = useMemo(() => normalizeDashboardArchive(data), [data])
  return (
    <ArchiveChartPanel
      data={archiveData}
      signal={signal}
      holidayWindows={holidayWindows}
      defaultWindowDays={3}
      cohortControls={cohortControls}
    />
  )
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

function ArchiveChartPanel({ data, signal, holidayWindows, defaultWindowDays, cohortControls = null }) {
  const hasData = data.length > 0
  const sampledAtTimestamps = useMemo(() => data.map((sample) => Date.parse(sample.sampledAt || 0)), [data])
  const latestTimestamp = sampledAtTimestamps[sampledAtTimestamps.length - 1] || 0
  const earliestTimestamp = sampledAtTimestamps[0] || 0
  const maxDaysAvailable = Math.max(1, Math.ceil((latestTimestamp - earliestTimestamp) / ARCHIVE_DAY_MS))
  const [archiveWindowDays, setArchiveWindowDaysState] = useState(defaultWindowDays)
  const [endDaysAgo, setEndDaysAgo] = useState(0)
  const [sharedHoverIndex, setSharedHoverIndex] = useState(null)
  const effectiveWindowDays = clamp(archiveWindowDays, 1, maxDaysAvailable)
  const maxEndDaysAgo = Math.max(0, maxDaysAvailable - effectiveWindowDays)
  const archivePositionSnapDays = getArchivePositionSnapDays(archiveWindowDays)
  const clampedEndDaysAgo = snapArchiveEndDaysAgo(endDaysAgo, archivePositionSnapDays, maxEndDaysAgo)
  const maxArchivePositionStep = Math.floor(maxEndDaysAgo / archivePositionSnapDays)
  const currentArchivePositionStep = Math.round(clampedEndDaysAgo / archivePositionSnapDays)
  const startDaysAgo = clampedEndDaysAgo + effectiveWindowDays
  const sliderValue = maxArchivePositionStep - currentArchivePositionStep
  const sliderPercent = maxArchivePositionStep > 0 ? (sliderValue / maxArchivePositionStep) * 100 : 100
  const isDenseWindow = archiveWindowDays >= 28
  const primaryLineWidth = isDenseWindow ? 1.45 : 2.5
  const referenceLineWidth = isDenseWindow ? 0.75 : 1
  const signalUsesPredictionBandModel = PREDICTION_BAND_MODELS.has(signal?.concurrentPredictionModel)

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
  const visibleHoverIndex =
    sharedHoverIndex != null && sharedHoverIndex >= 0 && sharedHoverIndex < visibleData.length
      ? sharedHoverIndex
      : null
  const visibleHolidayWindows = useMemo(() => {
    const visibleStartMs = Date.parse(visibleStart)
    const visibleEndMs = Date.parse(visibleEnd)
    if (!Number.isFinite(visibleStartMs) || !Number.isFinite(visibleEndMs)) {
      return []
    }

    return holidayWindows.filter((window) => {
      const startsAt = Date.parse(window.startsAt)
      const endsAt = Date.parse(window.endsAt)
      return Number.isFinite(startsAt) && Number.isFinite(endsAt) && endsAt >= visibleStartMs && startsAt <= visibleEndMs
    })
  }, [holidayWindows, visibleEnd, visibleStart])
  const showPredictionStdDevBand =
    signalUsesPredictionBandModel ||
    visibleData.some((sample) => Number.isFinite(sample.predictedConcurrentStdDev) && sample.predictedConcurrentStdDev > 0)
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
        {cohortControls ? (
          <fieldset className="chart-checkbox-group cohort-toggle-group">
            <legend className="sr-only">Aircraft categories</legend>
            {cohortControls.options.map((option) => {
              const loading = cohortControls.loading?.[option.id]
              const error = cohortControls.errors?.[option.id]
              const checked = Boolean(cohortControls.selected?.[option.id])

              return (
                <label
                  key={option.id}
                  className={`chart-checkbox-option cohort-toggle-option${checked ? ' cohort-toggle-option-active' : ''}${loading ? ' cohort-toggle-option-loading' : ''}${error ? ' cohort-toggle-option-error' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => cohortControls.onToggle(option.id)}
                  />
                  <span>{option.label}</span>
                  {loading ? <span className="cohort-toggle-status">loading</span> : null}
                  {error ? <span className="cohort-toggle-status">error</span> : null}
                </label>
              )
            })}
          </fieldset>
        ) : null}
      </div>
      <div className="chart-frame">
        <ArchiveSvgChart
          data={visibleData}
          height={ARCHIVE_CHART_HEIGHT}
          windowDays={visibleWindowDays}
          yDomainMin={0}
          regions={visibleHolidayWindows}
          hoverIndex={visibleHoverIndex}
          onHoverIndexChange={setSharedHoverIndex}
          bands={showPredictionStdDevBand ? [
            {
              name: 'Prediction standard deviation',
              lowerAccessor: (sample) => sample.predictedConcurrentCount - sample.predictedConcurrentStdDev,
              upperAccessor: (sample) => sample.predictedConcurrentCount + sample.predictedConcurrentStdDev,
              fill: CHART_PREDICTION_BAND_FILL,
            },
          ] : []}
          lines={[
            {
              name: 'Observed concurrent',
              accessor: (sample) => sample.concurrentCount,
              stroke: CHART_PRIMARY_COLOR,
              strokeWidth: primaryLineWidth,
            },
          ]}
          tooltipFormatter={(sample) => (
            <>
              <strong>{formatTimestamp(sample.sampledAt, { weekday: true })}</strong>
              <span>Observed: {formatCount(sample.concurrentCount)}</span>
              <span>Predicted: {formatCount(sample.predictedConcurrentCount)}</span>
              {showPredictionStdDevBand && Number.isFinite(sample.predictedConcurrentStdDev) ? (
                <span>Std dev: +/- {formatCount(sample.predictedConcurrentStdDev)}</span>
              ) : null}
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
            regions={visibleHolidayWindows}
            hoverIndex={visibleHoverIndex}
            onHoverIndexChange={setSharedHoverIndex}
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
                <strong>{formatTimestamp(sample.sampledAt, { weekday: true })}</strong>
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

proj4.defs(
  'EPSG:8857',
  '+proj=eqearth +lon_0=0 +x_0=0 +y_0=0 +R=6371008.7714 +units=m +no_defs +type=crs',
)

function geogLonLatToEqualEarthMercatorLonLat(coordinate) {
  const sourceLon = Number(coordinate?.[0])
  const sourceLat = Number(coordinate?.[1])
  if (!Number.isFinite(sourceLon) || !Number.isFinite(sourceLat)) {
    return null
  }

  const equalEarthMeters = proj4('EPSG:4326', 'EPSG:8857', [
    clamp(sourceLon, -180, 180),
    clamp(sourceLat, -90, 90),
  ])
  const transformed = proj4('EPSG:3857', 'EPSG:4326', [
    equalEarthMeters[0] * MAPLIBRE_EQUAL_EARTH_GRID_FACTOR,
    equalEarthMeters[1] * MAPLIBRE_EQUAL_EARTH_GRID_FACTOR,
  ])
  if (!Number.isFinite(transformed?.[0]) || !Number.isFinite(transformed?.[1])) {
    return null
  }

  let transformedLon = transformed[0]
  if (sourceLon <= -179.999 && transformedLon > 0) {
    transformedLon = -Math.abs(transformedLon)
  } else if (sourceLon >= 179.999 && transformedLon < 0) {
    transformedLon = Math.abs(transformedLon)
  }

  return [
    clamp(transformedLon, -180, 180),
    clamp(transformed[1], -85, 85),
    ...coordinate.slice(2),
  ]
}

function createEqualEarthBoundsFromGeographicBounds([[west, south], [east, north]]) {
  const transformedPoints = []
  const steps = 24
  for (let index = 0; index <= steps; index += 1) {
    const fraction = index / steps
    const lon = west + (east - west) * fraction
    const lat = south + (north - south) * fraction
    transformedPoints.push(
      geogLonLatToEqualEarthMercatorLonLat([lon, south]),
      geogLonLatToEqualEarthMercatorLonLat([lon, north]),
      geogLonLatToEqualEarthMercatorLonLat([west, lat]),
      geogLonLatToEqualEarthMercatorLonLat([east, lat]),
    )
  }

  const validPoints = transformedPoints.filter(Boolean)
  return [
    [
      Math.min(...validPoints.map((point) => point[0])),
      Math.min(...validPoints.map((point) => point[1])),
    ],
    [
      Math.max(...validPoints.map((point) => point[0])),
      Math.max(...validPoints.map((point) => point[1])),
    ],
  ]
}

const MAPLIBRE_CONUS_BOUNDS = createEqualEarthBoundsFromGeographicBounds(MAPLIBRE_CONUS_GEOGRAPHIC_BOUNDS)

function getDestinationLonLat(lon, lat, bearingDegrees, distanceDegrees = 1) {
  const angularDistance = (distanceDegrees * Math.PI) / 180
  const bearing = (bearingDegrees * Math.PI) / 180
  const lat1 = (lat * Math.PI) / 180
  const lon1 = (lon * Math.PI) / 180
  const sinLat1 = Math.sin(lat1)
  const cosLat1 = Math.cos(lat1)
  const sinDistance = Math.sin(angularDistance)
  const cosDistance = Math.cos(angularDistance)
  const lat2 = Math.asin((sinLat1 * cosDistance) + (cosLat1 * sinDistance * Math.cos(bearing)))
  const lon2 = lon1 + Math.atan2(
    Math.sin(bearing) * sinDistance * cosLat1,
    cosDistance - (sinLat1 * Math.sin(lat2)),
  )

  return [
    (((lon2 * 180) / Math.PI + 540) % 360) - 180,
    (lat2 * 180) / Math.PI,
  ]
}

function getProjectedAircraftRotation(plane, projectedCoordinate) {
  const path = Array.isArray(plane?.path) ? [...plane.path] : []
  const currentPosition = { lat: Number(plane?.lat), lon: Number(plane?.lon) }
  const latestPathPoint = path[path.length - 1]

  if (
    Number.isFinite(currentPosition.lat) &&
    Number.isFinite(currentPosition.lon) &&
    (!latestPathPoint ||
      Number(latestPathPoint.lat) !== currentPosition.lat ||
      Number(latestPathPoint.lon) !== currentPosition.lon)
  ) {
    path.push(currentPosition)
  }

  const projectedPath = path
    .map((point) => {
      if (!Number.isFinite(Number(point?.lat)) || !Number.isFinite(Number(point?.lon))) {
        return null
      }

      return geogLonLatToEqualEarthMercatorLonLat([Number(point.lon), Number(point.lat)])
    })
    .filter(Boolean)

  if (!projectedPath.some((point) => point === projectedCoordinate)) {
    projectedPath.push(projectedCoordinate)
  }

  for (let index = projectedPath.length - 1; index > 0; index -= 1) {
    const currentPoint = projectedPath[index]
    const previousPoint = projectedPath[index - 1]
    let deltaX = currentPoint[0] - previousPoint[0]
    if (deltaX > 180) {
      deltaX -= 360
    } else if (deltaX < -180) {
      deltaX += 360
    }

    const deltaY = currentPoint[1] - previousPoint[1]
    if (Math.hypot(deltaX, deltaY) < 0.000001) {
      continue
    }

    return normalizeDegrees((Math.atan2(deltaX, deltaY) * 180) / Math.PI)
  }

  const track = normalizeDegrees(Number(plane?.track))
  if (track == null) {
    return 0
  }

  const lon = Number(plane?.lon)
  const lat = Number(plane?.lat)
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    return track
  }

  const nextProjectedCoordinate = geogLonLatToEqualEarthMercatorLonLat(getDestinationLonLat(lon, lat, track))
  if (!nextProjectedCoordinate) {
    return track
  }

  let deltaX = nextProjectedCoordinate[0] - projectedCoordinate[0]
  if (deltaX > 180) {
    deltaX -= 360
  } else if (deltaX < -180) {
    deltaX += 360
  }

  const deltaY = nextProjectedCoordinate[1] - projectedCoordinate[1]
  return Math.hypot(deltaX, deltaY) < 0.000001
    ? track
    : normalizeDegrees((Math.atan2(deltaX, deltaY) * 180) / Math.PI)
}

function createEqualEarthLineFeature(id, coordinates) {
  return {
    type: 'Feature',
    properties: { id },
    geometry: {
      type: 'LineString',
      coordinates: coordinates
        .map(geogLonLatToEqualEarthMercatorLonLat)
        .filter(Boolean),
    },
  }
}

function createEqualEarthGraticule() {
  const features = []
  for (let lon = -170; lon <= 170; lon += 10) {
    const coordinates = []
    for (let lat = -90; lat <= 90; lat += 1) {
      coordinates.push([lon, lat])
    }
    features.push(createEqualEarthLineFeature(`meridian-${lon}`, coordinates))
  }

  for (let lat = -80; lat <= 80; lat += 10) {
    const coordinates = []
    for (let lon = -180; lon <= 180; lon += 1) {
      coordinates.push([lon, lat])
    }
    features.push(createEqualEarthLineFeature(`parallel-${lat}`, coordinates))
  }

  return { type: 'FeatureCollection', features }
}

function createEqualEarthSphere() {
  const leftEdge = []
  const rightEdge = []
  for (let lat = -90; lat <= 90; lat += 2) {
    leftEdge.push(geogLonLatToEqualEarthMercatorLonLat([-180, lat]))
  }
  for (let lat = 90; lat >= -90; lat -= 2) {
    rightEdge.push(geogLonLatToEqualEarthMercatorLonLat([180, lat]))
  }

  const ring = [...leftEdge, ...rightEdge].filter(Boolean)
  ring.push(ring[0])

  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [ring],
        },
      },
    ],
  }
}

const MAPLIBRE_GRATICULE_FEATURE_COLLECTION = createEqualEarthGraticule()
const MAPLIBRE_SPHERE_FEATURE_COLLECTION = createEqualEarthSphere()

function createMapLibreEqualEarthStyle() {
  return {
    version: 8,
    sources: {
      'equal-earth-sphere': {
        type: 'geojson',
        data: MAPLIBRE_SPHERE_FEATURE_COLLECTION,
      },
      'equal-earth-graticule': {
        type: 'geojson',
        data: MAPLIBRE_GRATICULE_FEATURE_COLLECTION,
      },
      'equal-earth-supplemental-country-fill': {
        type: 'geojson',
        data: `${MAPLIBRE_EQUAL_EARTH_PATCH_BASE_URL}/morocco-sahara-fill.geojson`,
      },
      'equal-earth-supplemental-country-outline': {
        type: 'geojson',
        data: `${MAPLIBRE_EQUAL_EARTH_PATCH_BASE_URL}/morocco-sahara-outline.geojson`,
      },
      countries: {
        type: 'vector',
        url: 'https://assets.bbox.earth/tiles/ne_extracts_8857/ne_countries.json',
      },
    },
    layers: [
      {
        id: 'background',
        type: 'background',
        paint: {
          'background-color': '#ffffff',
        },
      },
      {
        id: 'equal-earth-sphere-fill',
        type: 'fill',
        source: 'equal-earth-sphere',
        paint: {
          'fill-color': '#fafafa',
          'fill-outline-color': '#999999',
        },
      },
      {
        id: 'equal-earth-graticule',
        type: 'line',
        source: 'equal-earth-graticule',
        paint: {
          'line-color': '#d9d9d9',
          'line-width': ['interpolate', ['linear'], ['zoom'], 0, 0.55, 4, 1],
          'line-opacity': 0.95,
        },
      },
      {
        id: 'equal-earth-country-fill',
        type: 'fill',
        source: 'countries',
        'source-layer': 'country',
        paint: {
          'fill-color': '#f2f2f2',
        },
      },
      {
        id: 'equal-earth-supplemental-country-fill',
        type: 'fill',
        source: 'equal-earth-supplemental-country-fill',
        paint: {
          'fill-color': '#f2f2f2',
          'fill-antialias': false,
        },
      },
      {
        id: 'equal-earth-antarctica-fill',
        type: 'fill',
        source: 'countries',
        'source-layer': 'country',
        filter: ['in', 'adm0_a3', 'ATA'],
        paint: {
          'fill-color': '#f2f2f2',
        },
      },
      {
        id: 'equal-earth-country-outline',
        type: 'line',
        source: 'countries',
        'source-layer': 'country',
        filter: ['!', ['in', ['get', 'adm0_a3'], ['literal', ['MAR', 'SAH']]]],
        layout: {
          'line-join': 'round',
        },
        paint: {
          'line-color': '#b6b6b6',
          'line-width': ['interpolate', ['linear'], ['zoom'], 0, 0.38, 4, 0.78],
          'line-opacity': 0.84,
        },
      },
      {
        id: 'equal-earth-supplemental-country-outline',
        type: 'line',
        source: 'equal-earth-supplemental-country-outline',
        layout: {
          'line-join': 'round',
        },
        paint: {
          'line-color': '#b6b6b6',
          'line-width': ['interpolate', ['linear'], ['zoom'], 0, 0.38, 4, 0.78],
          'line-opacity': 0.84,
        },
      },
      {
        id: 'equal-earth-country-border',
        type: 'line',
        source: 'countries',
        'source-layer': 'land-border-country',
        paint: {
          'line-color': '#c6c6c6',
          'line-width': ['interpolate', ['linear'], ['zoom'], 0, 0.25, 4, 0.58],
          'line-opacity': 0.62,
        },
      },
      {
        id: 'equal-earth-sphere-outline',
        type: 'line',
        source: 'equal-earth-sphere',
        paint: {
          'line-color': '#999999',
          'line-width': 1,
        },
      },
    ],
  }
}

function createMapLibreAircraftSvg(fill, stroke = '#ffffff') {
  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="-12 -12 24 24">
      <path d="${AIRCRAFT_MARKER_PATH}" fill="${fill}" stroke="${stroke}" stroke-width="0.68" stroke-linejoin="round"/>
    </svg>
  `
}

function createMapLibreDotSvg(fill, stroke = '#ffffff') {
  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="-12 -12 24 24">
      <circle cx="0" cy="0" r="5.2" fill="${fill}" stroke="${stroke}" stroke-width="1"/>
    </svg>
  `
}

function addMapLibreSvgImage(map, id, svg, pixelRatio = 4) {
  if (map.hasImage(id)) {
    return Promise.resolve()
  }

  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      if (!map.hasImage(id)) {
        map.addImage(id, image, { pixelRatio })
      }
      resolve()
    }
    image.onerror = reject
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  })
}

function addMapLibreAircraftImages(map) {
  return Promise.all([
    addMapLibreSvgImage(map, 'aircraft-business', createMapLibreAircraftSvg('#0000ee')),
    addMapLibreSvgImage(map, 'aircraft-military', createMapLibreAircraftSvg('#000000')),
    addMapLibreSvgImage(map, 'aircraft-active', createMapLibreAircraftSvg('#cc0000', '#ffffff')),
    addMapLibreSvgImage(map, 'aircraft-untracked', createMapLibreDotSvg('#0000ee')),
  ])
}

function getMapLibrePlaneMarkerId(plane, index = 0) {
  return String(plane?.markerId || plane?.hex || plane?.registration || `aircraft-${index}`)
}

function createEmptyAircraftFeatureCollection() {
  return { type: 'FeatureCollection', features: [] }
}

function fitMapLibreWorld(
  map,
  minZoomRef,
  setMapZoom,
  setMapMinZoom,
  { preserveZoom = false, initialBounds = MAPLIBRE_WORLD_BOUNDS } = {},
) {
  const previousZoom = map.getZoom()
  const previousCenter = map.getCenter()
  const wasAtMinimumZoom = previousZoom <= minZoomRef.current + MAPLIBRE_ZOOM_EPSILON

  map.fitBounds(MAPLIBRE_WORLD_BOUNDS, {
    padding: MAPLIBRE_WORLD_FIT_PADDING,
    duration: 0,
  })

  const minZoom = map.getZoom()
  const maxZoom = minZoom + MAPLIBRE_MAX_ZOOM_DELTA
  minZoomRef.current = minZoom
  map.setMinZoom(minZoom)
  map.setMaxZoom(maxZoom)

  if (preserveZoom && !wasAtMinimumZoom) {
    map.jumpTo({
      center: previousCenter,
      zoom: clamp(previousZoom, minZoom, maxZoom),
    })
  } else if (initialBounds === MAPLIBRE_WORLD_BOUNDS) {
    map.jumpTo({ center: [0, 0], zoom: minZoom })
  } else {
    map.fitBounds(initialBounds, {
      padding: MAPLIBRE_WORLD_FIT_PADDING,
      duration: 0,
    })
  }

  setMapMinZoom(minZoom)
  setMapZoom(map.getZoom())
}

function getMapLibreConstrainedCenter(map, minZoom) {
  const bounds = map.getBounds()
  const center = map.getCenter()
  const [[west, south], [east, north]] = MAPLIBRE_WORLD_BOUNDS
  const visibleWest = bounds.getWest()
  const visibleEast = bounds.getEast()
  const visibleSouth = bounds.getSouth()
  const visibleNorth = bounds.getNorth()
  const visibleLngSpan = visibleEast - visibleWest
  const visibleLatSpan = visibleNorth - visibleSouth
  let nextLng = center.lng
  let nextLat = center.lat

  if (map.getZoom() <= minZoom + MAPLIBRE_ZOOM_EPSILON) {
    nextLng = 0
    nextLat = 0
  } else {
    if (visibleLngSpan >= east - west) {
      nextLng = 0
    } else {
      if (visibleWest < west) {
        nextLng += west - visibleWest
      }
      if (visibleEast > east) {
        nextLng += east - visibleEast
      }
    }

    if (visibleLatSpan >= north - south) {
      nextLat = 0
    } else {
      if (visibleSouth < south) {
        nextLat += south - visibleSouth
      }
      if (visibleNorth > north) {
        nextLat += north - visibleNorth
      }
    }
  }

  nextLng = clamp(nextLng, west, east)
  nextLat = clamp(nextLat, south, north)

  return [nextLng, nextLat]
}

function getMapLibreConstrainedCenterForZoom(map, zoom, minZoom, clampingRef) {
  const originalCenter = map.getCenter()
  const originalZoom = map.getZoom()
  const wasClamping = clampingRef.current

  clampingRef.current = true
  try {
    map.jumpTo({
      center: originalCenter,
      zoom,
    })
    return getMapLibreConstrainedCenter(map, minZoom)
  } finally {
    map.jumpTo({
      center: originalCenter,
      zoom: originalZoom,
    })
    clampingRef.current = wasClamping
  }
}

function enforceMapLibreBounds(map, minZoom, clampingRef) {
  if (clampingRef.current) {
    return
  }

  const center = map.getCenter()
  const [nextLng, nextLat] = getMapLibreConstrainedCenter(map, minZoom)
  if (Math.abs(nextLng - center.lng) <= 0.000001 && Math.abs(nextLat - center.lat) <= 0.000001) {
    return
  }

  clampingRef.current = true
  map.jumpTo({ center: [nextLng, nextLat] })
  clampingRef.current = false
}

function hasValidMapPosition(plane) {
  const lat = Number(plane?.lat)
  const lon = Number(plane?.lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return false
  }

  if (plane?.cohortKind === 'untracked' && lon === 0) {
    return false
  }

  return true
}

function GlobalMap({ aircraft, dataUnavailable = false, liveStatus = null }) {
  const isNarrowLayout = useIsNarrowLayout()
  const [selectedMarkerId, setSelectedMarkerId] = useState(null)
  const [hoveredMarkerId, setHoveredMarkerId] = useState(null)
  const [mapZoom, setMapZoom] = useState(0)
  const [mapMinZoom, setMapMinZoom] = useState(0)
  const [mapError, setMapError] = useState(null)
  const mapContainerRef = useRef(null)
  const mapRef = useRef(null)
  const minZoomRef = useRef(0)
  const clampingRef = useRef(false)
  const programmaticZoomEndRef = useRef(null)
  const aircraftFeatureCollectionRef = useRef(createEmptyAircraftFeatureCollection())
  const displayedMarkerId = hoveredMarkerId || selectedMarkerId
  const aircraftByMarkerId = useMemo(() => {
    const byMarkerId = new Map()
    aircraft.forEach((plane, index) => {
      byMarkerId.set(getMapLibrePlaneMarkerId(plane, index), plane)
    })
    return byMarkerId
  }, [aircraft])
  const displayedPlane = useMemo(
    () => aircraftByMarkerId.get(displayedMarkerId) ?? null,
    [displayedMarkerId, aircraftByMarkerId],
  )
  const aircraftFeatureCollection = useMemo(() => {
    const activeMarkerId = hoveredMarkerId || selectedMarkerId
    return {
      type: 'FeatureCollection',
      features: aircraft
        .filter(hasValidMapPosition)
        .map((plane, index) => {
          const markerId = getMapLibrePlaneMarkerId(plane, index)
          const coordinate = geogLonLatToEqualEarthMercatorLonLat([Number(plane.lon), Number(plane.lat)])
          if (!coordinate) {
            return null
          }

          const cohortKind = plane.cohortKind || 'business'
          const active = markerId === activeMarkerId
          const icon =
            active ? 'aircraft-active'
              : cohortKind === 'military' ? 'aircraft-military'
                : cohortKind === 'untracked' ? 'aircraft-untracked'
                  : 'aircraft-business'

          return {
            type: 'Feature',
            id: markerId,
            properties: {
              markerId,
              cohortKind,
              icon,
              active,
              rotation: cohortKind === 'untracked' ? 0 : getProjectedAircraftRotation(plane, coordinate),
              sortKey: active ? 10 : cohortKind === 'military' ? 6 : cohortKind === 'untracked' ? 4 : 2,
            },
            geometry: {
              type: 'Point',
              coordinates: coordinate,
            },
          }
        })
        .filter(Boolean),
    }
  }, [aircraft, hoveredMarkerId, selectedMarkerId])
  const canZoomIn = mapZoom < mapMinZoom + MAPLIBRE_MAX_ZOOM_DELTA - MAPLIBRE_ZOOM_EPSILON
  const canZoomOut = mapZoom > mapMinZoom + MAPLIBRE_ZOOM_EPSILON

  useEffect(() => {
    aircraftFeatureCollectionRef.current = aircraftFeatureCollection
    const source = mapRef.current?.getSource(MAPLIBRE_AIRCRAFT_SOURCE_ID)
    source?.setData(aircraftFeatureCollection)
  }, [aircraftFeatureCollection])

  useEffect(() => {
    if (dataUnavailable || !mapContainerRef.current) {
      return undefined
    }

    let cancelled = false
    let map
    let resizeObserver

    async function initializeMap() {
      let maplibregl
      try {
        maplibregl = (await import('./loadMapLibre.js')).default
      } catch (error) {
        if (!cancelled) {
          console.error('Unable to load MapLibre', error)
          setMapError('MapLibre could not load in this browser.')
        }
        return
      }

      if (cancelled || !mapContainerRef.current) {
        return
      }

      try {
      map = new maplibregl.Map({
        container: mapContainerRef.current,
        style: createMapLibreEqualEarthStyle(),
        center: [0, 0],
        zoom: 0,
        attributionControl: false,
        renderWorldCopies: false,
        dragRotate: false,
        pitchWithRotate: false,
        maxPitch: 0,
      })
      } catch (error) {
        console.error('Unable to initialize MapLibre map', error)
        queueMicrotask(() => setMapError('MapLibre could not initialize WebGL in this browser.'))
        return
      }

      mapRef.current = map
      map.touchZoomRotate.disableRotation()

      const updateZoomState = () => {
        setMapZoom(map.getZoom())
      }
      const enforceBounds = () => {
        enforceMapLibreBounds(map, minZoomRef.current, clampingRef)
      }

      map.on('zoom', updateZoomState)
      map.on('moveend', enforceBounds)
      map.on('load', async () => {
        try {
          await addMapLibreAircraftImages(map)
        } catch (error) {
          console.error('Unable to add aircraft icons to MapLibre map', error)
        }

        if (cancelled) {
          return
        }

        map.addSource(MAPLIBRE_AIRCRAFT_SOURCE_ID, {
          type: 'geojson',
          data: aircraftFeatureCollectionRef.current,
          promoteId: 'markerId',
        })
        map.addLayer({
          id: MAPLIBRE_AIRCRAFT_HALO_LAYER_ID,
          type: 'circle',
          source: MAPLIBRE_AIRCRAFT_SOURCE_ID,
          paint: {
            'circle-color': '#cc0000',
            'circle-radius': [
              'interpolate',
              ['linear'],
              ['zoom'],
              0,
              ['case', ['==', ['get', 'active'], true], 10, 0],
              3,
              ['case', ['==', ['get', 'active'], true], 18, 0],
              5,
              ['case', ['==', ['get', 'active'], true], 24, 0],
            ],
            'circle-opacity': [
              'case',
              ['==', ['get', 'active'], true],
              0.12,
              0,
            ],
            'circle-stroke-width': 0,
          },
        })
        map.addLayer({
          id: MAPLIBRE_AIRCRAFT_ICON_LAYER_ID,
          type: 'symbol',
          source: MAPLIBRE_AIRCRAFT_SOURCE_ID,
          layout: {
            'icon-image': ['get', 'icon'],
            'icon-size': [
              'interpolate',
              ['linear'],
              ['zoom'],
              0,
              ['case', ['==', ['get', 'active'], true], 1.36, 1.1],
              3,
              ['case', ['==', ['get', 'active'], true], 1.89, 1.58],
              5,
              ['case', ['==', ['get', 'active'], true], 2.42, 2.02],
            ],
            'icon-rotate': ['get', 'rotation'],
            'icon-rotation-alignment': 'map',
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
            'symbol-sort-key': ['get', 'sortKey'],
          },
          paint: {
            'icon-opacity': 0.96,
          },
        })

        fitMapLibreWorld(map, minZoomRef, setMapZoom, setMapMinZoom, {
          initialBounds: isNarrowLayout ? MAPLIBRE_CONUS_BOUNDS : MAPLIBRE_WORLD_BOUNDS,
        })

        map.on('mousemove', MAPLIBRE_AIRCRAFT_ICON_LAYER_ID, (event) => {
          const markerId = event.features?.[0]?.properties?.markerId
          map.getCanvas().style.cursor = markerId ? 'pointer' : ''
          setHoveredMarkerId((currentMarkerId) => (currentMarkerId === markerId ? currentMarkerId : markerId || null))
        })
        map.on('mouseleave', MAPLIBRE_AIRCRAFT_ICON_LAYER_ID, () => {
          map.getCanvas().style.cursor = ''
          setHoveredMarkerId(null)
        })
        map.on('click', MAPLIBRE_AIRCRAFT_ICON_LAYER_ID, (event) => {
          const markerId = event.features?.[0]?.properties?.markerId
          if (markerId) {
            setSelectedMarkerId(markerId)
          }
        })
        map.on('click', (event) => {
          const features = map.queryRenderedFeatures(event.point, {
            layers: [MAPLIBRE_AIRCRAFT_ICON_LAYER_ID],
          })
          if (!features.length) {
            setSelectedMarkerId(null)
          }
        })
      })

      resizeObserver = new ResizeObserver(() => {
        window.requestAnimationFrame(() => {
          if (cancelled) {
            return
          }
          map.resize()
          fitMapLibreWorld(map, minZoomRef, setMapZoom, setMapMinZoom, { preserveZoom: true })
          enforceMapLibreBounds(map, minZoomRef.current, clampingRef)
        })
      })
      resizeObserver.observe(mapContainerRef.current)
    }

    initializeMap()

    return () => {
      cancelled = true
      resizeObserver?.disconnect()
      if (programmaticZoomEndRef.current && map) {
        map.off('moveend', programmaticZoomEndRef.current)
        programmaticZoomEndRef.current = null
      }
      map?.remove()
      if (mapRef.current === map) {
        mapRef.current = null
      }
    }
  }, [dataUnavailable, isNarrowLayout])

  function zoomMap(delta) {
    const map = mapRef.current
    if (!map) {
      return
    }

    const nextZoom = clamp(
      map.getZoom() + delta,
      minZoomRef.current,
      minZoomRef.current + MAPLIBRE_MAX_ZOOM_DELTA,
    )

    if (Math.abs(nextZoom - map.getZoom()) <= MAPLIBRE_ZOOM_EPSILON / 10) {
      return
    }

    if (programmaticZoomEndRef.current) {
      map.off('moveend', programmaticZoomEndRef.current)
      programmaticZoomEndRef.current = null
      clampingRef.current = false
      map.stop()
    }

    const nextCenter = getMapLibreConstrainedCenterForZoom(map, nextZoom, minZoomRef.current, clampingRef)

    clampingRef.current = true
    const finishProgrammaticZoom = () => {
      clampingRef.current = false
      programmaticZoomEndRef.current = null
      enforceMapLibreBounds(map, minZoomRef.current, clampingRef)
      setMapZoom(map.getZoom())
    }
    programmaticZoomEndRef.current = finishProgrammaticZoom
    map.once('moveend', finishProgrammaticZoom)
    map.easeTo({
      center: nextCenter,
      zoom: nextZoom,
      duration: 180,
    })
  }

  return (
    <section className="panel map-panel">
      <div className="panel-header">
        <div><h2>{dataUnavailable ? 'ADSB Data Unavailable' : 'Realtime Tracker'}</h2></div>
      </div>

      <div className="map-frame">
        {dataUnavailable || mapError ? (
          <div className="map-unavailable-state">
            <strong>{mapError ? 'Map Unavailable' : 'ADSB Data Unavailable'}</strong>
            <span>
              {mapError || (
                <>
                  ADS-B Exchange has not delivered a fresh heatmap recently, so live aircraft positions are paused.
                  {liveStatus?.latestSampledAt ? ` Last cached sample: ${formatTimestamp(liveStatus.latestSampledAt)}.` : ''}
                </>
              )}
            </span>
          </div>
        ) : (
          <>
            <div className="map-controls" aria-label="Map controls">
              <button type="button" className="map-control-button map-zoom-button" onClick={() => zoomMap(MAPLIBRE_ZOOM_STEP)} aria-label="Zoom in" disabled={!canZoomIn}>
                <span className="map-zoom-icon map-zoom-plus" aria-hidden="true" />
              </button>
              <button type="button" className="map-control-button map-zoom-button" onClick={() => zoomMap(-MAPLIBRE_ZOOM_STEP)} aria-label="Zoom out" disabled={!canZoomOut}>
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
            <div
              ref={mapContainerRef}
              className="maplibre-map"
              role="img"
              aria-label="Current aircraft positions"
            />
          </>
        )}
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

function MilitaryIcon({ className = 'model-military-icon' }) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="5.2" />
      <circle cx="8" cy="8" r="0.7" />
      <path d="M8 1.1v2" />
      <path d="M8 12.9v2" />
      <path d="M1.1 8h2" />
      <path d="M12.9 8h2" />
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

function ModelSummaryList({ aircraft, copy }) {
  const modelSummary = buildLiveModelSummary(aircraft)
  const showPassengerDetails = copy?.showSeatEstimate ?? true

  return (
    <section className="panel list-panel">
      <div className="panel-header">
        <div><h2>{copy?.modelSummaryTitle || 'Aircraft By Model'}</h2></div>
        <span className="map-badge">{formatCount(modelSummary.length)} types</span>
      </div>
      {modelSummary.length ? (
        <ul className="flight-list model-list">
          {modelSummary.map((entry) => {
            const wikipediaUrl =
              entry.rank <= AIRCRAFT_MODEL_DETAIL_RANK_LIMIT
                ? getAircraftModelWikipediaUrl(entry.modelLabel)
                : null
            const maxPassengers =
              showPassengerDetails && entry.rank <= AIRCRAFT_MODEL_DETAIL_RANK_LIMIT
                ? getAircraftModelMaxPassengers(entry.modelLabel)
                : null

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
                    {entry.hasMilitary ? (
                      <span
                        className="model-military-label"
                        title="Military aircraft"
                        aria-label="Military aircraft"
                      >
                        <MilitaryIcon />
                      </span>
                    ) : null}
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
          {copy?.emptyLiveText || 'No tracked aircraft are currently airborne in the latest cached heatmap.'}
        </div>
      )}
    </section>
  )
}

function AboutSystemCard({ cohort, copy }) {
  const isGlobalCohort = cohort?.source === 'global_business_jet' || Number(cohort?.globalCount || 0) > 0
  const cohortKind = getCohortKind(cohort)

  return (
    <section className="panel about-panel">
      <div className="panel-header">
        <div><h2>How This Works</h2></div>
      </div>
      <div className="about-copy">
        <p>
          This site watches {copy.trackedDescription} and asks a simple question: is the number currently airborne
          unusual for this time? {cohortKind === 'untracked' ? 'It is tracking all visible non-ICAO addresses, not all aircraft.' : 'It is not tracking all aircraft.'}{' '}
          {cohortKind === 'untracked' ? (
            <>
              The untracked mode does not use aircraft identity metadata. It scans ADS-B Exchange heatmaps for readsb
              non-ICAO <code>~hex</code> addresses and tracks those addresses as observed, even when the underlying
              aircraft identity is unknown.
            </>
          ) : (
            <>
              The original version used an FAA-only business-jet list. The current tracker builds a broader global
              aircraft metadata table by merging{' '}
              <a href="https://downloads.adsbexchange.com/downloads/basic-ac-db.json.gz" target="_blank" rel="noreferrer">
                ADS-B Exchange aircraft records
              </a>
              ,{' '}
              <a href="https://github.com/wiedehopf/tar1090-db" target="_blank" rel="noreferrer">
                Mictronics/tar1090 records
              </a>
              {isGlobalCohort ? (
                <>
                  , and{' '}
                  <a
                    href="https://www.faa.gov/licenses_certificates/aircraft_certification/aircraft_registry/releasable_aircraft_download"
                    target="_blank"
                    rel="noreferrer"
                  >
                    FAA registry data
                  </a>
                </>
              ) : null}{' '}
              by ICAO hex. The importer classifies metadata into business jets, military aircraft, large airliners,
              regional airliners, non-jet aircraft, and other known types, then applies {copy.filterDescription}. Each
              tracked aircraft is matched in live data by its{' '}
              <a
                href="https://en.wikipedia.org/wiki/Aviation_transponder_interrogation_modes#ICAO_24-bit_address"
                target="_blank"
                rel="noreferrer"
              >
                ICAO hex identifier
              </a>
              .
            </>
          )}
        </p>
        <p>
          The flight data comes from{' '}
          <a href="https://www.adsbexchange.com/" target="_blank" rel="noreferrer">
            ADS-B Exchange
          </a>{' '}
          heatmap files. Those files are published in half-hour slots and encode recent aircraft positions. The backend
          downloads the newest available heatmap, parses it, {cohortKind === 'untracked' ? 'selects non-ICAO records' : 'matches the aircraft in the heatmap against the tracked cohort'}, and stores the latest position, altitude, speed, heading, and airborne state for each match. Military aircraft and non-ICAO addresses are published as separate dashboard snapshots and loaded only when their toggles are enabled.
        </p>
        <p>
          Historical context comes from the same heatmap format. The backfill job walks through previous half-hour slots,
          counts how many {copy.trackedNoun} were airborne, and records those counts in SQLite. The dashboard then compares
          the current concurrent airborne count with an all-history weekly baseline for the same half-hour of the week.
          The model also learns local half-hour profiles around U.S. federal holidays, so predictable holiday travel is
          included in the prediction instead of treated as a generic spike.
        </p>
        <p>
          The deviation number is the current count minus the expected count. The sigma value puts that difference on the
          scale of historical model error and combines it with an absolute-excess weighting, so tiny overnight changes do
          not dominate just because the usual count is low. When multiple aircraft categories are selected, their observed
          counts, predictions, and variances are combined and the emergency level is recalibrated for the selected total.
        </p>
        {copy.showSeatEstimate ? (
          <p>
            The max-people estimate is intentionally rough. It maps known aircraft model labels to published maximum
            passenger capacities, sums the known matches, and scales missing capacities by the known average. It is a maximum
            seat estimate, not a passenger manifest.
          </p>
        ) : null}
        <p>
          There are important limits. ADS-B coverage can be incomplete, aircraft may be blocked or misidentified, heatmaps
          arrive in coarse half-hour windows, and the {copy.sourceShort} cohort is a heuristic
          rather than a perfect definition of every relevant {copy.trackedSingular}. The dashboard is best read as an anomaly monitor
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

function FaqCard() {
  return (
    <section className="panel faq-panel">
      <div className="panel-header">
        <div><h2>FAQ</h2></div>
      </div>
      <div className="faq-list">
        <article>
          <h3>Is this trying to detect missiles that are already inbound?</h3>
          <p>
            No. The useful signal would be earlier behavior: people or institutions acting on information hours or days
            before it becomes obvious publicly.
          </p>
        </article>
        <article>
          <h3>What counts as a business jet here?</h3>
          <p>
            For this app, business jets are a fixed aircraft cohort selected from public aircraft metadata by ICAO hex.
            The filter looks for jet records whose manufacturer, model, or ICAO type matches common business-jet families
            such as Citation, Gulfstream, Falcon, Global, Challenger, Learjet, Phenom, Praetor, HondaJet, PC-24, Hawker,
            Beechjet, Eclipse, and Vision Jet. It excludes aircraft marked military and obvious airliners or regional
            airliners such as Boeing 7xx, Airbus A3xx/A2xx, CRJ airline variants, ERJ/EMB regional jets, MD/DC aircraft,
            and other large transport categories. It is a practical type-based cohort, not proof of private ownership,
            passenger identity, or trip purpose.
          </p>
        </article>
        <article>
          <h3>Would EMP immediately destroy airplanes?</h3>
          <p>
            Aircraft are generally more robust than consumer electronics because certified airplanes already need
            lightning protection.{' '}
            <a href="https://www.law.cornell.edu/cfr/text/14/25.1316" target="_blank" rel="noreferrer">
              FAA lightning-protection rules
            </a>{' '}
            require important electrical and electronic systems to withstand or recover from lightning exposure. That
            does not prove immunity to every nuclear EMP case, but aircraft are not inherently fragile in the way a laptop
            or phone might be.
          </p>
        </article>
        <article>
          <h3>Why look at aircraft instead of news or prediction markets?</h3>
          <p>
            This should be read alongside other public signals. Prediction markets may react quickly to insider knowledge;
            <a
              href="https://www.theguardian.com/world/2026/apr/18/iran-war-bets-ethics-concerns?utm_source=chatgpt.com"
              target="_blank"
              rel="noreferrer"
            >
              reporting about Iran-war bets
            </a>{' '}
            described unusually well-timed wagers around military and oil-price events. This model is designed to tolerate
            normal one- or two-day increases in activity, including holiday travel, so a short surge has to be unusual
            relative to similar historical windows before it meaningfully moves the level.
          </p>
        </article>
        <article>
          <h3>Does level 5 mean an apocalypse is likely?</h3>
          <p>
            Level 5 means the current count is an extreme positive outlier under this model. It can still be caused by
            holidays, major sporting or political events, data artifacts, or cohort mistakes. The archive is included so
            those historical false positives are visible.
          </p>
        </article>
      </div>
    </section>
  )
}

function UpdatesCard({ copy }) {
  return (
    <section className="panel updates-panel">
      <div className="panel-header">
        <div><h2>Updates</h2></div>
      </div>
      <div className="updates-copy">
        <article className="update-entry">
          <h3>May 7, 2026</h3>
          <p>Added subscriptions for SMS/email notifications. The main map has been rebuilt with MapLibre, which should work better on more devices.</p>
        </article>
        <article className="update-entry">
          <h3>May 5, 2026</h3>
          <p>
            The dashboard now uses the {copy.sourceShort} dataset, a dense-history weekly baseline, U.S. federal
            holiday half-hour profiles, and linked archive hover. The model is less dependent on a short recent window
            and compensates around federal US holidays, which accounts for significant variation in global business jet
            traffic. Military aircraft and non-ICAO untracked aircraft can also be toggled into the traffic and emergency
            level plots, with the emergency level recalibrated for the selected combined total.
          </p>
          <p>
            The holiday correction learns each holiday&apos;s local time-of-day shape from older holiday-only backfills.
            Ordinary weekly traffic is learned from the continuous recent history, while predictable holiday travel
            windows such as late-night Thanksgiving arrivals and the New Year&apos;s return period are modeled separately.
            The prediction band also includes historical holiday-profile uncertainty, so holiday
            periods that vary a lot from year to year are treated as less surprising.
          </p>
          <p>Emergency level is now based on a calibrated excess score instead of raw time-slot surprise alone.</p>
        </article>
      </div>
    </section>
  )
}

function DataUnavailablePanel({ title, message }) {
  return (
    <section className="panel data-unavailable-panel">
      <div className="panel-header">
        <div><h2>{title}</h2></div>
      </div>
      <div className="empty-state data-unavailable-state">
        <strong>Data unavailable.</strong>
        <span>{message || 'The latest dashboard snapshot could not be loaded.'}</span>
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

function useInitialLoaderDismissed() {
  useEffect(() => {
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
  }, [])
}

function formatAdminValue(value) {
  if (value === null || value === undefined || value === '') {
    return 'null'
  }

  if (typeof value === 'boolean') {
    return value ? 'yes' : 'no'
  }

  return String(value)
}

function formatMessagingStatusLabel(status) {
  if (!status) {
    return 'Unknown'
  }

  return String(status)
    .replaceAll('_', ' ')
    .toLowerCase()
    .replace(/^\w/, (letter) => letter.toUpperCase())
}

function formatMessageHistoryLabel(value) {
  return formatMessagingStatusLabel(value || 'unknown')
}

function formatMessageHistoryTime(value) {
  if (!value) {
    return 'null'
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return String(value)
  }

  return date.toLocaleString()
}

function getMessageHistoryTimestamp(message) {
  const timestamp = Date.parse(message?.occurredAt || message?.updatedAt || message?.createdAt || '')
  return Number.isFinite(timestamp) ? timestamp : 0
}

function compareMessageHistoryAscending(left, right) {
  const timeDiff = getMessageHistoryTimestamp(left) - getMessageHistoryTimestamp(right)
  if (timeDiff !== 0) {
    return timeDiff
  }

  return String(left?.id || '').localeCompare(String(right?.id || ''))
}

function compareMessageHistoryDescending(left, right) {
  const timeDiff = getMessageHistoryTimestamp(right) - getMessageHistoryTimestamp(left)
  if (timeDiff !== 0) {
    return timeDiff
  }

  return String(right?.id || '').localeCompare(String(left?.id || ''))
}

function getSmsConversationMessages(messages) {
  if (!Array.isArray(messages)) {
    return []
  }

  return messages
    .filter((message) => String(message.channel || '').toLowerCase() === 'sms')
    .slice()
    .sort(compareMessageHistoryAscending)
}

function getEmailHistoryMessages(messages) {
  if (!Array.isArray(messages)) {
    return []
  }

  return messages
    .filter((message) => String(message.channel || '').toLowerCase() === 'email' && message.direction === 'outbound')
    .slice()
    .sort(compareMessageHistoryDescending)
}

function formatMessageDeliveryStatus(message) {
  if (message?.error) {
    return 'Failed'
  }

  const status = String(message?.status || message?.providerStatus || '').trim()
  return formatMessageHistoryLabel(status || 'sent')
}

function isMessageDeliveryError(message) {
  return Boolean(message?.error || ['failed', 'undelivered'].includes(String(message?.status || '').toLowerCase()))
}

function formatEmailSubject(message) {
  return String(message?.subject || '').trim() || '(no subject)'
}

function formatEmailPreview(message) {
  const text = String(message?.messageText || '').replace(/\s+/g, ' ').trim()
  if (!text) {
    return 'No email body recorded.'
  }

  return text.length > 220 ? `${text.slice(0, 217)}...` : text
}

function formatEmailBody(message) {
  return String(message?.messageText || '').trim() || 'No email body recorded.'
}

function createEmptySubscriberSummary() {
  return {
    total: 0,
    active: 0,
    pending_checkout: 0,
    past_due: 0,
    canceled: 0,
    wantsEmail: 0,
    wantsSms: 0,
    wantsBoth: 0,
    smsReplies: 0,
  }
}

function getSubscriberSummary(subscribers) {
  return subscribers.reduce(
    (summary, subscriber) => {
      summary.total += 1
      summary[subscriber.status] = (summary[subscriber.status] || 0) + 1
      if (subscriber.wantsEmail) {
        summary.wantsEmail += 1
      }
      if (subscriber.wantsSms) {
        summary.wantsSms += 1
      }
      if (subscriber.wantsEmail && subscriber.wantsSms) {
        summary.wantsBoth += 1
      }
      if (Number(subscriber.smsReplyCount || 0) > 0) {
        summary.smsReplies += 1
      }
      return summary
    },
    createEmptySubscriberSummary(),
  )
}

function getSubscriberFields(subscriber) {
  return [
    ['id', subscriber.id],
    ['status', subscriber.status],
    ['source', subscriber.source],
    ['email', subscriber.email],
    ['emailHash', subscriber.emailHash],
    ['accountEmail', subscriber.accountEmail],
    ['accountEmailHash', subscriber.accountEmailHash],
    ['accountEmailSource', subscriber.accountEmailSource],
    ['phone', subscriber.phone],
    ['phoneHash', subscriber.phoneHash],
    ['phoneCountry', subscriber.phoneCountry],
    ['wantsEmail', subscriber.wantsEmail],
    ['wantsSms', subscriber.wantsSms],
    ['smsConsentAt', subscriber.smsConsentAt],
    ['smsConsentIpHash', subscriber.smsConsentIpHash],
    ['smsConsentUserAgentHash', subscriber.smsConsentUserAgentHash],
    ['stripeCustomerId', subscriber.stripeCustomerId],
    ['stripeSubscriptionId', subscriber.stripeSubscriptionId],
    ['stripeCheckoutSessionId', subscriber.stripeCheckoutSessionId],
    ['stripeProductId', subscriber.stripeProductId],
    ['stripePriceId', subscriber.stripePriceId],
    ['checkoutUrl', subscriber.checkoutUrl],
    ['checkoutCreatedAt', subscriber.checkoutCreatedAt],
    ['checkoutCompletedAt', subscriber.checkoutCompletedAt],
    ['currentPeriodEnd', subscriber.currentPeriodEnd],
    ['canceledAt', subscriber.canceledAt],
    ['contactRedactedAt', subscriber.contactRedactedAt],
    ['smsOptedOutAt', subscriber.smsOptedOutAt],
    ['smsOptOutSource', subscriber.smsOptOutSource],
    ['emailOptedOutAt', subscriber.emailOptedOutAt],
    ['emailOptOutSource', subscriber.emailOptOutSource],
    ['welcomeEmailSentAt', subscriber.welcomeEmailSentAt],
    ['welcomeSmsSentAt', subscriber.welcomeSmsSentAt],
    ['stripeCancelAtPeriodEnd', subscriber.stripeCancelAtPeriodEnd],
    ['manualNote', subscriber.manualNote],
    ['createdAt', subscriber.createdAt],
    ['updatedAt', subscriber.updatedAt],
    ['hasEmailCipher', subscriber.hasEmailCipher],
    ['hasAccountEmailCipher', subscriber.hasAccountEmailCipher],
    ['hasPhoneCipher', subscriber.hasPhoneCipher],
    ['deliveryCount', subscriber.deliveryCount],
    ['emailDeliveryCount', subscriber.emailDeliveryCount],
    ['smsDeliveryCount', subscriber.smsDeliveryCount],
    ['deliveryErrorCount', subscriber.deliveryErrorCount],
    ['lastDeliveryAt', subscriber.lastDeliveryAt],
    ['smsReplyCount', subscriber.smsReplyCount],
    ['lastSmsReplyAt', subscriber.lastSmsReplyAt],
  ]
}

function parseSubscriberTimestamp(value) {
  const timestamp = Date.parse(value || '')
  return Number.isFinite(timestamp) ? timestamp : null
}

function formatSubscriberDateKey(timestamp) {
  const date = new Date(timestamp)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')

  return `${year}-${month}-${day}`
}

function getSubscriberChartTimestamp(subscriber) {
  if (subscriber.status === 'active') {
    return parseSubscriberTimestamp(subscriber.checkoutCompletedAt) ??
      parseSubscriberTimestamp(subscriber.checkoutCreatedAt) ??
      parseSubscriberTimestamp(subscriber.createdAt)
  }

  if (subscriber.status === 'canceled') {
    return parseSubscriberTimestamp(subscriber.canceledAt) ??
      parseSubscriberTimestamp(subscriber.updatedAt) ??
      parseSubscriberTimestamp(subscriber.createdAt)
  }

  return parseSubscriberTimestamp(subscriber.checkoutCreatedAt) ??
    parseSubscriberTimestamp(subscriber.createdAt) ??
    parseSubscriberTimestamp(subscriber.updatedAt)
}

function buildSubscriberDailyStats(subscribers) {
  const byDay = new Map()

  for (const subscriber of subscribers) {
    const timestamp = getSubscriberChartTimestamp(subscriber)
    if (!Number.isFinite(timestamp)) {
      continue
    }

    const day = formatSubscriberDateKey(timestamp)
    const stats = byDay.get(day) || {
      day,
      active: 0,
      pending: 0,
      canceled: 0,
      email: 0,
      sms: 0,
      both: 0,
      grossVolume: 0,
    }

    if (subscriber.status === 'active') {
      stats.active += 1
    } else if (subscriber.status === 'pending_checkout') {
      stats.pending += 1
    } else if (subscriber.status === 'canceled') {
      stats.canceled += 1
    }

    if (subscriber.wantsEmail) {
      stats.email += 1
    }
    if (subscriber.wantsSms) {
      stats.sms += 1
    }
    if (subscriber.wantsEmail && subscriber.wantsSms) {
      stats.both += 1
    }

    stats.grossVolume = stats.active * SUBSCRIPTION_GROSS_DOLLARS
    byDay.set(day, stats)
  }

  return Array.from(byDay.values()).sort((left, right) => left.day.localeCompare(right.day))
}

function normalizeSubscriberSummary(value) {
  const summary = {
    ...createEmptySubscriberSummary(),
    ...(value || {}),
  }
  return {
    total: Number(summary.total || 0),
    active: Number(summary.active || 0),
    pending_checkout: Number(summary.pending_checkout || 0),
    past_due: Number(summary.past_due || 0),
    canceled: Number(summary.canceled || 0),
    wantsEmail: Number(summary.wantsEmail || 0),
    wantsSms: Number(summary.wantsSms || 0),
    wantsBoth: Number(summary.wantsBoth || 0),
    smsReplies: Number(summary.smsReplies || 0),
  }
}

function normalizeSubscriberDailyStats(value) {
  if (!Array.isArray(value)) {
    return []
  }

  return value.map((item) => ({
    day: item.day,
    active: Number(item.active || 0),
    pending: Number(item.pending || 0),
    canceled: Number(item.canceled || 0),
    email: Number(item.email || 0),
    sms: Number(item.sms || 0),
    both: Number(item.both || 0),
    grossVolume: Number(item.grossVolume || 0),
  }))
}

function formatGrossVolume(value) {
  return `$${formatCount(value)}`
}

function SubscriberDailyChart({ title, data, series, valueFormatter = formatCount }) {
  const width = 760
  const height = 220
  const margin = { top: 18, right: 16, bottom: 34, left: 52 }
  const chartWidth = width - margin.left - margin.right
  const chartHeight = height - margin.top - margin.bottom
  const maxValue = Math.max(
    1,
    ...data.flatMap((item) => series.map((entry) => Number(item[entry.key] || 0))).filter(Number.isFinite),
  )
  const yTicks = buildNumericTicks(0, maxValue, 4).filter((tick) => tick >= 0)
  const xScale = (index) =>
    margin.left + (data.length <= 1 ? chartWidth / 2 : (index / Math.max(1, data.length - 1)) * chartWidth)
  const yScale = (value) => margin.top + chartHeight - (Number(value || 0) / Math.max(1, maxValue)) * chartHeight
  const labelEvery = Math.max(1, Math.ceil(data.length / 8))

  return (
    <section className="subscriber-chart-card" aria-label={title}>
      <div className="subscriber-chart-heading">
        <h3>{title}</h3>
        <div className="subscriber-chart-legend">
          {series.map((entry) => (
            <span key={entry.key}>
              <i style={{ background: entry.color }} />
              {entry.label}
            </span>
          ))}
        </div>
      </div>
      {data.length ? (
        <svg className="subscriber-chart-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title}>
          <rect x={margin.left} y={margin.top} width={chartWidth} height={chartHeight} fill="#ffffff" />
          {yTicks.map((tick) => (
            <g key={tick}>
              <line
                x1={margin.left}
                x2={margin.left + chartWidth}
                y1={yScale(tick)}
                y2={yScale(tick)}
                stroke="#d4d4d4"
              />
              <text x={margin.left - 8} y={yScale(tick) + 4} textAnchor="end">
                {valueFormatter(tick)}
              </text>
            </g>
          ))}
          {data.map((item, index) =>
            index % labelEvery === 0 || index === data.length - 1 ? (
              <text key={item.day} x={xScale(index)} y={height - 8} textAnchor="middle">
                {item.day.slice(5)}
              </text>
            ) : null,
          )}
          {series.map((entry) => (
            <path
              key={entry.key}
              d={buildSvgLinePath(data, xScale, yScale, (item) => item[entry.key])}
              fill="none"
              stroke={entry.color}
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
          {series.map((entry) =>
            data.map((item, index) => (
              <circle key={`${entry.key}-${item.day}`} cx={xScale(index)} cy={yScale(item[entry.key])} r="3" fill={entry.color} />
            )),
          )}
        </svg>
      ) : (
        <p className="empty-state">No subscriber history to plot.</p>
      )}
    </section>
  )
}

function SignupPage() {
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [phoneError, setPhoneError] = useState(null)
  const [smsConsent, setSmsConsent] = useState(false)
  const [status, setStatus] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [showSignupForm, setShowSignupForm] = useState(true)
  const hasPhone = phone.trim().length > 0

  useInitialLoaderDismissed()

  useEffect(() => {
    const previousTitle = document.title
    document.title = 'Apocalypse Notifications'

    const params = new URLSearchParams(window.location.search)
    if (params.get('success') === '1') {
      setShowSignupForm(false)
      setStatus({
        tone: 'success',
        message:
          'Payment received. Your notification subscription will activate as soon as Stripe confirms the checkout.',
      })
    } else if (params.get('canceled') === '1') {
      setShowSignupForm(true)
      setStatus({
        tone: 'error',
        message: 'Checkout was canceled. Your contact info was saved as pending, but alerts are not active yet.',
      })
    }

    const handlePageShow = () => {
      setSubmitting(false)
    }
    window.addEventListener('pageshow', handlePageShow)

    return () => {
      document.title = previousTitle
      window.removeEventListener('pageshow', handlePageShow)
    }
  }, [])

  function validatePhoneField(value) {
    const nextPhone = String(value || '').trim()
    if (!nextPhone) {
      setPhoneError(null)
      return ''
    }

    try {
      const normalizedPhone = normalizePhoneInput(nextPhone)
      setPhoneError(null)
      return normalizedPhone
    } catch (error) {
      const message = error.message || PHONE_VALIDATION_MESSAGE
      setPhoneError(message)
      throw new Error(message)
    }
  }

  async function handleSubmit(event) {
    event.preventDefault()

    const normalizedEmail = email.trim()
    const trimmedPhone = phone.trim()
    let normalizedPhone = ''

    if (!normalizedEmail && !trimmedPhone) {
      setPhoneError(null)
      setStatus({
        tone: 'error',
        message: 'Enter an email address, a phone number, or both before submitting.',
      })
      return
    }

    if (trimmedPhone) {
      try {
        normalizedPhone = validatePhoneField(trimmedPhone)
      } catch (error) {
        setStatus({
          tone: 'error',
          message: error.message,
        })
        return
      }
    }

    if (normalizedPhone && !smsConsent) {
      setStatus({
        tone: 'error',
        message: 'Check the SMS consent box before submitting a phone number.',
      })
      return
    }

    if (normalizedPhone && !isSupportedSmsCountry(normalizedPhone) && !window.confirm(NON_US_CANADA_PHONE_WARNING)) {
      setStatus({
        tone: 'error',
        message: 'Signup paused. Use a US/Canada number, or submit again and confirm to continue.',
      })
      return
    }

    if (normalizedPhone && normalizedPhone !== phone) {
      setPhone(normalizedPhone)
    }

    setSubmitting(true)
    setStatus({
      tone: 'success',
      message: 'Opening secure Stripe checkout...',
    })

    try {
      const response = await fetch('/api/signup/create-checkout-session', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          email: normalizedEmail,
          phone: normalizedPhone,
          smsConsent,
        }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || !payload.checkoutUrl) {
        throw new Error(payload.error || 'Could not start checkout.')
      }

      window.location.assign(payload.checkoutUrl)
    } catch (error) {
      setSubmitting(false)
      setStatus({
        tone: 'error',
        message: error.message,
      })
    }
  }

  return (
    <>
      <div className="background-wallpaper" style={{ backgroundImage: `url("${BACKGROUND_URL}")` }} aria-hidden="true" />
      <main className="app-shell signup-shell">
        <section className="focus-grid signup-grid">
          <section className="panel hero-copy-panel signup-copy-panel">
            <h1>Apocalypse Notifications</h1>
            <p className="hero-caption">
              Get notified when the emergency level reaches 5. Subscriptions are $5 per year and can send email, SMS,
              or both.
            </p>
            <p>
              <em>
                Contact info is only used for alerts and subscription updates, not sold or used for marketing, and old
                info is deleted. Update or cancel your subscription using{' '}
                <a href="https://billing.stripe.com/p/login/6oU7sL14I6ewbuL2dJ4ow00">the portal</a>. If you have
                questions about your subscription, please{' '}
                <a href="mailto:ews@kylemcdonald.net">email me</a>.
              </em>
            </p>
            <p className="hero-credit">
              <a href="/">Back to Dashboard</a>
            </p>
          </section>

          <section className="panel signup-panel" aria-labelledby="signup-form-title">
            <div className="panel-header">
              <div>
                <h2 id="signup-form-title">Notification Signup</h2>
              </div>
            </div>

            {status ? (
              <p className={`signup-status signup-status-${status.tone}`} role="status">
                {status.message}
              </p>
            ) : null}

            {showSignupForm ? (
              <form className="signup-form" onSubmit={handleSubmit}>
                <label className="signup-field">
                  <span>Email address</span>
                  <input
                    type="email"
                    name="email"
                    value={email}
                    autoComplete="email"
                    placeholder="you@example.com"
                    onChange={(event) => setEmail(event.target.value)}
                  />
                </label>

                <label className="signup-field">
                  <span>Phone number</span>
                  <input
                    type="tel"
                    name="phone"
                    value={phone}
                    autoComplete="tel"
                    inputMode="tel"
                    aria-invalid={phoneError ? 'true' : undefined}
                    aria-describedby={phoneError ? 'signup-phone-error' : undefined}
                    placeholder="+1 415 555 2671"
                    onBlur={(event) => {
                      if (!event.target.value.trim()) return
                      try {
                        const normalizedPhone = validatePhoneField(event.target.value)
                        if (normalizedPhone !== event.target.value) {
                          setPhone(normalizedPhone)
                        }
                      } catch {
                        // The inline field error handles invalid values.
                      }
                    }}
                    onChange={(event) => {
                      const nextPhone = event.target.value
                      setPhone(nextPhone)
                      setPhoneError(null)
                      if (!nextPhone.trim()) setSmsConsent(false)
                    }}
                  />
                  {phoneError ? (
                    <span id="signup-phone-error" className="signup-field-error">
                      {phoneError}
                    </span>
                  ) : null}
                </label>

                {hasPhone ? (
                  <label className="signup-consent">
                    <input
                      type="checkbox"
                      checked={smsConsent}
                      onChange={(event) => setSmsConsent(event.target.checked)}
                    />
                    <span>
                      I agree to receive automated SMS emergency alerts from Apocalypse Early Warning System at the phone
                      number provided. Message frequency varies. Message and data rates may apply. Reply STOP to cancel
                      or HELP for help.
                    </span>
                  </label>
                ) : null}

                <button className="signup-submit" type="submit" disabled={submitting}>
                  {submitting ? 'Opening Checkout...' : 'Sign Up'}
                </button>
              </form>
            ) : (
              <p className="signup-repeat">
                To sign up for another subscription,{' '}
                <button type="button" onClick={() => setShowSignupForm(true)}>
                  click here
                </button>
                .
              </p>
            )}
          </section>
        </section>

      </main>
    </>
  )
}

function ManageSubscriptionPage() {
  const params = new URLSearchParams(window.location.search)
  const subscriberToken = params.get('token') || ''
  const subscriberId = params.get('subscriber') || ''
  const [subscriber, setSubscriber] = useState(null)
  const [accountEmail, setAccountEmail] = useState('')
  const [alertEmail, setAlertEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [wantsEmail, setWantsEmail] = useState(false)
  const [wantsSms, setWantsSms] = useState(false)
  const [renewSubscription, setRenewSubscription] = useState(true)
  const [loading, setLoading] = useState(true)
  const [pendingAction, setPendingAction] = useState(null)
  const [status, setStatus] = useState(null)

  useInitialLoaderDismissed()

  useEffect(() => {
    const previousTitle = document.title
    document.title = 'Manage Apocalypse EWS'

    async function loadSubscriber() {
      if (!subscriberId || !subscriberToken) {
        setStatus({ tone: 'error', message: 'This management link is missing a token.' })
        setLoading(false)
        return
      }

      try {
        const searchParams = new URLSearchParams({ subscriber: subscriberId, token: subscriberToken })
        const response = await fetch(`/api/manage/subscriber?${searchParams.toString()}`, { cache: 'no-store' })
        const payload = await response.json().catch(() => ({}))
        if (!response.ok || !payload.subscriber) {
          throw new Error(payload.error || 'Could not load notification settings.')
        }
        setSubscriber(payload.subscriber)
        setAccountEmail(payload.subscriber.accountEmail || '')
        setAlertEmail(payload.subscriber.email || '')
        setPhone(payload.subscriber.phone || '')
        setWantsEmail(Boolean(payload.subscriber.wantsEmail))
        setWantsSms(Boolean(payload.subscriber.wantsSms))
        setRenewSubscription(!payload.subscriber.stripeCancelAtPeriodEnd)
      } catch (error) {
        setStatus({ tone: 'error', message: error.message })
      } finally {
        setLoading(false)
      }
    }

    loadSubscriber()
    return () => {
      document.title = previousTitle
    }
  }, [subscriberId, subscriberToken])

  function applySubscriber(nextSubscriber) {
    setSubscriber(nextSubscriber)
    setAccountEmail(nextSubscriber.accountEmail || '')
    setAlertEmail(nextSubscriber.email || '')
    setPhone(nextSubscriber.phone || '')
    setWantsEmail(Boolean(nextSubscriber.wantsEmail))
    setWantsSms(Boolean(nextSubscriber.wantsSms))
    setRenewSubscription(!nextSubscriber.stripeCancelAtPeriodEnd)
  }

  async function postManagementAction(action, body = {}) {
    setPendingAction(action)
    setStatus({ tone: 'success', message: 'Saving...' })
    try {
      const response = await fetch('/api/manage/subscriber', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          subscriber: subscriberId,
          token: subscriberToken,
          action,
          ...body,
        }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || !payload.subscriber) {
        throw new Error(payload.error || 'Could not update notification settings.')
      }
      applySubscriber(payload.subscriber)
      setStatus({
        tone: 'success',
        message: action === 'delete_account' ? 'Account deleted' : 'Settings updated.',
      })
    } catch (error) {
      setStatus({ tone: 'error', message: error.message })
    } finally {
      setPendingAction(null)
    }
  }

  function handleSave(event) {
    event.preventDefault()

    const trimmedPhone = phone.trim()
    let normalizedPhone = ''
    if (trimmedPhone) {
      try {
        normalizedPhone = normalizePhoneInput(trimmedPhone)
      } catch (error) {
        setStatus({ tone: 'error', message: error.message })
        return
      }
      if (!isSupportedSmsCountry(normalizedPhone)) {
        setStatus({ tone: 'error', message: 'SMS alerts currently support US and Canada phone numbers only.' })
        return
      }
    }

    postManagementAction('save', {
      accountEmail: subscriber?.source === 'manual' ? accountEmail.trim() : undefined,
      email: alertEmail.trim(),
      phone: normalizedPhone,
      wantsEmail,
      wantsSms,
      renewSubscription,
    })
  }

  function handleDeleteAccount() {
    const confirmed = window.confirm(
      'Delete your account? This will stop all notifications and remove your saved contact information.',
    )
    if (!confirmed) {
      return
    }

    postManagementAction('delete_account')
  }

  return (
    <>
      <div className="background-wallpaper" style={{ backgroundImage: `url("${BACKGROUND_URL}")` }} aria-hidden="true" />
      <main className="app-shell signup-shell">
        <section className="focus-grid signup-grid">
          <section className="panel hero-copy-panel signup-copy-panel">
            <h1>Manage Notifications</h1>
            <p className="hero-caption">Apocalypse Early Warning System notification settings.</p>
            <p className="hero-credit">
              <a href="/">Dashboard</a>
            </p>
          </section>

          <section className="panel signup-panel" aria-labelledby="manage-form-title">
            <div className="panel-header">
              <div>
                <h2 id="manage-form-title">Settings</h2>
              </div>
            </div>

            {loading ? <p className="signup-status signup-status-success">Loading...</p> : null}
            {status ? (
              <p className={`signup-status signup-status-${status.tone}`} role="status">
                {status.message}
              </p>
            ) : null}

            {subscriber ? (
              <>
                <form className="signup-form" onSubmit={handleSave}>
                  {subscriber.source === 'manual' ? (
                    <label className="signup-field">
                      <span>Account email</span>
                      <input
                        type="email"
                        value={accountEmail}
                        autoComplete="email"
                        disabled={subscriber.status === 'canceled'}
                        onChange={(event) => setAccountEmail(event.target.value)}
                      />
                    </label>
                  ) : null}

                  <label className="signup-field">
                    <span>Alert email</span>
                    <input
                      type="email"
                      value={alertEmail}
                      autoComplete="email"
                      disabled={subscriber.status === 'canceled'}
                      onChange={(event) => setAlertEmail(event.target.value)}
                    />
                  </label>

                  <label className="signup-field">
                    <span>Phone number</span>
                    <input
                      type="tel"
                      value={phone}
                      autoComplete="tel"
                      inputMode="tel"
                      disabled={subscriber.status === 'canceled'}
                      onChange={(event) => setPhone(event.target.value)}
                    />
                  </label>

                  <label className="signup-consent">
                    <input
                      type="checkbox"
                      checked={wantsEmail}
                      disabled={subscriber.status === 'canceled'}
                      onChange={(event) => setWantsEmail(event.target.checked)}
                    />
                    <span>Email alerts enabled</span>
                  </label>

                  <label className="signup-consent">
                    <input
                      type="checkbox"
                      checked={wantsSms}
                      disabled={subscriber.status === 'canceled'}
                      onChange={(event) => setWantsSms(event.target.checked)}
                    />
                    <span>SMS alerts enabled</span>
                  </label>

                  {subscriber.hasStripeSubscription ? (
                    <label className="signup-consent">
                      <input
                        type="checkbox"
                        checked={renewSubscription}
                        disabled={subscriber.status === 'canceled'}
                        onChange={(event) => setRenewSubscription(event.target.checked)}
                      />
                      <span>Renew subscription</span>
                    </label>
                  ) : null}

                  <button className="signup-submit" type="submit" disabled={Boolean(pendingAction) || subscriber.status === 'canceled'}>
                    {pendingAction === 'save' ? 'Saving...' : 'Save Settings'}
                  </button>
                </form>

                {subscriber.source === 'manual' && subscriber.status !== 'canceled' ? (
                  <button
                    className="danger-button"
                    type="button"
                    disabled={Boolean(pendingAction)}
                    onClick={handleDeleteAccount}
                  >
                    {pendingAction === 'delete_account' ? 'Deleting...' : 'Delete Account'}
                  </button>
                ) : null}

                {subscriber.stripeBillingPortalUrl ? (
                  <p className="signup-repeat">
                    <a href={subscriber.stripeBillingPortalUrl}>Manage billing information</a>
                  </p>
                ) : null}
              </>
            ) : null}
          </section>
        </section>
      </main>
    </>
  )
}

function AdminTestAlertPage() {
  const adminPath = window.location.pathname.replace(/\/+$/, '')
  const adminParams = new URLSearchParams(window.location.search)
  const adminView =
    adminPath === '/admin' || adminPath === '/admin/subscribers'
      ? 'subscribers'
      : adminPath === '/admin/manual'
        ? 'manual'
        : adminPath === '/admin/history'
          ? 'history'
          : adminPath === '/admin/test-alert'
            ? 'test'
            : 'subscribers'
  const historySubscriberId = adminParams.get('subscriber') || ''
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [status, setStatus] = useState(null)
  const [messagingStatus, setMessagingStatus] = useState(null)
  const [messagingStatusLoading, setMessagingStatusLoading] = useState(false)
  const [messagingStatusError, setMessagingStatusError] = useState(null)
  const [recentDeliveries, setRecentDeliveries] = useState([])
  const [subscriberRecords, setSubscriberRecords] = useState([])
  const [subscriberSummary, setSubscriberSummary] = useState(() => createEmptySubscriberSummary())
  const [subscriberDailyStats, setSubscriberDailyStats] = useState([])
  const [subscriberTotal, setSubscriberTotal] = useState(0)
  const [subscriberPageSize, setSubscriberPageSize] = useState(SUBSCRIBERS_PER_PAGE)
  const [subscriberLoading, setSubscriberLoading] = useState(false)
  const [subscriberStatus, setSubscriberStatus] = useState(null)
  const [subscriberPage, setSubscriberPage] = useState(1)
  const [subscriberSearchInput, setSubscriberSearchInput] = useState('')
  const [subscriberEmailSearch, setSubscriberEmailSearch] = useState('')
  const [subscriberRepliesOnly, setSubscriberRepliesOnly] = useState(false)
  const [manualAccountEmail, setManualAccountEmail] = useState('')
  const [manualAlertEmail, setManualAlertEmail] = useState('')
  const [manualPhone, setManualPhone] = useState('')
  const [manualWantsEmail, setManualWantsEmail] = useState(true)
  const [manualWantsSms, setManualWantsSms] = useState(true)
  const [manualSmsConsent, setManualSmsConsent] = useState(false)
  const [manualNote, setManualNote] = useState('')
  const [manualSubmitting, setManualSubmitting] = useState(false)
  const [manualStatus, setManualStatus] = useState(null)
  const [manualResult, setManualResult] = useState(null)
  const [messageHistory, setMessageHistory] = useState(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyStatus, setHistoryStatus] = useState(null)
  const [replyText, setReplyText] = useState('')
  const [replySubmitting, setReplySubmitting] = useState(false)
  const [replyStatus, setReplyStatus] = useState(null)
  const [expandedEmailId, setExpandedEmailId] = useState(null)
  const subscriberPageCount = Math.max(1, Math.ceil(subscriberTotal / Math.max(1, subscriberPageSize)))
  const normalizedSubscriberPage = clamp(subscriberPage, 1, subscriberPageCount)
  const subscriberPageStartIndex = subscriberRecords.length ? (normalizedSubscriberPage - 1) * subscriberPageSize : 0
  const subscriberPageEndIndex = subscriberRecords.length ? subscriberPageStartIndex + subscriberRecords.length : 0

  useInitialLoaderDismissed()

  const loadSubscriberRecords = useCallback(async (page = 1, emailSearch = subscriberEmailSearch, repliesOnly = subscriberRepliesOnly) => {
    const targetPage = Math.max(1, Math.trunc(Number(page || 1)))
    const normalizedEmailSearch = String(emailSearch || '').trim()
    const params = new URLSearchParams({
      view: 'subscribers',
      page: String(targetPage),
      pageSize: String(SUBSCRIBERS_PER_PAGE),
    })
    if (normalizedEmailSearch) {
      params.set('emailSearch', normalizedEmailSearch)
    }
    if (repliesOnly) {
      params.set('hasSmsReplies', '1')
    }
    setSubscriberLoading(true)
    setSubscriberStatus(null)
    try {
      const response = await fetch(`/api/admin/test-alert?${params.toString()}`, { cache: 'no-store' })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || !Array.isArray(payload.subscribers)) {
        throw new Error(payload.error || 'Could not load subscriber database.')
      }
      setSubscriberRecords(payload.subscribers)
      setSubscriberSummary(normalizeSubscriberSummary(payload.summary || getSubscriberSummary(payload.subscribers)))
      setSubscriberDailyStats(
        payload.dailyStats ? normalizeSubscriberDailyStats(payload.dailyStats) : buildSubscriberDailyStats(payload.subscribers),
      )
      setSubscriberTotal(Number(payload.total || payload.summary?.total || payload.subscribers.length || 0))
      setSubscriberPageSize(Number(payload.pageSize || SUBSCRIBERS_PER_PAGE))
      setSubscriberPage(Number(payload.page || targetPage))
    } catch (error) {
      setSubscriberStatus({
        tone: 'error',
        message: error.message,
      })
    } finally {
      setSubscriberLoading(false)
    }
  }, [subscriberEmailSearch, subscriberRepliesOnly])

  const loadMessageHistory = useCallback(async ({ silent = false } = {}) => {
    const subscriberId = String(historySubscriberId || '').trim()
    if (!subscriberId) {
      setHistoryStatus({ tone: 'error', message: 'Missing subscriber ID.' })
      setMessageHistory(null)
      return
    }

    const params = new URLSearchParams({
      subscriber: subscriberId,
      limit: '250',
    })
    if (!silent) {
      setHistoryLoading(true)
      setHistoryStatus(null)
    }
    try {
      const response = await fetch(`/api/admin/subscriber-history?${params.toString()}`, { cache: 'no-store' })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || 'Could not load subscriber message history.')
      }
      setMessageHistory(payload)
      if (silent) {
        setHistoryStatus(null)
      }
    } catch (error) {
      if (!silent) {
        setMessageHistory(null)
      }
      setHistoryStatus({ tone: 'error', message: error.message })
    } finally {
      if (!silent) {
        setHistoryLoading(false)
      }
    }
  }, [historySubscriberId])

  useEffect(() => {
    const previousTitle = document.title
    document.title =
      adminView === 'subscribers'
        ? 'Subscriber Database'
        : adminView === 'manual'
          ? 'Manual Subscriber'
          : adminView === 'history'
            ? 'Subscriber Message History'
            : 'Test Emergency Alert'
    loadMessagingStatus()

    return () => {
      document.title = previousTitle
    }
  }, [adminView])

  useEffect(() => {
    if (adminView === 'subscribers') {
      loadSubscriberRecords(normalizedSubscriberPage)
    } else if (adminView === 'history') {
      loadMessageHistory()
      const intervalId = window.setInterval(() => {
        loadMessageHistory({ silent: true })
      }, MESSAGE_HISTORY_POLL_INTERVAL_MS)
      return () => {
        window.clearInterval(intervalId)
      }
    } else if (adminView === 'test') {
      loadRecentDeliveries()
    }
    return undefined
  }, [adminView, loadMessageHistory, loadSubscriberRecords, normalizedSubscriberPage])

  useEffect(() => {
    setReplyText('')
    setReplyStatus(null)
    setExpandedEmailId(null)
  }, [historySubscriberId])

  useEffect(() => {
    if (subscriberPage !== normalizedSubscriberPage) {
      setSubscriberPage(normalizedSubscriberPage)
    }
  }, [normalizedSubscriberPage, subscriberPage])

  async function loadRecentDeliveries() {
    try {
      const response = await fetch('/api/admin/test-alert?limit=20', { cache: 'no-store' })
      const payload = await response.json().catch(() => ({}))
      if (response.ok && Array.isArray(payload.deliveries)) {
        setRecentDeliveries(payload.deliveries)
      }
    } catch {
      // The admin page remains usable if the history panel cannot refresh.
    }
  }

  async function loadMessagingStatus() {
    setMessagingStatusLoading(true)
    setMessagingStatusError(null)
    try {
      const response = await fetch('/api/admin/messaging-status', { cache: 'no-store' })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || 'Could not load messaging status.')
      }
      setMessagingStatus(payload)
    } catch (error) {
      setMessagingStatusError(error.message)
    } finally {
      setMessagingStatusLoading(false)
    }
  }

  async function handleSubmit(event) {
    event.preventDefault()

    if (!email.trim() && !phone.trim()) {
      setStatus({
        tone: 'error',
        message: 'Enter a test email address, phone number, or both.',
      })
      return
    }

    setSubmitting(true)
    setStatus({
      tone: 'success',
      message: 'Sending test alert...',
    })

    try {
      const response = await fetch('/api/admin/test-alert', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          email: email.trim(),
          phone: phone.trim(),
        }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(payload.error || 'Could not send test alert.')
      }

      setStatus({
        tone: payload.ok ? 'success' : 'error',
        message: `Alert ${payload.alertId} completed. Email accepted: ${payload.emailSentCount || 0}. SMS accepted: ${
          payload.smsSentCount || 0
        }. Errors: ${payload.errorCount || 0}.`,
      })
      loadRecentDeliveries()
    } catch (error) {
      setStatus({
        tone: 'error',
        message: error.message,
      })
    } finally {
      setSubmitting(false)
    }
  }

  async function handleManualSubmit(event) {
    event.preventDefault()

    const trimmedAccountEmail = manualAccountEmail.trim()
    const trimmedAlertEmail = manualAlertEmail.trim()
    const trimmedPhone = manualPhone.trim()
    let normalizedPhone = ''

    if (!trimmedAccountEmail) {
      setManualStatus({ tone: 'error', message: 'Enter an account email address.' })
      return
    }

    if (trimmedPhone) {
      try {
        normalizedPhone = normalizePhoneInput(trimmedPhone)
      } catch (error) {
        setManualStatus({ tone: 'error', message: error.message })
        return
      }
    }

    if (manualWantsSms && !normalizedPhone) {
      setManualStatus({ tone: 'error', message: 'Enter a phone number before enabling SMS.' })
      return
    }

    if (manualWantsSms && !manualSmsConsent) {
      setManualStatus({ tone: 'error', message: 'Confirm SMS consent before enabling SMS.' })
      return
    }

    setManualSubmitting(true)
    setManualStatus({ tone: 'success', message: 'Creating manual subscriber...' })
    setManualResult(null)

    try {
      const response = await fetch('/api/admin/subscribers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'create_manual',
          accountEmail: trimmedAccountEmail,
          email: trimmedAlertEmail || trimmedAccountEmail,
          phone: normalizedPhone,
          wantsEmail: manualWantsEmail,
          wantsSms: manualWantsSms,
          smsConsent: manualSmsConsent,
          manualNote: manualNote.trim(),
        }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || 'Could not create manual subscriber.')
      }

      const signupConfirmation = payload.signupConfirmation || {}
      setManualResult(payload.subscriber)
      setManualStatus({
        tone: signupConfirmation.ok === false ? 'error' : 'success',
        message: `Manual subscriber created: ${payload.subscriber?.id}. Signup notification email accepted: ${
          signupConfirmation.emailSentCount || 0
        }. SMS accepted: ${signupConfirmation.smsSentCount || 0}. Errors: ${signupConfirmation.errorCount || 0}.`,
      })
    } catch (error) {
      setManualStatus({ tone: 'error', message: error.message })
    } finally {
      setManualSubmitting(false)
    }
  }

  function handleSubscriberSearchSubmit(event) {
    event.preventDefault()
    const nextSearch = subscriberSearchInput.trim()
    setSubscriberEmailSearch(nextSearch)
    setSubscriberPage(1)
    if (nextSearch === subscriberEmailSearch && normalizedSubscriberPage === 1) {
      loadSubscriberRecords(1, nextSearch)
    }
  }

  function clearSubscriberSearch() {
    setSubscriberSearchInput('')
    setSubscriberEmailSearch('')
    setSubscriberPage(1)
    if (!subscriberEmailSearch && normalizedSubscriberPage === 1) {
      loadSubscriberRecords(1, '')
    }
  }

  function handleSubscriberRepliesOnlyChange(event) {
    setSubscriberRepliesOnly(event.target.checked)
    setSubscriberPage(1)
  }

  async function handleReplySubmit(event) {
    event.preventDefault()

    const subscriberId = String(historySubscriberId || '').trim()
    const message = replyText.trim()
    if (!subscriberId) {
      setReplyStatus({ tone: 'error', message: 'Missing subscriber ID.' })
      return
    }
    if (!message) {
      setReplyStatus({ tone: 'error', message: 'Enter a text reply.' })
      return
    }
    if (message.length > ADMIN_REPLY_MAX_LENGTH) {
      setReplyStatus({ tone: 'error', message: `Text replies must be ${ADMIN_REPLY_MAX_LENGTH} characters or fewer.` })
      return
    }

    setReplySubmitting(true)
    setReplyStatus({ tone: 'success', message: 'Sending text reply...' })
    try {
      const response = await fetch('/api/admin/subscriber-history', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          subscriber: subscriberId,
          message,
        }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || 'Could not send text reply.')
      }

      setReplyText('')
      setReplyStatus({
        tone: 'success',
        message: `Text reply sent${payload.providerMessageId ? `: ${payload.providerMessageId}` : '.'}`,
      })
      await loadMessageHistory()
    } catch (error) {
      setReplyStatus({ tone: 'error', message: error.message })
    } finally {
      setReplySubmitting(false)
    }
  }

  const smsConversationMessages = getSmsConversationMessages(messageHistory?.messages)
  const emailHistoryMessages = getEmailHistoryMessages(messageHistory?.messages)
  const canTextReply = Boolean(messageHistory?.subscriber?.phone)
  const replyCharactersRemaining = ADMIN_REPLY_MAX_LENGTH - replyText.length
  const replyDisabled = replySubmitting || !canTextReply || !replyText.trim() || replyText.length > ADMIN_REPLY_MAX_LENGTH
  const toggleExpandedEmail = (messageId) => {
    setExpandedEmailId((current) => (current === messageId ? null : messageId))
  }

  return (
    <>
      <div className="background-wallpaper" style={{ backgroundImage: `url("${BACKGROUND_URL}")` }} aria-hidden="true" />
      <main className="app-shell signup-shell">
        <section className="focus-grid signup-grid">
          <section className="panel hero-copy-panel signup-copy-panel">
            <h1>Notification Admin</h1>
            <p className="hero-caption">
              Manage Access-protected notification testing and subscriber records.
            </p>
            <nav className="admin-tabs" aria-label="Notification admin views">
              <a
                className={adminView === 'test' ? 'admin-tab-active' : ''}
                href="/admin/test-alert"
                aria-current={adminView === 'test' ? 'page' : undefined}
              >
                Test Alert
              </a>
              <a
                className={adminView === 'subscribers' ? 'admin-tab-active' : ''}
                href="/admin"
                aria-current={adminView === 'subscribers' ? 'page' : undefined}
              >
                Subscribers
              </a>
              <a
                className={adminView === 'manual' ? 'admin-tab-active' : ''}
                href="/admin/manual"
                aria-current={adminView === 'manual' ? 'page' : undefined}
              >
                Manual
              </a>
            </nav>
            <p className="hero-credit">
              <a href="/">Dashboard</a>{' '}
              /{' '}
              <a href="/signup">Notification Signup</a>
            </p>
          </section>

          {adminView === 'test' ? (
            <section className="panel signup-panel" aria-labelledby="admin-test-form-title">
              <div className="panel-header">
                <div>
                  <h2 id="admin-test-form-title">Alert Test</h2>
                </div>
              </div>
              <section className="messaging-status-card" aria-label="SMS sender status">
                <div className="messaging-status-heading">
                  <div>
                    <h3>SMS Sender</h3>
                    <p>
                      {messagingStatusLoading
                        ? 'Checking Telnyx...'
                        : messagingStatus?.checkedAt
                          ? `Checked ${new Date(messagingStatus.checkedAt).toLocaleString()}`
                          : 'Status not loaded'}
                    </p>
                  </div>
                  <button type="button" onClick={loadMessagingStatus} disabled={messagingStatusLoading}>
                    {messagingStatusLoading ? 'Checking...' : 'Refresh'}
                  </button>
                </div>

                {messagingStatusError ? (
                  <p className="signup-status signup-status-error">{messagingStatusError}</p>
                ) : messagingStatus ? (
                  <>
                    <div className="messaging-status-grid">
                      <span>Ready: {messagingStatus.readyForSms ? 'yes' : 'no'}</span>
                      <span>Send method: {formatMessagingStatusLabel(messagingStatus.sendMethod)}</span>
                      <span>Messaging profile: {formatMessagingStatusLabel(messagingStatus.messagingProfile?.status)}</span>
                      <span>Sender: {formatAdminValue(messagingStatus.sender?.number)}</span>
                      <span>Sender found: {formatAdminValue(messagingStatus.sender?.foundInAccount)}</span>
                      <span>SMS capable: {formatAdminValue(messagingStatus.sender?.smsCapable)}</span>
                      <span>Toll-free: {formatAdminValue(messagingStatus.sender?.isTollFree)}</span>
                      <span>Profile ID: {formatAdminValue(messagingStatus.messagingProfile?.id)}</span>
                      <span>Webhook v2: {formatAdminValue(messagingStatus.messagingProfile?.webhookApiVersion === '2')}</span>
                      <span>Signature key: {formatAdminValue(messagingStatus.webhooks?.publicKeyConfigured)}</span>
                    </div>
                    {messagingStatus.blockingIssue ? (
                      <p className="signup-status signup-status-error">{messagingStatus.blockingIssue}</p>
                    ) : messagingStatus.webhookWarning ? (
                      <p className="signup-status signup-status-error">{messagingStatus.webhookWarning}</p>
                    ) : (
                      <p className="signup-status signup-status-success">Telnyx sender configuration looks ready.</p>
                    )}
                  </>
                ) : null}
              </section>
              <form className="signup-form" onSubmit={handleSubmit}>
                <label className="signup-field">
                  <span>Email address</span>
                  <input
                    type="email"
                    name="email"
                    value={email}
                    autoComplete="email"
                    placeholder="you@example.com"
                    onChange={(event) => setEmail(event.target.value)}
                  />
                </label>

                <label className="signup-field">
                  <span>Phone number</span>
                  <input
                    type="tel"
                    name="phone"
                    value={phone}
                    autoComplete="tel"
                    inputMode="tel"
                    placeholder="+1 415 555 2671"
                    onChange={(event) => setPhone(event.target.value)}
                  />
                </label>

                <button className="signup-submit" type="submit" disabled={submitting}>
                  {submitting ? 'Sending...' : 'Send Test Alert'}
                </button>

                {status ? (
                  <p className={`signup-status signup-status-${status.tone}`} role="status">
                    {status.message}
                  </p>
                ) : null}
              </form>

              {recentDeliveries.length > 0 ? (
                <div className="delivery-history" aria-label="Recent delivery status">
                  <h3>Recent Delivery Status</h3>
                  <div className="delivery-history-list">
                    {recentDeliveries.map((delivery, index) => (
                      <div
                        className="delivery-history-row"
                        key={`${delivery.alert_id}-${delivery.provider_message_id || index}`}
                      >
                        <div>
                          <strong>{delivery.channel || delivery.kind}</strong>
                          <span>{delivery.delivery_status || delivery.alert_status}</span>
                        </div>
                        <div>
                          <span>{delivery.provider_message_id || delivery.alert_id}</span>
                          {delivery.error ? <em>{delivery.error}</em> : null}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </section>
          ) : adminView === 'history' ? (
            <section className="panel signup-panel admin-message-history-panel admin-wide-panel" aria-labelledby="subscriber-history-title">
              <div className="panel-header">
                <div>
                  <h2 id="subscriber-history-title">Message History</h2>
                </div>
                <div className="subscriber-actions">
                  <button className="signup-submit" type="button" onClick={loadMessageHistory} disabled={historyLoading}>
                    {historyLoading ? 'Loading...' : 'Refresh'}
                  </button>
                </div>
              </div>

              {historyStatus ? (
                <p className={`signup-status signup-status-${historyStatus.tone}`} role="status">
                  {historyStatus.message}
                </p>
              ) : null}

              {historyLoading && !messageHistory ? <p className="empty-state">Loading message history...</p> : null}

              {messageHistory?.subscriber ? (
                <div className="history-contact-summary" aria-label="Subscriber contact summary">
                  <strong>{formatAdminValue(messageHistory.subscriber.accountEmail || messageHistory.subscriber.email || messageHistory.subscriber.phone)}</strong>
                  <span>Subscriber: {messageHistory.subscriber.id}</span>
                  <span>Alert email: {formatAdminValue(messageHistory.subscriber.email)}</span>
                  <span>Account email: {formatAdminValue(messageHistory.subscriber.accountEmail)}</span>
                  <span>Phone: {formatAdminValue(messageHistory.subscriber.phone)}</span>
                  <span>Status: {formatAdminValue(messageHistory.subscriber.status)}</span>
                  <span>SMS replies: {formatAdminValue(messageHistory.subscriber.smsReplyCount)}</span>
                  <span>Last SMS reply: {formatAdminValue(messageHistory.subscriber.lastSmsReplyAt)}</span>
                  {messageHistory.subscriber.managementUrl ? (
                    <a href={messageHistory.subscriber.managementUrl}>Edit notification settings</a>
                  ) : null}
                </div>
              ) : null}

              {messageHistory && !historyLoading ? (
                <section className="sms-history-card" aria-labelledby="sms-history-title">
                  <div className="gmail-history-toolbar">
                    <h3 id="sms-history-title">SMS History</h3>
                    <span>{smsConversationMessages.length}</span>
                  </div>
                  {smsConversationMessages.length ? (
                    <div className="sms-conversation" aria-label="SMS conversation">
                      {smsConversationMessages.map((message) => {
                        const isOutbound = message.direction === 'outbound'
                        const deliveryStatus = formatMessageDeliveryStatus(message)
                        return (
                          <article
                            className={`sms-message-row ${isOutbound ? 'sms-message-outbound' : 'sms-message-inbound'}`}
                            key={`${message.direction}-${message.id}`}
                            title={formatMessageHistoryTime(message.occurredAt)}
                            aria-label={`${formatMessageHistoryLabel(message.direction)} SMS, ${formatMessageHistoryTime(message.occurredAt)}`}
                          >
                            <div className="sms-bubble">
                              {message.messageText ? (
                                <p>{message.messageText}</p>
                              ) : (
                                <p className="sms-empty-text">No message text</p>
                              )}
                              {message.action && !isOutbound ? (
                                <span className="sms-message-action">{formatMessageHistoryLabel(message.action)}</span>
                              ) : null}
                              {message.error ? <em>{message.error}</em> : null}
                            </div>
                            {isOutbound ? (
                              <span className={`sms-delivery-status ${isMessageDeliveryError(message) ? 'sms-delivery-status-error' : ''}`}>
                                {deliveryStatus}
                              </span>
                            ) : null}
                          </article>
                        )
                      })}
                    </div>
                  ) : (
                    <p className="empty-state sms-history-empty">No SMS message history found for this subscriber.</p>
                  )}

                  {messageHistory.subscriber ? (
                    <form className="sms-reply-form" onSubmit={handleReplySubmit}>
                      <label className="signup-field">
                        <span>Text reply</span>
                        <textarea
                          value={replyText}
                          maxLength={ADMIN_REPLY_MAX_LENGTH}
                          rows={3}
                          disabled={replySubmitting || !canTextReply}
                          onChange={(event) => setReplyText(event.target.value)}
                        />
                      </label>
                      <div className="sms-reply-actions">
                        <button className="signup-submit" type="submit" disabled={replyDisabled}>
                          {replySubmitting ? 'Sending...' : 'Send Reply'}
                        </button>
                        <span className={replyCharactersRemaining < 0 ? 'sms-reply-count sms-reply-count-error' : 'sms-reply-count'}>
                          {replyCharactersRemaining}
                        </span>
                      </div>
                      {!canTextReply ? (
                        <p className="signup-status signup-status-error">This subscriber does not have a phone number.</p>
                      ) : null}
                      {replyStatus ? (
                        <p className={`signup-status signup-status-${replyStatus.tone}`} role="status">
                          {replyStatus.message}
                        </p>
                      ) : null}
                    </form>
                  ) : null}
                </section>
              ) : null}

              {messageHistory && !historyLoading ? (
                <section className="gmail-history" aria-labelledby="email-history-title">
                  <div className="gmail-history-toolbar">
                    <h3 id="email-history-title">Sent Email History</h3>
                    <span>{emailHistoryMessages.length}</span>
                  </div>
                  {emailHistoryMessages.length ? (
                    <div className="gmail-message-list">
                      {emailHistoryMessages.map((message) => {
                        const messageKey = `${message.direction}-${message.id}`
                        const isExpanded = expandedEmailId === messageKey
                        return (
                          <article className={`gmail-message-row ${isExpanded ? 'gmail-message-row-expanded' : ''}`} key={messageKey}>
                            <button
                              className="gmail-message-summary"
                              type="button"
                              title={formatMessageHistoryTime(message.occurredAt)}
                              aria-expanded={isExpanded}
                              onClick={() => toggleExpandedEmail(messageKey)}
                            >
                              <div className="gmail-sender-avatar" aria-hidden="true">
                                A
                              </div>
                              <div className="gmail-message-main">
                                <div className="gmail-message-header">
                                  <strong>Apocalypse EWS</strong>
                                  <span>to {formatAdminValue(messageHistory.subscriber?.email || messageHistory.subscriber?.accountEmail)}</span>
                                </div>
                                <p>
                                  <strong>{formatEmailSubject(message)}</strong>
                                  <span>{formatEmailPreview(message)}</span>
                                </p>
                                {message.error ? <em>{message.error}</em> : null}
                              </div>
                              <div className="gmail-message-meta">
                                <time dateTime={message.occurredAt || undefined}>{formatMessageHistoryTime(message.occurredAt)}</time>
                                <span className={isMessageDeliveryError(message) ? 'gmail-status gmail-status-error' : 'gmail-status'}>
                                  {formatMessageDeliveryStatus(message)}
                                </span>
                              </div>
                            </button>
                            {isExpanded ? (
                              <div className="gmail-message-body">
                                <pre>{formatEmailBody(message)}</pre>
                              </div>
                            ) : null}
                          </article>
                        )
                      })}
                    </div>
                  ) : (
                    <p className="empty-state">No sent email history found for this subscriber.</p>
                  )}
                </section>
              ) : null}
            </section>
          ) : adminView === 'manual' ? (
            <section className="panel signup-panel" aria-labelledby="manual-subscriber-title">
              <div className="panel-header">
                <div>
                  <h2 id="manual-subscriber-title">Manual Subscriber</h2>
                </div>
              </div>

              <form className="signup-form" onSubmit={handleManualSubmit}>
                <label className="signup-field">
                  <span>Account email</span>
                  <input
                    type="email"
                    value={manualAccountEmail}
                    autoComplete="email"
                    placeholder="you@example.com"
                    onChange={(event) => setManualAccountEmail(event.target.value)}
                  />
                </label>

                <label className="signup-field">
                  <span>Alert email</span>
                  <input
                    type="email"
                    value={manualAlertEmail}
                    autoComplete="email"
                    placeholder="you@example.com"
                    onChange={(event) => setManualAlertEmail(event.target.value)}
                  />
                </label>

                <label className="signup-field">
                  <span>Phone number</span>
                  <input
                    type="tel"
                    value={manualPhone}
                    autoComplete="tel"
                    inputMode="tel"
                    placeholder="+1 415 555 2671"
                    onChange={(event) => setManualPhone(event.target.value)}
                  />
                </label>

                <label className="signup-field">
                  <span>Note</span>
                  <input
                    type="text"
                    value={manualNote}
                    placeholder="testing"
                    onChange={(event) => setManualNote(event.target.value)}
                  />
                </label>

                <label className="signup-consent">
                  <input
                    type="checkbox"
                    checked={manualWantsEmail}
                    onChange={(event) => setManualWantsEmail(event.target.checked)}
                  />
                  <span>Email alerts enabled</span>
                </label>

                <label className="signup-consent">
                  <input
                    type="checkbox"
                    checked={manualWantsSms}
                    onChange={(event) => setManualWantsSms(event.target.checked)}
                  />
                  <span>SMS alerts enabled</span>
                </label>

                <label className="signup-consent">
                  <input
                    type="checkbox"
                    checked={manualSmsConsent}
                    onChange={(event) => setManualSmsConsent(event.target.checked)}
                  />
                  <span>SMS consent confirmed</span>
                </label>

                <button className="signup-submit" type="submit" disabled={manualSubmitting}>
                  {manualSubmitting ? 'Creating...' : 'Create Manual Subscriber'}
                </button>

                {manualStatus ? (
                  <p className={`signup-status signup-status-${manualStatus.tone}`} role="status">
                    {manualStatus.message}
                  </p>
                ) : null}
              </form>

              {manualResult ? (
                <div className="manual-result" aria-label="Manual subscriber result">
                  <strong>{manualResult.id}</strong>
                  <span>Account: {formatAdminValue(manualResult.accountEmail)}</span>
                  <span>Alert email: {formatAdminValue(manualResult.email)}</span>
                  <span>Phone: {formatAdminValue(manualResult.phone)}</span>
                  <span>Email alerts: {formatAdminValue(manualResult.wantsEmail)}</span>
                  <span>SMS alerts: {formatAdminValue(manualResult.wantsSms)}</span>
                  {manualResult.managementUrl ? <a href={manualResult.managementUrl}>Management link</a> : null}
                </div>
              ) : null}
            </section>
          ) : (
            <section className="panel signup-panel admin-subscriber-panel admin-wide-panel" aria-labelledby="subscriber-table-title">
              <div className="panel-header">
                <div>
                  <h2 id="subscriber-table-title">Subscriber Database</h2>
                </div>
                <button
                  className="signup-submit"
                  type="button"
                  onClick={() => loadSubscriberRecords(normalizedSubscriberPage)}
                  disabled={subscriberLoading}
                >
                  {subscriberLoading ? 'Loading...' : 'Refresh'}
                </button>
              </div>

              {subscriberStatus ? (
                <p className={`signup-status signup-status-${subscriberStatus.tone}`} role="status">
                  {subscriberStatus.message}
                </p>
              ) : null}

              <form className="subscriber-search-form" onSubmit={handleSubscriberSearchSubmit}>
                <label className="signup-field subscriber-search-field">
                  <span>Email or phone search</span>
                  <input
                    type="search"
                    value={subscriberSearchInput}
                    placeholder="exact or partial email/phone"
                    autoComplete="off"
                    onChange={(event) => setSubscriberSearchInput(event.target.value)}
                  />
                </label>
                <button className="signup-submit" type="submit" disabled={subscriberLoading}>
                  Search
                </button>
                {subscriberEmailSearch ? (
                  <button className="subscriber-search-clear" type="button" disabled={subscriberLoading} onClick={clearSubscriberSearch}>
                    Clear
                  </button>
                ) : null}
                <label className="signup-consent subscriber-filter-toggle">
                  <input
                    type="checkbox"
                    checked={subscriberRepliesOnly}
                    disabled={subscriberLoading}
                    onChange={handleSubscriberRepliesOnlyChange}
                  />
                  <span>SMS replies only</span>
                </label>
              </form>

              {subscriberEmailSearch || subscriberRepliesOnly ? (
                <p className="subscriber-search-note">
                  {subscriberEmailSearch ? (
                    <>
                      Search: <strong>{subscriberEmailSearch}</strong>
                    </>
                  ) : null}
                  {subscriberEmailSearch && subscriberRepliesOnly ? ' / ' : null}
                  {subscriberRepliesOnly ? <strong>SMS replies only</strong> : null}
                </p>
              ) : null}

              <div className="admin-summary-grid" aria-label="Subscriber summary">
                <span>Total: {subscriberSummary.total}</span>
                <span>Active: {subscriberSummary.active}</span>
                <span>Pending: {subscriberSummary.pending_checkout}</span>
                <span>Past due: {subscriberSummary.past_due}</span>
                <span>Canceled: {subscriberSummary.canceled}</span>
                <span>Email: {subscriberSummary.wantsEmail}</span>
                <span>SMS: {subscriberSummary.wantsSms}</span>
                <span>Both: {subscriberSummary.wantsBoth}</span>
                <span>SMS replies: {subscriberSummary.smsReplies}</span>
                <span>Gross: {formatGrossVolume(subscriberSummary.active * SUBSCRIPTION_GROSS_DOLLARS)}</span>
              </div>

              <div className="subscriber-chart-grid" aria-label="Subscriber daily charts">
                <SubscriberDailyChart
                  title="Daily Subscription Status"
                  data={subscriberDailyStats}
                  series={[
                    { key: 'active', label: 'Active', color: '#00703c' },
                    { key: 'pending', label: 'Pending', color: '#8a5a00' },
                    { key: 'canceled', label: 'Canceled', color: '#b00020' },
                  ]}
                />
                <SubscriberDailyChart
                  title="Daily Contact Channels"
                  data={subscriberDailyStats}
                  series={[
                    { key: 'email', label: 'Email', color: '#0000ee' },
                    { key: 'sms', label: 'SMS', color: '#7b2cbf' },
                    { key: 'both', label: 'Both', color: '#008c8c' },
                  ]}
                />
                <SubscriberDailyChart
                  title="Daily Gross Volume"
                  data={subscriberDailyStats}
                  valueFormatter={formatGrossVolume}
                  series={[{ key: 'grossVolume', label: 'Active x $5', color: '#111111' }]}
                />
              </div>

              {subscriberRecords.length ? (
                <>
                  <div className="subscriber-pagination" aria-label="Subscriber pagination">
                    <span>
                      Showing {subscriberPageStartIndex + 1}-{subscriberPageEndIndex} of {subscriberTotal}
                    </span>
                    <div>
                      <button
                        type="button"
                        disabled={normalizedSubscriberPage <= 1}
                        onClick={() => setSubscriberPage((page) => Math.max(1, page - 1))}
                      >
                        Previous
                      </button>
                      <span>
                        Page {normalizedSubscriberPage} of {subscriberPageCount}
                      </span>
                      <button
                        type="button"
                        disabled={normalizedSubscriberPage >= subscriberPageCount}
                        onClick={() => setSubscriberPage((page) => Math.min(subscriberPageCount, page + 1))}
                      >
                        Next
                      </button>
                    </div>
                  </div>
                  <div className="subscriber-table-wrap">
                    <table className="subscriber-table">
                      <thead>
                        <tr>
                          <th scope="col">Contact</th>
                          <th scope="col">Status</th>
                          <th scope="col">Stripe</th>
                          <th scope="col">Dates</th>
                          <th scope="col">Deliveries</th>
                          <th scope="col">Actions</th>
                          <th scope="col">All Fields</th>
                        </tr>
                      </thead>
                      <tbody>
                        {subscriberRecords.map((subscriber) => (
                          <tr key={subscriber.id}>
                            <td>
                              <strong>{formatAdminValue(subscriber.accountEmail || subscriber.email || subscriber.phone)}</strong>
                              <span>Alert: {formatAdminValue(subscriber.email)}</span>
                              <span>{formatAdminValue(subscriber.email && subscriber.phone ? subscriber.phone : null)}</span>
                              <span>{subscriber.id}</span>
                            </td>
                            <td>
                              <strong>{formatAdminValue(subscriber.status)}</strong>
                              <span>Source: {formatAdminValue(subscriber.source)}</span>
                              <span>Email: {formatAdminValue(subscriber.wantsEmail)}</span>
                              <span>SMS: {formatAdminValue(subscriber.wantsSms)}</span>
                            </td>
                            <td>
                              <span>Customer: {formatAdminValue(subscriber.stripeCustomerId)}</span>
                              <span>Subscription: {formatAdminValue(subscriber.stripeSubscriptionId)}</span>
                              <span>Checkout: {formatAdminValue(subscriber.stripeCheckoutSessionId)}</span>
                            </td>
                            <td>
                              <span>Created: {formatAdminValue(subscriber.createdAt)}</span>
                              <span>Updated: {formatAdminValue(subscriber.updatedAt)}</span>
                              <span>Period end: {formatAdminValue(subscriber.currentPeriodEnd)}</span>
                            </td>
                            <td>
                              <span>Total: {formatAdminValue(subscriber.deliveryCount)}</span>
                              <span>Email: {formatAdminValue(subscriber.emailDeliveryCount)}</span>
                              <span>SMS: {formatAdminValue(subscriber.smsDeliveryCount)}</span>
                              <span>Errors: {formatAdminValue(subscriber.deliveryErrorCount)}</span>
                              <span>Replies: {formatAdminValue(subscriber.smsReplyCount)}</span>
                              <span>Last reply: {formatAdminValue(subscriber.lastSmsReplyAt)}</span>
                            </td>
                            <td>
                              <div className="subscriber-actions">
                                {subscriber.managementUrl ? (
                                  <a className="subscriber-action-link" href={subscriber.managementUrl}>
                                    Edit
                                  </a>
                                ) : (
                                  <span>{formatAdminValue(null)}</span>
                                )}
                                <a
                                  className="subscriber-action-link"
                                  href={`/admin/history?subscriber=${encodeURIComponent(subscriber.id)}`}
                                >
                                  History
                                </a>
                              </div>
                            </td>
                            <td>
                              <details className="subscriber-details">
                                <summary>View</summary>
                                <dl>
                                  {getSubscriberFields(subscriber).map(([key, value]) => (
                                    <div key={key}>
                                      <dt>{key}</dt>
                                      <dd>{formatAdminValue(value)}</dd>
                                    </div>
                                  ))}
                                </dl>
                              </details>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : !subscriberLoading ? (
                <p className="empty-state">No subscriber records found.</p>
              ) : null}
            </section>
          )}
        </section>
      </main>
    </>
  )
}

function DashboardApp({ dashboardUrl = DASHBOARD_URL, enableCohortControls = false, primaryCohortKind = 'business' }) {
  const [dashboard, setDashboard] = useState(null)
  const [error, setError] = useState(null)
  const [selectedCohorts, setSelectedCohorts] = useState(() => ({
    business: true,
    military: false,
    untracked: false,
  }))
  const [extraDashboards, setExtraDashboards] = useState({})
  const [extraDashboardErrors, setExtraDashboardErrors] = useState({})
  const [loadingCohorts, setLoadingCohorts] = useState({})
  const [backgroundReady, setBackgroundReady] = useState(false)
  const [manualEmergencySchemeEnabled, setManualEmergencySchemeEnabled] = useState(false)
  const emergencySchemeTapTimesRef = useRef([])
  const extraDashboardsRef = useRef({})

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
        const nextDashboard = await fetchDashboardSnapshot(dashboardUrl)
        if (active) {
          applyDashboard(nextDashboard)
        }
      } catch (nextError) {
        logDashboardLoadError('Primary dashboard load failed', nextError)
        if (active) {
          setError(getDashboardLoadErrorMessage(nextError))
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

  useEffect(() => {
    extraDashboardsRef.current = extraDashboards
  }, [extraDashboards])

  useEffect(() => {
    if (!enableCohortControls) {
      return undefined
    }

    const selectedExtraConfigs = COHORT_CONFIGS.filter(
      (config) => config.id !== primaryCohortKind && selectedCohorts[config.id],
    )
    if (!selectedExtraConfigs.length) {
      return undefined
    }

    let active = true

    async function loadExtraDashboard(config) {
      let loadingTimerId = null
      const hasCachedDashboard = Boolean(extraDashboardsRef.current[config.id])

      if (!hasCachedDashboard) {
        loadingTimerId = window.setTimeout(() => {
          if (!active || extraDashboardsRef.current[config.id]) {
            return
          }

          setLoadingCohorts((current) => ({ ...current, [config.id]: true }))
        }, COHORT_LOADING_DELAY_MS)
      }

      try {
        const nextDashboard = await fetchDashboardSnapshot(config.dashboardUrl)
        if (!active) {
          return
        }

        startTransition(() => {
          setExtraDashboards((current) => ({ ...current, [config.id]: nextDashboard }))
          setExtraDashboardErrors((current) => ({ ...current, [config.id]: null }))
        })
      } catch (nextError) {
        logDashboardLoadError(`${config.label} dashboard load failed`, nextError)
        if (active) {
          setExtraDashboardErrors((current) => ({ ...current, [config.id]: getDashboardLoadErrorMessage(nextError) }))
        }
      } finally {
        if (loadingTimerId) {
          window.clearTimeout(loadingTimerId)
        }

        if (active) {
          setLoadingCohorts((current) =>
            current[config.id] ? { ...current, [config.id]: false } : current,
          )
        }
      }
    }

    function loadSelectedExtraDashboards() {
      for (const config of selectedExtraConfigs) {
        void loadExtraDashboard(config)
      }
    }

    loadSelectedExtraDashboards()
    const intervalId = window.setInterval(loadSelectedExtraDashboards, DASHBOARD_POLL_INTERVAL_MS)

    return () => {
      active = false
      window.clearInterval(intervalId)
    }
  }, [
    enableCohortControls,
    primaryCohortKind,
    selectedCohorts,
  ])

  const handleCohortToggle = useCallback((cohortId) => {
    setSelectedCohorts((current) => {
      const next = { ...current, [cohortId]: !current[cohortId] }
      const hasAnySelected = Object.values(next).some(Boolean)
      if (!hasAnySelected) {
        return current
      }

      if (!next[primaryCohortKind]) {
        const hasLoadedSelectedDashboard = Object.entries(next).some(([selectedCohortId, isSelected]) => {
          if (!isSelected) {
            return false
          }

          return selectedCohortId === primaryCohortKind || Boolean(extraDashboards[selectedCohortId])
        })

        if (!hasLoadedSelectedDashboard) {
          return current
        }
      }

      return next
    })
  }, [extraDashboards, primaryCohortKind])

  const effectiveSelectedCohorts = useMemo(
    () => (enableCohortControls ? selectedCohorts : { [primaryCohortKind]: true }),
    [enableCohortControls, primaryCohortKind, selectedCohorts],
  )
  const visibleDashboard = useMemo(
    () =>
      dashboard
        ? buildCombinedDashboardView(dashboard, effectiveSelectedCohorts, extraDashboards, primaryCohortKind)
        : null,
    [
      dashboard,
      effectiveSelectedCohorts,
      extraDashboards,
      primaryCohortKind,
    ],
  )
  const cohortControls = enableCohortControls
    ? {
        options: COHORT_CONFIGS,
        selected: selectedCohorts,
        loading: loadingCohorts,
        errors: extraDashboardErrors,
        onToggle: handleCohortToggle,
      }
    : null

  const shouldShowLoading = (!dashboard && !error) || (Boolean(dashboard) && !backgroundReady)

  useEffect(() => {
    if (shouldShowLoading) {
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

  const currentSignal = visibleDashboard?.signals?.composite ?? visibleDashboard?.current ?? null
  const currentEmergencyLevel = getEmergencyLevel(currentSignal)
  const emergencySchemeActive = manualEmergencySchemeEnabled || currentEmergencyLevel === EMERGENCY_LEVEL_COUNT

  useEffect(() => {
    document.documentElement.classList.toggle('emergency-color-scheme', emergencySchemeActive)

    return () => {
      document.documentElement.classList.remove('emergency-color-scheme')
    }
  }, [emergencySchemeActive])

  let content = null

  if (shouldShowLoading) {
    content = document.getElementById('initial-loader') ? null : <LoadingAnimation />
  } else {
    const hasDashboard = Boolean(visibleDashboard)
    const dashboardErrorMessage = error || 'The latest dashboard snapshot could not be loaded.'
    const archiveData = visibleDashboard?.trends?.archive ?? []
    const holidayWindows = visibleDashboard?.trends?.holidayWindows ?? []
    const liveAircraft = visibleDashboard?.liveAircraft ?? []
    const liveStatus = visibleDashboard?.liveStatus ?? null
    const cohortCopy = getCohortCopy(visibleDashboard?.cohort)
    const adsbDataStatus = hasDashboard
      ? getAdsbDataUnavailableStatus(liveStatus)
      : { isUnavailable: true, isStale: true, ageMs: null }
    const compositeSignal = visibleDashboard?.signals?.composite ?? (visibleDashboard?.current ? {
      asOf: visibleDashboard.current?.asOf,
      actualConcurrentCount: visibleDashboard.current?.concurrentCount,
      expectedConcurrentCount: visibleDashboard.current?.baselineMean,
      expectedConcurrentStdDev: visibleDashboard.current?.baselineStdDev,
      sigmaShift: visibleDashboard.current?.zScore,
      alertLevel: visibleDashboard.current?.alertLevel,
      emergencyLevel: visibleDashboard.current?.emergencyLevel,
    } : null)
    const seatEstimateAircraft =
      cohortCopy.kind === 'combined'
        ? liveAircraft.filter((plane) => plane.cohortKind === 'business')
        : liveAircraft
    const businessActualCount =
      hasDashboard && selectedCohorts.business
        ? dashboard.signals?.composite?.actualConcurrentCount ?? dashboard.current?.concurrentCount
        : null
    const maxSeatsAirborneEstimate =
      hasDashboard && cohortCopy.showSeatEstimate
        ? estimateMaxSeatsAirborne(
            seatEstimateAircraft,
            cohortCopy.kind === 'combined' ? businessActualCount : compositeSignal?.actualConcurrentCount,
          )
        : null
    const loadingCohortLabels = enableCohortControls
      ? COHORT_CONFIGS
          .filter((config) => selectedCohorts[config.id] && loadingCohorts[config.id] && !extraDashboards[config.id])
          .map((config) => config.label)
      : []
    const erroredCohortLabels = enableCohortControls
      ? COHORT_CONFIGS
          .filter((config) => selectedCohorts[config.id] && extraDashboardErrors[config.id])
          .map((config) => config.label)
      : []

    content = (
      <main className="app-shell">
        <p className="signup-provider-notice homepage-signup-notice">
          <a href="/signup">Sign up</a> for text message or email notifications.
        </p>

        {error && !hasDashboard ? (
          <section className="status-banner status-banner-error">
            <strong>Dashboard data unavailable.</strong>
            <span>{dashboardErrorMessage}</span>
          </section>
        ) : null}

        {error && hasDashboard ? (
          <section className="status-banner status-banner-error">
            <strong>Live refresh failed.</strong>
            <span>{dashboardErrorMessage} The currently displayed snapshot remains visible.</span>
          </section>
        ) : null}

        {hasDashboard && visibleDashboard.warning ? (
          <section className="status-banner">
            <strong>{visibleDashboard.mode === 'demo' ? 'Demo mode.' : 'Configuration required.'}</strong>
            <span>{visibleDashboard.warning}</span>
          </section>
        ) : null}

        {hasDashboard && !visibleDashboard.warning && !liveStatus?.latestSampledAt ? (
          <section className="status-banner">
            <strong>No recent sweep.</strong>
            <span>The backend polls the newest heatmap every 30 minutes and serves the latest cached sample.</span>
          </section>
        ) : null}

        {adsbDataStatus.isUnavailable && liveStatus?.lastError ? (
          <section className="status-banner">
            <strong>Refresh error.</strong>
            <span>
              {liveStatus.lastError}
              {liveStatus.nextRefreshAt ? ` Next sweep: ${formatTimestamp(liveStatus.nextRefreshAt)}.` : ''}
            </span>
          </section>
        ) : null}

        {loadingCohortLabels.length ? (
          <section className="status-banner">
            <strong>Loading selected category.</strong>
            <span>{loadingCohortLabels.join(', ')} will be included as soon as its dashboard snapshot arrives.</span>
          </section>
        ) : null}

        {erroredCohortLabels.length ? (
          <section className="status-banner">
            <strong>Category unavailable.</strong>
            <span>{erroredCohortLabels.join(', ')} could not be loaded for the combined view.</span>
          </section>
        ) : null}

        <section className="focus-grid">
          <section className="panel hero-copy-panel">
            <h1>Apocalypse Early Warning System</h1>
            <p className="hero-caption">
              {cohortCopy.heroCaption}
            </p>
            <p className="hero-credit">
              built by{' '}
              <a href="https://www.instagram.com/kcimc/" target="_blank" rel="noreferrer">
                Kyle McDonald
              </a>
            </p>
            <p className="hero-credit hero-link-row">
              <a href="https://github.com/kylemcdonald/ews" target="_blank" rel="noreferrer">
                GitHub
              </a>{' '}
              /{' '}
              <a href="https://t.me/apocalypse_ews" target="_blank" rel="noreferrer">
                Telegram
              </a>{' '}
              /{' '}
              <a href="https://ews.kylemcdonald.net/rss.xml" target="_blank" rel="noreferrer">
                RSS
              </a>{' '}
              /{' '}
              <a href={DISCORD_BOT_URL} target="_blank" rel="noreferrer">
                Discord
              </a>
            </p>
          </section>
          <div className="dial-stack">
            {hasDashboard ? (
              <EmergencySummary
                signal={compositeSignal}
                latestSweep={formatTimestamp(visibleDashboard.current?.asOf)}
                actualCount={compositeSignal?.actualConcurrentCount}
                expectedCount={compositeSignal?.expectedConcurrentCount}
                trackedCount={visibleDashboard.cohort?.trackedCount ?? visibleDashboard.watchlist?.trackedCount}
                maxSeatsAirborneEstimate={maxSeatsAirborneEstimate}
                onEmergencyLevelTap={handleEmergencyLevelTap}
              />
            ) : (
              <DataUnavailablePanel title="Dashboard Data Unavailable" message={dashboardErrorMessage} />
            )}
          </div>
        </section>

        <section className="focus-map-grid">
          {hasDashboard ? (
            <GlobalMap
              aircraft={liveAircraft}
              dataUnavailable={adsbDataStatus.isUnavailable}
              liveStatus={liveStatus}
            />
          ) : (
            <DataUnavailablePanel title="Realtime Tracker Unavailable" message={dashboardErrorMessage} />
          )}
        </section>

        <section className="details-stack">
          {hasDashboard ? (
            <>
              <ArchiveChart
                data={archiveData}
                signal={compositeSignal}
                holidayWindows={holidayWindows}
                cohortControls={cohortControls}
              />
              <ModelSummaryList aircraft={liveAircraft} copy={cohortCopy} />
            </>
          ) : (
            <>
              <DataUnavailablePanel title="Traffic Archive Unavailable" message={dashboardErrorMessage} />
              <DataUnavailablePanel title="Aircraft Summary Unavailable" message={dashboardErrorMessage} />
            </>
          )}
          <AboutSystemCard cohort={visibleDashboard?.cohort} copy={cohortCopy} />
          <FaqCard />
          <UpdatesCard copy={cohortCopy} />
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
  if (window.location.pathname === '/event-signals' || window.location.pathname.startsWith('/event-signals/')) {
    return (
      <Suspense fallback={null}>
        <EventSignalExplainer />
      </Suspense>
    )
  }

  if (window.location.pathname.startsWith('/admin/test-alert/')) {
    const nextPath = window.location.pathname.startsWith('/admin/test-alert/subscribers')
      ? '/admin'
      : '/admin/test-alert'
    window.history.replaceState(null, '', `${nextPath}${window.location.search}${window.location.hash}`)
    return <AdminTestAlertPage />
  }

  if (window.location.pathname === '/signup' || window.location.pathname.startsWith('/signup/')) {
    return <SignupPage />
  }

  if (window.location.pathname === '/manage' || window.location.pathname.startsWith('/manage/')) {
    return <ManageSubscriptionPage />
  }

  if (
    window.location.pathname === '/admin' ||
    window.location.pathname === '/admin/subscribers' ||
    window.location.pathname === '/admin/test-alert' ||
    window.location.pathname === '/admin/manual' ||
    window.location.pathname === '/admin/history'
  ) {
    return <AdminTestAlertPage />
  }

  return <DashboardApp dashboardUrl={DASHBOARD_URL} enableCohortControls primaryCohortKind="business" />
}

export default App
