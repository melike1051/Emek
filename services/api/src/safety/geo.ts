/**
 * Küresel mesafe yardımcıları.
 *
 * Geofence mesafesi **PostGIS** ile hesaplanır (geography, sferoid; ingest anında).
 * Buradaki haversine yalnızca iki ardışık örnek arasındaki sıçramayı ve iz üzerindeki
 * hareketi ölçmek için kullanılır: bu hesaplar kısa mesafelerdedir, sferoid ile küre
 * arasındaki fark (≤ %0,5) karar eşiklerinin çok altındadır ve saf fonksiyon olması
 * aynı kodun EXP-004 harness'inde de çalışmasını sağlar.
 */

/** Dünya yarıçapı (m) — WGS84 ortalama; AI servisindeki haversine ile aynı sabit. */
const EARTH_RADIUS_M = 6_371_008.8;

export interface LatLon {
  latitude: number;
  longitude: number;
}

export function haversineMeters(origin: LatLon, destination: LatLon): number {
  const lat1 = (origin.latitude * Math.PI) / 180;
  const lat2 = (destination.latitude * Math.PI) / 180;
  const deltaLat = lat2 - lat1;
  const deltaLon = ((destination.longitude - origin.longitude) * Math.PI) / 180;

  const a =
    Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}
