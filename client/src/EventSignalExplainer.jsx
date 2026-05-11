import { useEffect, useMemo, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import './EventSignalExplainer.css'

const DATA_URL = '/localized_event_signal_research.json'
const MAP_STYLE = {
  version: 8,
  sources: {
    carto: {
      type: 'raster',
      tiles: [
        'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
        'https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
        'https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
      ],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors © CARTO',
    },
  },
  layers: [
    {
      id: 'carto',
      type: 'raster',
      source: 'carto',
    },
  ],
}
const CONUS_BOUNDS = [[-126, 24], [-66, 50]]
const SVG_MAP_WIDTH = 1000
const SVG_MAP_HEIGHT = 520
const SVG_MAP_PADDING = 38
const MILES_PER_DEGREE_LAT = 69
const MODE_CONFIG = {
  takeoff: {
    label: 'Departures',
    color: '#d84735',
    summaryKey: 'takeoff_summary',
    endpointSummaryKey: 'takeoff_endpoint_summary',
  },
  landing: {
    label: 'Arrivals',
    color: '#2369b8',
    summaryKey: 'landing_summary',
    endpointSummaryKey: 'landing_endpoint_summary',
  },
  presence: { label: 'Aircraft present', color: '#5d6670', summaryKey: 'presence_summary' },
}
const MODE_ORDER = ['takeoff', 'landing', 'presence']

function formatDelta(value) {
  if (!Number.isFinite(value)) return '+0'
  return `${value >= 0 ? '+' : ''}${Math.round(value)}`
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(Math.round(value || 0))
}

function formatDistance(value) {
  if (!Number.isFinite(value)) return 'n/a'
  return `${Math.round(value)} mi`
}

function getCellSummary(result, mode) {
  return result?.[MODE_CONFIG[mode].summaryKey] || null
}

function getEndpointSummary(result, mode) {
  const key = MODE_CONFIG[mode].endpointSummaryKey
  return key ? result?.[key] || null : null
}

function getTopCellCluster(result, mode) {
  return getCellSummary(result, mode)?.compact_neighborhoods?.[0] || null
}

function getTopEndpointCluster(result, mode) {
  return getEndpointSummary(result, mode)?.clusters?.[0] || null
}

function withClusterSource(cluster, source) {
  return cluster ? { ...cluster, source } : null
}

function getTopCluster(result, mode) {
  return withClusterSource(getTopEndpointCluster(result, mode), 'endpoint') ||
    withClusterSource(getTopCellCluster(result, mode), 'cell')
}

function getActiveSummary(result, mode) {
  return getTopEndpointCluster(result, mode) ? getEndpointSummary(result, mode) : getCellSummary(result, mode)
}

function getClusterShare(result, mode) {
  const summary = getActiveSummary(result, mode)
  const cluster = getTopCluster(result, mode)
  if (!summary || !cluster || !summary.positive_total) return 0
  return cluster.total_delta / summary.positive_total
}

function getPrimaryMode(result) {
  if (result?.phase === 'arrival') return 'landing'
  if (result?.phase?.includes('departure')) return 'takeoff'
  return MODE_ORDER.reduce((best, mode) => (
    getClusterShare(result, mode) > getClusterShare(result, best) ? mode : best
  ), 'takeoff')
}

function getDistanceToEvent(result, mode) {
  const endpointDistance = result?.distances_miles?.[`${mode}_endpoint_top`]
  if (Number.isFinite(endpointDistance)) return endpointDistance
  return result?.distances_miles?.[`${mode}_top`]
}

function clusterPointFeature(result, mode) {
  const cluster = getTopCluster(result, mode)
  if (!cluster?.center) return null
  return {
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: [cluster.center.lon, cluster.center.lat],
    },
    properties: {
      key: result.key,
      event: result.event,
      mode,
      label: MODE_CONFIG[mode].label,
      delta: Math.round(cluster.total_delta),
      share: getClusterShare(result, mode),
      color: MODE_CONFIG[mode].color,
      source: cluster.source,
      radiusMiles: cluster.query_radius_miles || cluster.radius_miles || 0,
    },
  }
}

