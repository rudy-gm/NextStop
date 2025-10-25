import { lineString, point, nearestPointOnLine, distance } from "@turf/turf";

const METERS_IN_KM = 1000;

export function buildRouteMetrics(coords = [], stops = []) {
  if (!coords || coords.length < 2) return null;
  const line = lineString(coords);
  const cumulative = [0];
  let total = 0;
  for (let i = 1; i < coords.length; i += 1) {
    const a = point(coords[i - 1]);
    const b = point(coords[i]);
    const segment = distance(a, b, { units: "kilometers" }) * METERS_IN_KM;
    total += segment;
    cumulative.push(total);
  }
  const stopMetrics = stops.map((stop) => {
    const snapped = nearestPointOnLine(line, point([stop.lng, stop.lat]), { units: "kilometers" });
    const locationKm = snapped.properties.location ?? 0;
    return {
      ...stop,
      distanceFromStart: locationKm * METERS_IN_KM,
      snapped: {
        lng: snapped.geometry.coordinates[0],
        lat: snapped.geometry.coordinates[1],
      },
    };
  }).sort((a, b) => a.distanceFromStart - b.distanceFromStart);

  return {
    line,
    coords,
    cumulative,
    totalLength: total,
    stops: stopMetrics,
  };
}

export function projectOntoRoute(routeMetrics, lng, lat) {
  if (!routeMetrics) return null;
  const snapped = nearestPointOnLine(routeMetrics.line, point([lng, lat]), { units: "kilometers" });
  const locationMeters = (snapped.properties.location ?? 0) * METERS_IN_KM;
  return {
    distanceFromStart: locationMeters,
    coordinates: {
      lng: snapped.geometry.coordinates[0],
      lat: snapped.geometry.coordinates[1],
    },
    index: snapped.properties.index ?? 0,
  };
}

export function formatDistance(meters) {
  if (!Number.isFinite(meters)) return "–";
  if (meters < 1000) {
    return `${Math.round(meters)} m`;
  }
  return `${(meters / 1000).toFixed(1)} km`;
}

export function formatEta(seconds) {
  if (!Number.isFinite(seconds)) return "–";
  const rounded = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(rounded / 60);
  const secs = rounded % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const remMinutes = minutes % 60;
    return `${hours}h ${remMinutes}m`;
  }
  return `${minutes}m ${secs.toString().padStart(2, "0")}s`;
}

export function smoothSpeed(previous, sample, { alpha = 0.35, minSpeedMps = 3 } = {}) {
  const value = Number.isFinite(sample) ? sample : null;
  if (value == null) {
    return previous ?? minSpeedMps;
  }
  const smoothed = previous == null ? value : (alpha * value) + ((1 - alpha) * previous);
  return Math.max(smoothed, minSpeedMps);
}
