/**
 * EXP-004 sentetik dünya — tohumlu, deterministik senaryo üreteci.
 *
 * **Bu veri sentetiktir.** Etiketler (olay var/yok, başlangıç anı) üretecin kendi
 * tanımıdır ve üreteç, kuralları yazan aynı ekip tarafından yazılmıştır. Bu yüzden
 * sonuçlar gerçek dünya başarımını **değil**, sistemin kendi varsayımları altındaki
 * iç tutarlılığını ve gürültüye (jitter, sinyal kaybı, saat sapması, gecikmeli
 * teslim) dayanıklılığını ölçer. Gerçek veriyle doğrulama R-63'tür.
 *
 * Tüm zaman sabit bir epoch'tan türetilir; `Date.now()` kullanılmaz. Aynı tohum
 * her çalıştırmada aynı izleri üretir.
 */

import type { RiskLevel } from '../../src/safety/safety.constants';

export const EPOCH = new Date('2026-10-05T07:00:00.000Z');
export const SERVICE = { latitude: 41.0, longitude: 29.0 };
export const RADIUS_METERS = 150;
export const ACCURACY_LIMIT_METERS = 100;
export const DEBOUNCE_SAMPLES = 3;
export const INTERVAL_SECONDS = 30;
export const PLANNED_SECONDS = 2 * 3600;
export const MAX_BATCH = 20;

// --- Tohumlu rastgelelik ---

export type Rng = () => number;