function eventPointFeature(result) {
  const lat = result?.event_location?.lat
  const lon = result?.event_location?.lon
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  return {
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: [lon, lat],
    },
    properties: {
      event: result.event,
      location: result.location_label,
    },
  }
}

function circlePolygon(center, radiusMiles, steps = 48) {
  const latRadius = radiusMiles / MILES_PER_DEGREE_LAT
  const lonRadius = radiusMiles / (MILES_PER_DEGREE_LAT * Math.cos(center.lat * Math.PI / 180))
  const coordinates = []
  for (let index = 0; index <= steps; index += 1) {
    const angle = (index / steps) * Math.PI * 2
    coordinates.push([
      center.lon + Math.cos(angle) * lonRadius,
      center.lat + Math.sin(angle) * latRadius,
    ])
  }
  return coordinates
}

function clusterAreaFeature(result, mode) {
  const cluster = getTopCluster(result, mode)
  if (cluster?.source === 'endpoint' && cluster.center) {
    return {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [circlePolygon(cluster.center, cluster.query_radius_miles || cluster.radius_miles || 18)],
      },
      properties: {
        mode,
        color: MODE_CONFIG[mode].color,
        delta: Math.round(cluster.total_delta),
        source: cluster.source,
      },
    }
  }

  const bounds = cluster?.top_cell?.bounds
  if (!bounds) return null
  const [lon0, lat0, lon1, lat1] = bounds
  return {
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [lon0, lat0],
        [lon1, lat0],
        [lon1, lat1],
        [lon0, lat1],
        [lon0, lat0],
      ]],
    },
    properties: {
      mode,
      color: MODE_CONFIG[mode].color,
      delta: Math.round(cluster.top_cell_delta),
      source: cluster.source,
    },
  }
}

function makeFeatureCollection(features) {
  return {
    type: 'FeatureCollection',
    features: features.filter(Boolean),
  }
}

function canUseWebGl() {
  try {
    const canvas = document.createElement('canvas')
    return Boolean(
      window.WebGLRenderingContext &&
        (canvas.getContext('webgl') || canvas.getContext('experimental-webgl')),
    )
  } catch {
    return false
  }
}

function isCoordinateInConus(coordinates) {
  const [lon, lat] = coordinates
  return lon >= CONUS_BOUNDS[0][0] && lon <= CONUS_BOUNDS[1][0] &&
    lat >= CONUS_BOUNDS[0][1] && lat <= CONUS_BOUNDS[1][1]
}

function projectCoordinate(coordinates) {
  const [lon, lat] = coordinates
  const xRange = SVG_MAP_WIDTH - SVG_MAP_PADDING * 2
  const yRange = SVG_MAP_HEIGHT - SVG_MAP_PADDING * 2
  const x = SVG_MAP_PADDING + ((lon - CONUS_BOUNDS[0][0]) / (CONUS_BOUNDS[1][0] - CONUS_BOUNDS[0][0])) * xRange
  const y = SVG_MAP_HEIGHT - SVG_MAP_PADDING - ((lat - CONUS_BOUNDS[0][1]) / (CONUS_BOUNDS[1][1] - CONUS_BOUNDS[0][1])) * yRange
  return [x, y]
}

function polygonPoints(feature) {
  return feature.geometry.coordinates[0]
    .filter(isCoordinateInConus)
    .map((coordinate) => projectCoordinate(coordinate).join(','))
    .join(' ')
}

function circleRadius(delta) {
  return Math.max(8, Math.min(34, 7 + Math.sqrt(Math.abs(delta || 0)) * 0.8))
}

function fitToFeatures(map, features, fallback = CONUS_BOUNDS) {
  const coordinates = []
  features.forEach((feature) => {
    if (feature.geometry.type === 'Point') {
      coordinates.push(feature.geometry.coordinates)
      return
    }
    if (feature.geometry.type === 'Polygon') {
      feature.geometry.coordinates[0].forEach((coordinate) => coordinates.push(coordinate))
    }
  })

  if (!coordinates.length) {
    map.fitBounds(fallback, { padding: 28, duration: 0 })
    return
  }

  const bounds = coordinates.reduce(
    (nextBounds, coordinate) => nextBounds.extend(coordinate),
    new maplibregl.LngLatBounds(coordinates[0], coordinates[0]),
  )
  map.fitBounds(bounds, { padding: 72, maxZoom: 7.2, duration: 500 })
}

function useMap(containerRef, onClusterClick) {
  const mapRef = useRef(null)
  const onClickRef = useRef(onClusterClick)
  const [mapError, setMapError] = useState(null)

  useEffect(() => {
    onClickRef.current = onClusterClick
  }, [onClusterClick])

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return undefined

    if (!canUseWebGl()) {
      queueMicrotask(() => setMapError(new Error('WebGL is unavailable.')))
      return undefined
    }

    let map
    try {
      map = new maplibregl.Map({
        container: containerRef.current,
        style: MAP_STYLE,
        bounds: CONUS_BOUNDS,
        fitBoundsOptions: { padding: 18 },
        attributionControl: false,
        cooperativeGestures: true,
      })
    } catch (error) {
      queueMicrotask(() => setMapError(error))
      return undefined
    }

    const handleMapError = (event) => {
      if (event.error?.message?.includes('WebGL') || event.error?.message?.includes('context')) {
        setMapError(event.error)
      }
    }

    map.on('error', handleMapError)
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right')
    mapRef.current = map

    map.on('load', () => {
      map.addSource('clusters', { type: 'geojson', data: makeFeatureCollection([]) })
      map.addSource('event-points', { type: 'geojson', data: makeFeatureCollection([]) })
      map.addSource('cells', { type: 'geojson', data: makeFeatureCollection([]) })

      map.addLayer({
        id: 'cells-fill',
        type: 'fill',
        source: 'cells',
        paint: {
          'fill-color': ['get', 'color'],
          'fill-opacity': 0.17,
        },
      })
      map.addLayer({
        id: 'cells-outline',
        type: 'line',
        source: 'cells',
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 1.5,
          'line-opacity': 0.72,
        },
      })
      map.addLayer({
        id: 'clusters-halo',
        type: 'circle',
        source: 'clusters',
        paint: {
          'circle-color': ['get', 'color'],
          'circle-opacity': 0.16,
          'circle-radius': [
            'interpolate',
            ['linear'],
            ['abs', ['get', 'delta']],
            40,
            20,
            1500,
            58,
          ],
        },
      })
      map.addLayer({
        id: 'clusters',
        type: 'circle',
        source: 'clusters',
        paint: {
          'circle-color': ['get', 'color'],
          'circle-opacity': 0.82,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
          'circle-radius': [
            'interpolate',
            ['linear'],
            ['abs', ['get', 'delta']],
            40,
            7,
            1500,
            24,
          ],
        },
      })
      map.addLayer({
        id: 'event-points',
        type: 'circle',
        source: 'event-points',
        paint: {
          'circle-color': '#111111',
          'circle-radius': 5,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
        },
      })
      map.addLayer({
        id: 'event-labels',
        type: 'symbol',
        source: 'event-points',
        layout: {
          'text-field': ['get', 'location'],
          'text-size': 12,
          'text-offset': [0, 1.2],
          'text-anchor': 'top',
        },
        paint: {
          'text-color': '#202020',
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.6,
        },
      })

      map.on('click', 'clusters', (event) => {
        const feature = event.features?.[0]
        if (feature?.properties?.key) {
          onClickRef.current(feature.properties.key)
        }
      })
      map.on('mouseenter', 'clusters', () => {
        map.getCanvas().style.cursor = 'pointer'
      })
      map.on('mouseleave', 'clusters', () => {
        map.getCanvas().style.cursor = ''
      })
    })

    return () => {
      map.off('error', handleMapError)
      map.remove()
      mapRef.current = null
    }
  }, [containerRef])

  return { mapRef, mapError }
}