/** mulberry32: küçük, hızlı ve tohumlanabilir; kriptografik değildir ve gerekmez. */
export function mulberry32(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function uniform(rng: Rng, low: number, high: number): number {
  return low + (high - low) * rng();
}

function gaussian(rng: Rng): number {
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// --- Geometri (yerel düzlem yaklaşımı; birkaç km ölçeğinde yeterli) ---

export interface Point {
  latitude: number;
  longitude: number;
}

const METERS_PER_DEGREE = 111_320;

export function offset(origin: Point, northMeters: number, eastMeters: number): Point {
  return {
    latitude: origin.latitude + northMeters / METERS_PER_DEGREE,
    longitude:
      origin.longitude +
      eastMeters / (METERS_PER_DEGREE * Math.cos((origin.latitude * Math.PI) / 180)),
  };
}

function lerp(a: Point, b: Point, fraction: number): Point {
  const f = Math.min(1, Math.max(0, fraction));
  return {
    latitude: a.latitude + (b.latitude - a.latitude) * f,
    longitude: a.longitude + (b.longitude - a.longitude) * f,
  };
}

/** Zamanla parçalı doğrusal gerçek konum. */
interface Leg {
  from: number;
  to: number;
  start: Point;
  end: Point;
}

class Path {
  private readonly legs: Leg[] = [];

  constructor(private readonly initial: Point) {}

  add(from: number, to: number, start: Point, end: Point): void {
    this.legs.push({ from, to, start, end });
  }

  at(time: number): Point {
    let position = this.initial;
    for (const leg of this.legs) {
      if (time < leg.from) {
        break;
      }
      position =
        time >= leg.to
          ? leg.end
          : lerp(leg.start, leg.end, (time - leg.from) / (leg.to - leg.from));
    }
    return position;
  }
}

// --- Senaryo modeli ---

export type Injection = 'REPLAY' | 'SPOOF' | null;

export interface GeneratedSample {
  sequence: number;
  /** Cihazın bildirdiği zaman (saat sapması dahil). */
  capturedAt: Date;
  receivedAt: Date;
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  isMockLocation: boolean;
  /** Gerçek konumun hizmet noktasına mesafesi — geofence doğruluğu için. */
  trueDistanceMeters: number;
  injection: Injection;
}

export interface Scenario {
  id: string;
  family: string;
  label: 'NORMAL' | 'INCIDENT';
  /** Olay senaryosunda beklenen **asgari** seviye; normal senaryoda NORMAL. */
  expectedLevel: RiskLevel;
  onset: Date | null;
  scheduledStart: Date;
  scheduledEnd: Date;
  departAt: Date;
  checkInAt: Date | null;
  checkOutAt: Date | null;
  endAt: Date;
  panicAt: Date | null;
  /** Teslim edilen paketler (receivedAt sırasıyla). */
  batches: GeneratedSample[][];
}

interface Knobs {
  family: string;
  label: 'NORMAL' | 'INCIDENT';
  expectedLevel: RiskLevel;
}

export const NORMAL_FAMILIES: Knobs[] = [
  'N01_on_time',
  'N02_slow_traffic',
  'N03_indoor_jitter',
  'N04_short_signal_loss',
  'N05_legit_overrun',
  'N06_early_arrival_wait',
  'N07_short_exit',
  'N08_device_sleep_buffered',
  'N09_clock_skew_minor',
  'N10_traffic_detour',
].map((family) => ({ family, label: 'NORMAL', expectedLevel: 'NORMAL' }));

export const INCIDENT_FAMILIES: Knobs[] = [
  { family: 'I01_prolonged_exit', label: 'INCIDENT', expectedLevel: 'HIGH_RISK' },
  { family: 'I02_telemetry_blackout', label: 'INCIDENT', expectedLevel: 'HIGH_RISK' },
  { family: 'I03_moving_away_arrival', label: 'INCIDENT', expectedLevel: 'WARNING' },
  { family: 'I04_gps_spoofing', label: 'INCIDENT', expectedLevel: 'WARNING' },
  { family: 'I05_stalled_en_route', label: 'INCIDENT', expectedLevel: 'WARNING' },
  { family: 'I06_subtle_combination', label: 'INCIDENT', expectedLevel: 'WARNING' },
  { family: 'I07_panic', label: 'INCIDENT', expectedLevel: 'EMERGENCY' },
  { family: 'I08_no_telemetry_after_departure', label: 'INCIDENT', expectedLevel: 'HIGH_RISK' },
];

const MINUTE = 60_000;

function trueDistanceBetween(a: Point, b: Point): number {
  const north = (b.latitude - a.latitude) * METERS_PER_DEGREE;
  const east =
    (b.longitude - a.longitude) * METERS_PER_DEGREE * Math.cos((a.latitude * Math.PI) / 180);
  return Math.sqrt(north * north + east * east);
}

function trueDistance(point: Point): number {
  const north = (point.latitude - SERVICE.latitude) * METERS_PER_DEGREE;
  const east =
    (point.longitude - SERVICE.longitude) *
    METERS_PER_DEGREE *
    Math.cos((SERVICE.latitude * Math.PI) / 180);
  return Math.sqrt(north * north + east * east);
}

/**
 * Tek senaryo üretir. Parametrelerin tamamı tohumlu rastgelelikten gelir.
 */
export function generateScenario(knobs: Knobs, index: number, rng: Rng): Scenario {
  const f = knobs.family;
  const t0 = EPOCH.getTime();
  const scheduledStart = t0 + 90 * MINUTE;
  const scheduledEnd = scheduledStart + PLANNED_SECONDS * 1000;

  // Varış yolu: rastgele yönden 3-9 km, 6-10 m/sn efektif hız.
  const bearing = uniform(rng, 0, 2 * Math.PI);
  const startDistance = uniform(rng, 3000, 9000);
  const start = offset(
    SERVICE,
    startDistance * Math.cos(bearing),
    startDistance * Math.sin(bearing),
  );
  const speed = uniform(rng, 6, 10);
  let travelMs = (startDistance / speed) * 1000;

  // Varış zamanı: çoğunlukla başlangıçtan birkaç dakika önce.
  let arriveAt = scheduledStart - uniform(rng, 2, 10) * MINUTE;
  if (f === 'N02_slow_traffic') {
    arriveAt = scheduledStart + uniform(rng, 5, 13) * MINUTE;
    travelMs *= 1.6;
  }
  if (f === 'N06_early_arrival_wait') {
    arriveAt = scheduledStart - uniform(rng, 20, 35) * MINUTE;
  }
  const departAt = arriveAt - travelMs;

  // Kapıya yakın bekleme noktası (bina girişi) ve iç mekân.
  const doorstep = offset(SERVICE, uniform(rng, -40, 40), uniform(rng, -40, 40));
  const path = new Path(start);
  path.add(departAt, arriveAt, start, doorstep);

  let checkInAt: number | null =
    f === 'N06_early_arrival_wait'
      ? scheduledStart - uniform(rng, 0, 3) * MINUTE
      : arriveAt + uniform(rng, 1, 3) * MINUTE;
  const durationFactor =
    f === 'N05_legit_overrun' ? uniform(rng, 1.2, 1.45) : uniform(rng, 0.85, 1.15);
  let checkOutAt: number | null = checkInAt + PLANNED_SECONDS * 1000 * durationFactor;
  let endAt = checkOutAt;
  let onset: number | null = null;
  let panicAt: number | null = null;

  // İç mekândaki gerçek konum: hizmet noktasının ~15 m çevresi.
  const indoor = (time: number): Point => {
    const phase = time / 97_000;
    return offset(SERVICE, 10 * Math.sin(phase), 10 * Math.cos(phase * 0.7));
  };

  // --- Aile özgü sapmalar (gerçek konum) ---
  const excursions: { from: number; to: number; where: Point }[] = [];
  const silences: { from: number; to: number; buffered: boolean }[] = [];
  let spoofFrom: number | null = null;
  let skewMs = 0;

  const activeStart = checkInAt;
  const activeEnd = checkOutAt;
  const within = (lowFraction: number, highFraction: number): number =>
    activeStart + (activeEnd - activeStart) * uniform(rng, lowFraction, highFraction);

  switch (f) {
    case 'N04_short_signal_loss': {
      const from = within(0.2, 0.7);
      silences.push({ from, to: from + uniform(rng, 4, 8) * MINUTE, buffered: false });
      break;
    }
    case 'N07_short_exit': {
      const from = within(0.2, 0.7);
      excursions.push({
        from,
        to: from + uniform(rng, 2, 4.5) * MINUTE,
        where: offset(SERVICE, 250, 0),
      });
      break;
    }
    case 'N08_device_sleep_buffered': {
      const from = within(0.2, 0.7);
      silences.push({ from, to: from + uniform(rng, 6, 12) * MINUTE, buffered: true });
      break;
    }
    case 'N09_clock_skew_minor':
      skewMs = uniform(rng, 20, 90) * 1000;
      break;
    case 'N10_traffic_detour': {
      // Varış yolunda 400-800 m'lik sapma, 4-6 dk.
      const from = departAt + travelMs * uniform(rng, 0.3, 0.5);
      const detour = uniform(rng, 400, 800);
      const base = path.at(from);
      excursions.push({
        from,
        to: from + uniform(rng, 4, 6) * MINUTE,
        where: offset(base, detour * Math.cos(bearing), detour * Math.sin(bearing)),
      });
      break;
    }
    case 'I01_prolonged_exit': {
      onset = within(0.15, 0.5);
      const away = uniform(rng, 800, 2000);
      excursions.push({
        from: onset,
        to: onset + 120 * MINUTE,
        where: offset(SERVICE, away, away / 3),
      });
      endAt = onset + 45 * MINUTE;
      checkOutAt = null;
      break;
    }
    case 'I02_telemetry_blackout':
      onset = within(0.15, 0.6);
      silences.push({ from: onset, to: onset + 180 * MINUTE, buffered: false });
      endAt = onset + 45 * MINUTE;
      checkOutAt = null;
      break;
    case 'I03_moving_away_arrival': {
      onset = departAt + travelMs * uniform(rng, 0.3, 0.6);
      const turn = path.at(onset);
      const away = uniform(rng, 3000, 5000);
      const far = offset(turn, away * Math.cos(bearing), away * Math.sin(bearing));
      path.add(onset, onset + 15 * MINUTE, turn, far);
      checkInAt = null;
      checkOutAt = null;
      endAt = onset + 50 * MINUTE;
      break;
    }
    case 'I04_gps_spoofing':
      onset = within(0.15, 0.5);
      spoofFrom = onset;
      endAt = onset + 45 * MINUTE;
      checkOutAt = null;
      break;
    case 'I05_stalled_en_route': {
      onset = departAt + travelMs * uniform(rng, 0.2, 0.5);
      const stop = path.at(onset);
      path.add(onset, onset + 300 * MINUTE, stop, stop);
      checkInAt = null;
      checkOutAt = null;
      endAt = onset + 50 * MINUTE;
      break;
    }
    case 'I06_subtle_combination': {
      // Tek tek **her kuralın eşiğinin altında** kalan sapmalar: 7-9 dk sessizlikler
      // (R03 < 10 dk), 4 dk çıkışlar (R02 < 5 dk), 1,45× süre (R04 < 1,5×).
      // Not: ilk sürümde bozuk fix'ler de vardı ve R05'i tetikleyip ailenin amacını
      // bozuyordu; çıkarıldı ve raporda açıklandı.
      onset = within(0.1, 0.3);
      for (let k = 0; k < 3; k += 1) {
        const from = onset + k * 25 * MINUTE;
        silences.push({ from, to: from + uniform(rng, 7, 9) * MINUTE, buffered: false });
        const exit = from + 12 * MINUTE;
        excursions.push({ from: exit, to: exit + 4 * MINUTE, where: offset(SERVICE, 260, 0) });
      }
      checkOutAt = checkInAt + PLANNED_SECONDS * 1000 * 1.45;
      endAt = checkOutAt;
      break;
    }
    case 'I07_panic':
      onset = within(0.2, 0.6);
      panicAt = onset;
      endAt = onset + 30 * MINUTE;
      checkOutAt = null;
      break;
    case 'I08_no_telemetry_after_departure':
      onset = departAt;
      silences.push({ from: departAt - MINUTE, to: departAt + 300 * MINUTE, buffered: false });
      checkInAt = null;
      checkOutAt = null;
      endAt = departAt + 45 * MINUTE;
      break;
    default:
      break;
  }

  const truePosition = (time: number): Point => {
    for (const excursion of excursions) {
      if (time >= excursion.from && time < excursion.to) {
        // Gidiş ve dönüş 8 m/sn ile yapılır: gerçek konum ışınlanmaz (ışınlanma
        // sahteciliğin imzasıdır ve meşru bir çıkışı öyle göstermek deneyi bozardı).
        const indoorExcursion = checkInAt !== null && excursion.from >= checkInAt;
        // Dönüş noktası: hizmetteyse hizmet noktası, yoldaysa yolun **o anki** noktası
        // (yola eski noktadan devam etmek, dönüşte sahte bir sıçrama üretirdi).
        const origin = indoorExcursion ? SERVICE : path.at(excursion.from);
        const back = indoorExcursion ? SERVICE : path.at(excursion.to);
        const outMs = (trueDistanceBetween(origin, excursion.where) / 8) * 1000;
        const backMs = (trueDistanceBetween(excursion.where, back) / 8) * 1000;
        if (time < excursion.from + outMs) {
          return lerp(origin, excursion.where, (time - excursion.from) / outMs);
        }
        if (time > excursion.to - backMs) {
          return lerp(excursion.where, back, (time - (excursion.to - backMs)) / backMs);
        }
        return excursion.where;
      }
    }
    if (checkInAt !== null && time >= arriveAt && f !== 'N06_early_arrival_wait') {
      return time >= checkInAt ? indoor(time) : doorstep;
    }
    if (f === 'N06_early_arrival_wait' && checkInAt !== null && time >= arriveAt) {
      return time >= checkInAt ? indoor(time) : offset(SERVICE, 60, 20);
    }
    return path.at(time);
  };

  // --- Örnekleme ve teslim ---
  const batches: GeneratedSample[][] = [];
  const buffer: GeneratedSample[] = [];
  let sequence = 0;
  let spoofCounter = 0;

  for (
    let time = departAt + 5000;
    time < endAt;
    time += INTERVAL_SECONDS * 1000 + uniform(rng, -2000, 2000)
  ) {
    const silence = silences.find((window) => time >= window.from && time < window.to);
    if (silence !== undefined && !silence.buffered) {
      continue;
    }

    const indoorPhase =
      checkInAt !== null &&
      time >= checkInAt &&
      excursions.every((e) => time < e.from || time >= e.to);
    let accuracy = indoorPhase ? uniform(rng, 15, 45) : uniform(rng, 5, 15);
    if (f === 'N03_indoor_jitter' && indoorPhase) {
      accuracy = rng() < 0.1 ? uniform(rng, 150, 400) : uniform(rng, 40, 90);
    }

    const truth = truePosition(time);
    let measured = offset(truth, gaussian(rng) * accuracy * 0.5, gaussian(rng) * accuracy * 0.5);
    let isMock = false;
    let injection: Injection = null;

    if (spoofFrom !== null && time >= spoofFrom) {
      spoofCounter += 1;
      isMock = rng() < 0.5;
      // Periyodik ışınlanma.
      if (spoofCounter % 6 === 3) {
        const jump = uniform(rng, 5000, 20000);
        measured = offset(truth, jump, jump / 2);
        injection = 'SPOOF';
      }
    }

    sequence += 1;
    const sample: GeneratedSample = {
      sequence,
      capturedAt: new Date(time + skewMs),
      receivedAt: new Date(time + 1000),
      latitude: measured.latitude,
      longitude: measured.longitude,
      accuracyMeters: Math.round(accuracy * 10) / 10,
      isMockLocation: isMock,
      trueDistanceMeters: trueDistance(truth),
      injection,
    };

    if (silence !== undefined && silence.buffered) {
      buffer.push(sample);
      continue;
    }
    if (buffer.length > 0) {
      // Uyanınca tampon boşaltılır: aynı anda teslim, en fazla MAX_BATCH'lik paketler.
      const wake = new Date(time + 1000);
      const flushed = buffer
        .splice(0, buffer.length)
        .map((item) => ({ ...item, receivedAt: wake }));
      for (let k = 0; k < flushed.length; k += MAX_BATCH) {
        batches.push(flushed.slice(k, k + MAX_BATCH));
      }
    }
    batches.push([sample]);

    // Ağ yeniden denemesi: paketlerin ~%5'i hemen tekrar gönderilir.
    if (rng() < 0.05) {
      batches.push([{ ...sample, receivedAt: new Date(time + 3000), injection: 'REPLAY' }]);
    }
  }

  return {
    id: `${f}#${String(index).padStart(2, '0')}`,
    family: f,
    label: knobs.label,
    expectedLevel: knobs.expectedLevel,
    onset: onset === null ? null : new Date(onset),
    scheduledStart: new Date(scheduledStart),
    scheduledEnd: new Date(scheduledEnd),
    departAt: new Date(departAt),
    checkInAt: checkInAt === null ? null : new Date(checkInAt),
    checkOutAt: checkOutAt === null ? null : new Date(checkOutAt),
    endAt: new Date(endAt),
    panicAt: panicAt === null ? null : new Date(panicAt),
    batches,
  };
}

export function generateScenarios(seed: number, perFamily: number): Scenario[] {
  const rng = mulberry32(seed);
  const scenarios: Scenario[] = [];
  for (const knobs of [...NORMAL_FAMILIES, ...INCIDENT_FAMILIES]) {
    for (let index = 0; index < perFamily; index += 1) {
      scenarios.push(generateScenario(knobs, index, rng));
    }
  }
  return scenarios;
}