function SvgGrid() {
  const longitudeTicks = [-120, -110, -100, -90, -80, -70]
  const latitudeTicks = [25, 30, 35, 40, 45, 50]

  return (
    <g className="svg-map-grid">
      <rect
        x={SVG_MAP_PADDING}
        y={SVG_MAP_PADDING}
        width={SVG_MAP_WIDTH - SVG_MAP_PADDING * 2}
        height={SVG_MAP_HEIGHT - SVG_MAP_PADDING * 2}
        rx="10"
      />
      {longitudeTicks.map((lon) => {
        const [x] = projectCoordinate([lon, CONUS_BOUNDS[0][1]])
        return (
          <g key={lon}>
            <line x1={x} x2={x} y1={SVG_MAP_PADDING} y2={SVG_MAP_HEIGHT - SVG_MAP_PADDING} />
            <text x={x} y={SVG_MAP_HEIGHT - 13}>{Math.abs(lon)}W</text>
          </g>
        )
      })}
      {latitudeTicks.map((lat) => {
        const [, y] = projectCoordinate([CONUS_BOUNDS[0][0], lat])
        return (
          <g key={lat}>
            <line x1={SVG_MAP_PADDING} x2={SVG_MAP_WIDTH - SVG_MAP_PADDING} y1={y} y2={y} />
            <text x={12} y={y + 4}>{lat}N</text>
          </g>
        )
      })}
    </g>
  )
}

function SignalFallbackMap({ results = [], selectedKey, result, mode, onSelect, variant }) {
  const selectedResult = result || results.find((item) => item.key === selectedKey)
  const clusterFeatures = variant === 'overview'
    ? results.map((item) => clusterPointFeature(item, getPrimaryMode(item))).filter(Boolean)
    : MODE_ORDER.map((item) => clusterPointFeature(selectedResult, item)).filter(Boolean)
  const areaFeatures = variant === 'detail'
    ? MODE_ORDER.map((item) => clusterAreaFeature(selectedResult, item)).filter(Boolean)
    : []
  const eventFeature = eventPointFeature(selectedResult)
  const visibleEventFeature = eventFeature && isCoordinateInConus(eventFeature.geometry.coordinates)
    ? eventFeature
    : null

  return (
    <div className="explainer-map svg-map-shell" aria-label="Event signal map fallback">
      <svg className="svg-signal-map" viewBox={`0 0 ${SVG_MAP_WIDTH} ${SVG_MAP_HEIGHT}`} role="img">
        <title>Fallback coordinate map for localized air traffic event signals</title>
        <SvgGrid />
        <path
          className="svg-map-land-hint"
          d="M154 198 L220 168 L296 176 L348 145 L419 158 L477 142 L540 164 L618 156 L692 181 L782 177 L850 213 L826 262 L770 291 L717 329 L648 335 L589 316 L511 332 L446 305 L376 315 L316 286 L252 298 L196 258 Z"
        />
        {areaFeatures.map((feature) => {
          const points = polygonPoints(feature)
          if (!points) return null
          return (
            <polygon
              className={`svg-map-cell ${feature.properties.mode === mode ? 'svg-map-cell-active' : ''}`}
              fill={feature.properties.color}
              key={`${feature.properties.mode}-area`}
              points={points}
            />
          )
        })}
        {clusterFeatures.map((feature) => {
          if (!isCoordinateInConus(feature.geometry.coordinates)) return null
          const [x, y] = projectCoordinate(feature.geometry.coordinates)
          const active = variant === 'overview'
            ? feature.properties.key === selectedKey
            : feature.properties.mode === mode
          const handleSelect = () => {
            if (variant === 'overview') onSelect(feature.properties.key)
          }
          return (
            <g
              className={`svg-map-cluster ${active ? 'svg-map-cluster-active' : ''}`}
              key={`${feature.properties.key}-${feature.properties.mode}`}
              onClick={handleSelect}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') handleSelect()
              }}
              role={variant === 'overview' ? 'button' : 'img'}
              tabIndex={variant === 'overview' ? 0 : undefined}
            >
              <circle
                className="svg-map-cluster-halo"
                cx={x}
                cy={y}
                fill={feature.properties.color}
                r={circleRadius(feature.properties.delta) * 2.1}
              />
              <circle
                className="svg-map-cluster-core"
                cx={x}
                cy={y}
                fill={feature.properties.color}
                r={circleRadius(feature.properties.delta)}
              />
              <text x={x} y={y - circleRadius(feature.properties.delta) - 9}>
                {formatDelta(feature.properties.delta)}
              </text>
            </g>
          )
        })}
        {visibleEventFeature ? (
          <g className="svg-map-event">
            {(() => {
              const [x, y] = projectCoordinate(visibleEventFeature.geometry.coordinates)
              return (
                <>
                  <circle cx={x} cy={y} r="6" />
                  <text x={x + 10} y={y - 9}>{visibleEventFeature.properties.location}</text>
                </>
              )
            })()}
          </g>
        ) : null}
        {!visibleEventFeature && eventFeature ? (
          <text className="svg-map-note" x={SVG_MAP_WIDTH - 300} y={SVG_MAP_HEIGHT - 18}>
            Event location outside CONUS view; plotted signal is the observed gateway cluster.
          </text>
        ) : null}
      </svg>
      <span className="svg-map-caption">WebGL map unavailable; showing coordinate fallback.</span>
    </div>
  )
}

function OverviewMap({ results, selectedKey, mode, onSelect }) {
  const containerRef = useRef(null)
  const { mapRef, mapError } = useMap(containerRef, onSelect)

  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    const update = () => {
      const features = results.map((result) => clusterPointFeature(result, getPrimaryMode(result))).filter(Boolean)
      const eventFeature = eventPointFeature(results.find((result) => result.key === selectedKey))
      map.getSource('clusters')?.setData(makeFeatureCollection(features))
      map.getSource('event-points')?.setData(makeFeatureCollection([eventFeature]))
      map.getSource('cells')?.setData(makeFeatureCollection([]))
      map.setPaintProperty('clusters', 'circle-stroke-width', [
        'case',
        ['==', ['get', 'key'], selectedKey],
        4,
        2,
      ])
      fitToFeatures(map, features)
    }

    if (map.isStyleLoaded()) update()
    else map.once('load', update)
  }, [mapRef, mode, results, selectedKey])

  if (mapError) {
    return (
      <SignalFallbackMap
        mode={mode}
        onSelect={onSelect}
        results={results}
        selectedKey={selectedKey}
        variant="overview"
      />
    )
  }

  return <div className="explainer-map" ref={containerRef} aria-label="Event signal overview map" />
}

function DetailMap({ result, mode }) {
  const containerRef = useRef(null)
  const { mapRef, mapError } = useMap(containerRef, () => {})

  useEffect(() => {
    const map = mapRef.current
    if (!map || !result) return

    const update = () => {
      const clusterFeatures = MODE_ORDER.map((item) => clusterPointFeature(result, item))
      const areaFeatures = MODE_ORDER.map((item) => clusterAreaFeature(result, item))
      const eventFeature = eventPointFeature(result)
      map.getSource('clusters')?.setData(makeFeatureCollection(clusterFeatures))
      map.getSource('cells')?.setData(makeFeatureCollection(areaFeatures))
      map.getSource('event-points')?.setData(makeFeatureCollection([eventFeature]))
      map.setPaintProperty('clusters', 'circle-opacity', [
        'case',
        ['==', ['get', 'mode'], mode],
        0.88,
        0.38,
      ])
      map.setPaintProperty('clusters-halo', 'circle-opacity', [
        'case',
        ['==', ['get', 'mode'], mode],
        0.18,
        0.06,
      ])
      map.setPaintProperty('cells-fill', 'fill-opacity', [
        'case',
        ['==', ['get', 'mode'], mode],
        0.24,
        0.08,
      ])
      fitToFeatures(map, [...clusterFeatures, ...areaFeatures, eventFeature].filter(Boolean), CONUS_BOUNDS)
    }

    if (map.isStyleLoaded()) update()
    else map.once('load', update)
  }, [mapRef, mode, result])

  if (mapError) {
    return <SignalFallbackMap mode={mode} result={result} variant="detail" />
  }

  return <div className="explainer-map" ref={containerRef} aria-label="Selected event evidence map" />
}

function ModeToggle({ mode, onModeChange }) {
  return (
    <div className="mode-toggle" role="tablist" aria-label="Evidence layer">
      {MODE_ORDER.map((item) => (
        <button
          className={`mode-button ${item === mode ? 'mode-button-active' : ''}`}
          key={item}
          onClick={() => onModeChange(item)}
          style={{ '--mode-color': MODE_CONFIG[item].color }}
          type="button"
        >
          <span className="mode-dot" />
          {MODE_CONFIG[item].label}
        </button>
      ))}
    </div>
  )
}

function EventList({ results, selectedKey, onSelect }) {
  return (
    <div className="event-list" role="listbox" aria-label="Localized event candidates">
      {results.map((result) => {
        const primaryMode = getPrimaryMode(result)
        const cluster = getTopCluster(result, primaryMode)
        const active = result.key === selectedKey
        return (
          <button
            className={`event-list-item ${active ? 'event-list-item-active' : ''}`}
            key={result.key}
            onClick={() => onSelect(result.key)}
            type="button"
          >
            <span className="event-list-title">{result.event}</span>
            <span className="event-list-meta">
              {result.classification.label} · {MODE_CONFIG[primaryMode].label.toLowerCase()} {formatDelta(cluster?.total_delta || 0)}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function MetricCards({ result, mode }) {
  const primaryCluster = getTopCluster(result, mode)
  const summary = getActiveSummary(result, mode)
  const endpointSummary = getEndpointSummary(result, mode)
  const distance = getDistanceToEvent(result, mode)
  const globalPeak = result?.current_global_residual?.peak_residual
  const sampleCount = result?.current_global_residual?.sample_count
  const share = getClusterShare(result, mode)
  const isEndpoint = primaryCluster?.source === 'endpoint'
  const cards = [
    { label: isEndpoint ? 'Endpoint cluster delta' : 'Compact cell delta', value: formatDelta(primaryCluster?.total_delta || 0), sub: `${Math.round(share * 100)}% of positive ${MODE_CONFIG[mode].label.toLowerCase()} signal` },
    { label: 'Distance to event', value: formatDistance(distance), sub: result?.location_label || 'U.S. gateway signal' },
    { label: 'Global peak excess', value: formatDelta(globalPeak || 0), sub: `${sampleCount || 0} half-hour samples in the test window` },
    isEndpoint
      ? { label: 'Endpoint clusters', value: formatNumber(endpointSummary?.positive_clusters || 0), sub: `${formatNumber(summary?.positive_total || 0)} total positive endpoint delta` }
      : { label: 'Positive cells', value: formatNumber(summary?.positive_cells || 0), sub: `${formatNumber(summary?.positive_total || 0)} total positive cell delta` },
  ]

  return (
    <div className="metric-card-grid">
      {cards.map((card) => (
        <div className="metric-card" key={card.label}>
          <span>{card.label}</span>
          <strong>{card.value}</strong>
          <small>{card.sub}</small>
        </div>
      ))}
    </div>
  )
}

function EvidenceChart({ results, onSelect }) {
  const chartData = results.map((result) => {
    const primaryMode = getPrimaryMode(result)
    const cluster = getTopCluster(result, primaryMode)
    return {
      key: result.key,
      name: result.event.replace(' 2026', '').replace(' 2025', ''),
      delta: Math.round(cluster?.total_delta || 0),
      share: Math.round(getClusterShare(result, primaryMode) * 100),
      color: MODE_CONFIG[primaryMode].color,
    }
  })

  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={chartData} margin={{ top: 12, right: 18, bottom: 44, left: 42 }}>
        <CartesianGrid stroke="#e3ded5" vertical={false} />
        <XAxis dataKey="name" angle={-28} interval={0} tick={{ fill: '#2c3138', fontSize: 11 }} textAnchor="end" />
        <YAxis tick={{ fill: '#2c3138', fontSize: 12 }} />
        <Tooltip
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null
            const item = payload[0].payload
            return (
              <div className="explainer-tooltip">
                <strong>{item.name}</strong>
                <span>Cluster delta: {formatDelta(item.delta)}</span>
                <span>Share: {item.share}%</span>
              </div>
            )
          }}
        />
        <Bar dataKey="delta" radius={[3, 3, 0, 0]} onClick={(data) => onSelect(data.key)}>
          {chartData.map((entry) => <Cell fill={entry.color} key={entry.key} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

function PipelineGraphic() {
  const steps = [
    ['1', 'Residual', 'Find windows where the count departs from the same-weekday baseline.'],
    ['2', 'Tracks', 'Rebuild aircraft timelines from the 10-second heatmap slices.'],
    ['3', 'Events', 'Infer takeoffs and landings from low-altitude transitions.'],
    ['4', 'Airports', 'Cluster endpoints by distance and compare each cluster to quiet windows.'],
  ]
  return (
    <div className="pipeline-graphic" aria-label="Detector pipeline">
      {steps.map(([number, title, copy]) => (
        <div className="pipeline-step" key={number}>
          <strong>{number}</strong>
          <span>{title}</span>
          <p>{copy}</p>
        </div>
      ))}
    </div>
  )
}

function EventSignalExplainer() {
  const [payload, setPayload] = useState(null)
  const [error, setError] = useState(null)
  const [selectedKey, setSelectedKey] = useState(null)
  const [mode, setMode] = useState('takeoff')

  useEffect(() => {
    document.body.classList.add('event-explainer-page')
    return () => document.body.classList.remove('event-explainer-page')
  }, [])

  useEffect(() => {
    let cancelled = false
    fetch(DATA_URL)
      .then((response) => {
        if (!response.ok) throw new Error(`Could not load ${DATA_URL}`)
        return response.json()
      })
      .then((nextPayload) => {
        if (cancelled) return
        const firstResult = nextPayload.results?.[0] || null
        setPayload(nextPayload)
        setSelectedKey(firstResult?.key || null)
        setMode(firstResult ? getPrimaryMode(firstResult) : 'takeoff')
      })
      .catch((nextError) => {
        if (!cancelled) setError(nextError)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const results = useMemo(() => payload?.results || [], [payload])
  const selectedResult = useMemo(
    () => results.find((result) => result.key === selectedKey) || results[0] || null,
    [results, selectedKey],
  )

  function selectResultKey(nextKey) {
    const nextResult = results.find((result) => result.key === nextKey) || results[0] || null
    setSelectedKey(nextKey)
    if (nextResult) {
      setMode(getPrimaryMode(nextResult))
    }
  }

  if (error) {
    return (
      <main className="event-explainer-root">
        <section className="explainer-panel">
          <h1>Localized Event Signals</h1>
          <p>Could not load the research dataset: {error.message}</p>
        </section>
      </main>
    )
  }

  if (!payload || !selectedResult) {
    return (
      <main className="event-explainer-root">
        <section className="explainer-panel explainer-loading">
          <h1>Localized Event Signals</h1>
          <p>Loading detector output.</p>
        </section>
      </main>
    )
  }

  const selectedCluster = getTopCluster(selectedResult, mode)

  return (
    <main className="event-explainer-root">
      <section className="explainer-hero">
        <div>
          <p className="explainer-kicker">Apocalypse EWS research note</p>
          <h1>Finding events in private aviation anomalies</h1>
          <p>
            A localized event leaves a different fingerprint than a holiday. Holiday traffic lifts
            many regions at once. An event creates compact arrival or departure endpoint clusters
            around airports, even when the national chart only shows a small blip.
          </p>
        </div>
        <div className="explainer-hero-stat">
          <span>Endpoint radius</span>
          <strong>{Math.round(payload.endpoint_cluster_radius_miles || payload.cell_size_miles || 100)} mi</strong>
          <small>{payload.results.length} validation windows · cells retained as diagnostics</small>
        </div>
      </section>

      <section className="explainer-layout">
        <aside className="explainer-sidebar">
          <div className="explainer-panel">
            <h2>Validation cases</h2>
            <EventList results={results} selectedKey={selectedResult.key} onSelect={selectResultKey} />
          </div>
          <div className="explainer-panel">
            <h2>Detector pipeline</h2>
            <PipelineGraphic />
          </div>
        </aside>

        <div className="explainer-main">
          <section className="explainer-panel map-panel-large">
            <div className="explainer-section-header">
              <div>
                <h2>Where the detector points</h2>
                <p>Click a cluster to select a case. Circles show each case's strongest endpoint or fallback cell evidence.</p>
              </div>
            </div>
            <OverviewMap results={results} selectedKey={selectedResult.key} mode={mode} onSelect={selectResultKey} />
          </section>

          <section className="explainer-panel selected-event-panel">
            <div className="explainer-section-header">
              <div>
                <p className="explainer-kicker">{selectedResult.classification.label}</p>
                <h2>{selectedResult.event}</h2>
                <p>{selectedResult.source_note}</p>
              </div>
              <ModeToggle mode={mode} onModeChange={setMode} />
            </div>

            <MetricCards result={selectedResult} mode={mode} />

            <div className="selected-event-grid">
              <DetailMap result={selectedResult} mode={mode} />
              <div className="explanation-copy">
                <h3>{MODE_CONFIG[mode].label} evidence</h3>
                <p>
                  The selected layer compares this event window to quiet same-weekday windows. For
                  departures and arrivals, the detector clusters inferred endpoints directly instead
                  of forcing airports into fixed map squares.
                </p>
                <dl>
                  <div>
                    <dt>Cluster center</dt>
                    <dd>
                      {selectedCluster
                        ? `${selectedCluster.center.lat.toFixed(2)}, ${selectedCluster.center.lon.toFixed(2)}`
                        : 'n/a'}
                    </dd>
                  </div>
                  <div>
                    <dt>Cluster delta</dt>
                    <dd>{formatDelta(selectedCluster?.total_delta || 0)}</dd>
                  </div>
                  <div>
                    <dt>Method</dt>
                    <dd>{selectedCluster?.source === 'endpoint' ? 'endpoint cluster' : 'cell fallback'}</dd>
                  </div>
                  <div>
                    <dt>Radius</dt>
                    <dd>{formatDistance(selectedCluster?.query_radius_miles || selectedCluster?.radius_miles)}</dd>
                  </div>
                  <div>
                    <dt>Window</dt>
                    <dd>{selectedResult.local_start.slice(0, 16)} to {selectedResult.local_end.slice(11, 16)}</dd>
                  </div>
                </dl>
              </div>
            </div>
          </section>

          <section className="explainer-panel">
            <div className="explainer-section-header">
              <div>
                <h2>Which events look most localized?</h2>
                <p>Bars show the selected primary endpoint cluster delta for each validation case, with cell fallback when needed.</p>
              </div>
            </div>
            <EvidenceChart results={results} onSelect={selectResultKey} />
          </section>
        </div>
      </section>
    </main>
  )
}

export default EventSignalExplainer
