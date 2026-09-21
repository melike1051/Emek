/**
 * EXP-004 — Güvenlik: kurallar, anomali modeli ve hibrit karar (sentetik).
 *
 * Çalıştırma: npm run exp:safety --workspace=@emek/api
 * (AI servisinin bağımlılıkları kurulu olmalı: `cd services/ai && uv sync --all-groups`)
 *
 * Yöntem (ADR-0012 §4):
 *   1. Tohumlu üreteç sentetik oturumlar üretir (scripts/exp-004/world.ts).
 *   2. Her oturum **üretimdeki saf fonksiyonlardan** geçer: telemetri doğrulama +
 *      geofence + debounce (`processBatch`), sinyaller (`buildSignals`,
 *      `summarizeTrace`), model girdisi (`buildAnomalyFeatures`, `toWire`).
 *   3. Tüm değerlendirme anlarının girdileri tek seferde **gerçek** Python modeline
 *      (`app.evaluation.safety.score`, endpoint ile aynı kod yolu) verilir — iki
 *      sürümle: v1 (taban çizgisi) ve v2 (varsayılan).
 *   4. Kurallar (`evaluateRules`) ve toplama (`aggregateRisk`) beş kolda çalışır.
 *
 * Tek fark mesafe kaynağıdır: üretimde PostGIS (sferoid), burada haversine.
 * Rapordaki hiçbir sayı elle yazılmaz; rapor bu çıktıdan üretilir.
 */

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { format, resolveConfig } from 'prettier';
import { buildAnomalyFeatures } from '../src/safety/anomaly-features';
import type { AnomalyFeatures } from '../src/safety/anomaly.port';
import { haversineMeters } from '../src/safety/geo';
import { hysteresisMeters } from '../src/safety/geofence';
import { toWire } from '../src/safety/http-anomaly.client';
import {
  ANOMALY_FLAG_THRESHOLD,
  ANOMALY_MIN_QUALITY,
  RISK_AGGREGATION_VERSION,
  aggregateRisk,
  isAnomalyFlagged,
  resolveAppliedLevel,
} from '../src/safety/rules/risk-aggregation';
import {
  DEFAULT_RULE_THRESHOLDS,
  SAFETY_RULESET_VERSION,
  evaluateRules,
} from '../src/safety/rules/safety-rules';
import {
  buildSignals,
  summarizeTrace,
  withRoute,
  type SafetySignals,
  type TraceSample,
} from '../src/safety/rules/safety-signals';
import { riskRank, type GeofenceState, type RiskLevel } from '../src/safety/safety.constants';
import { processBatch, type BatchState } from '../src/safety/telemetry-batch';
import {
  TELEMETRY_MIN_SPACING_SECONDS,
  TELEMETRY_REANCHOR_AFTER,
} from '../src/safety/telemetry-validator';
import {
  ACCURACY_LIMIT_METERS,
  DEBOUNCE_SAMPLES,
  INTERVAL_SECONDS,
  RADIUS_METERS,
  SERVICE,
  generateScenarios,
  type Scenario,
} from './exp-004/world';

const SEED = 20260922;
const HOLDOUT_SEED = 1729;
const PER_FAMILY = 20;
const TICK_SECONDS = 120;
const TRACE_WINDOW_SECONDS = 3600;
const TRACE_LIMIT = 240;
const POLICY = {
  maxSkewSeconds: 120,
  maxAgeSeconds: 900,
  maxSpeedMps: 60,
  minSpacingSeconds: TELEMETRY_MIN_SPACING_SECONDS,
  reanchorAfter: TELEMETRY_REANCHOR_AFTER,
};
const OUTPUT = resolve(__dirname, '../../../docs/research/experiments/exp-004-safety-anomaly.json');

const MODEL_V1 = 'anomaly-deviation-v1';
const MODEL_V2 = 'anomaly-deviation-v2';

/**
 * Kollar. `hybrid`/`anomaly` varsayılan modeli (v2) kullanır; `_v1` kolları önceki
 * sürümün taban çizgisidir ve sürüm iyileştirmesinin ölçüsüdür.
 */
type Arm = 'rules' | 'hybrid_v1' | 'anomaly_v1' | 'hybrid' | 'anomaly';
const ARMS: Arm[] = ['rules', 'hybrid_v1', 'anomaly_v1', 'hybrid', 'anomaly'];
type Threshold = 'WARNING' | 'HIGH_RISK';

function emptyByArm<T>(make: () => T): Record<Arm, T> {
  return Object.fromEntries(ARMS.map((arm) => [arm, make()])) as Record<Arm, T>;
}

interface Tick {
  at: Date;
  signals: SafetySignals;
  panicRaised: boolean;
  features: AnomalyFeatures;
}

interface GeofenceTally {
  conclusiveTruth: number;
  matches: number;
  transitions: number;
  truthTransitions: number;
}

interface Simulated {
  scenario: Scenario;
  ticks: Tick[];
  rejections: Map<string, { genuine: number; injected: number }>;
  genuineSamples: number;
  injectedSamples: number;
  injectedRejected: number;
  geofence: GeofenceTally;
}

// ---------------------------------------------------------------------------
// 1. Simülasyon (üretimdeki saf fonksiyonlarla)
// ---------------------------------------------------------------------------

function simulate(scenario: Scenario): Simulated {
  let state: BatchState = {
    telemetry: {
      lastSequence: 0,
      lastCapturedAt: null,
      lastLatitude: null,
      lastLongitude: null,
      lastAccuracyMeters: null,
      consecutiveSpeedRejections: 0,
      monitoringStartedAt: scenario.departAt,
    },
    geofence: { current: 'UNKNOWN', candidate: null, candidateCount: 0 },
  };

  let status: 'ARRIVAL_MONITORING' | 'ACTIVE' | 'CLOSED' = 'ARRIVAL_MONITORING';
  let activatedAt: Date | null = null;
  let activationGeofenceState: GeofenceState | null = null;
  let geofenceStateSince: Date | null = null;
  let lastTelemetryAt: Date | null = null;
  let lastDistance: number | null = null;
  let telemetryCount = 0;
  let rejectedCount = 0;
  let integrityCount = 0;
  let mockCount = 0;
  const trace: (TraceSample & { receivedAt: Date })[] = [];

  const result: Simulated = {
    scenario,
    ticks: [],
    rejections: new Map(),
    genuineSamples: 0,
    injectedSamples: 0,
    injectedRejected: 0,
    geofence: { conclusiveTruth: 0, matches: 0, transitions: 0, truthTransitions: 0 },
  };

  const band = hysteresisMeters(RADIUS_METERS);
  let truthState: 'IN' | 'OUT' | null = null;
  let truthCandidate: 'IN' | 'OUT' | null = null;
  let truthRun = 0;

  type Event =
    | { at: number; order: number; kind: 'batch'; batch: Scenario['batches'][number] }
    | { at: number; order: number; kind: 'checkin' | 'checkout' | 'tick' };
  const events: Event[] = scenario.batches.map((batch) => ({
    at: batch[0]!.receivedAt.getTime(),
    order: 0,
    kind: 'batch' as const,
    batch,
  }));
  if (scenario.checkInAt !== null) {
    events.push({ at: scenario.checkInAt.getTime(), order: 1, kind: 'checkin' });
  }
  if (scenario.checkOutAt !== null) {
    events.push({ at: scenario.checkOutAt.getTime(), order: 1, kind: 'checkout' });
  }
  for (
    let at = scenario.departAt.getTime() + TICK_SECONDS * 1000;
    at <= scenario.endAt.getTime();
    at += TICK_SECONDS * 1000
  ) {
    events.push({ at, order: 2, kind: 'tick' });
  }
  events.sort((a, b) => a.at - b.at || a.order - b.order);

  for (const event of events) {
    if (status === 'CLOSED') {
      break;
    }
    const now = new Date(event.at);

    if (event.kind === 'checkin') {
      status = 'ACTIVE';
      activatedAt = now;
      activationGeofenceState = state.geofence.current;
      continue;
    }
    if (event.kind === 'checkout') {
      status = 'CLOSED';
      continue;
    }

    if (event.kind === 'batch') {
      const samples = event.batch.map((sample) => ({
        sequence: sample.sequence,
        capturedAt: sample.capturedAt,
        latitude: sample.latitude,
        longitude: sample.longitude,
        accuracyMeters: sample.accuracyMeters,
        speedMps: null,
        headingDegrees: null,
        isMockLocation: sample.isMockLocation,
      }));
      const distances = samples.map((sample) => Math.round(haversineMeters(SERVICE, sample)));
      const outcome = processBatch(state, samples, distances, now, POLICY, {
        radiusMeters: RADIUS_METERS,
        accuracyLimitMeters: ACCURACY_LIMIT_METERS,
        debounceSamples: DEBOUNCE_SAMPLES,
      });
      state = outcome.next;

      const bySequence = new Map(event.batch.map((sample) => [sample.sequence, sample]));
      for (const item of outcome.results) {
        const generated = bySequence.get(item.sequence)!;
        const injected = generated.injection !== null;
        if (injected) {
          result.injectedSamples += 1;
        } else {
          result.genuineSamples += 1;
        }
        if (item.reason !== null) {
          const tally = result.rejections.get(item.reason) ?? { genuine: 0, injected: 0 };
          if (injected) {
            tally.injected += 1;
            result.injectedRejected += 1;
          } else {
            tally.genuine += 1;
          }
          result.rejections.set(item.reason, tally);
        }
      }

      telemetryCount += outcome.accepted.length;
      rejectedCount += outcome.countedRejections;
      integrityCount += [...outcome.integrityRejections.values()].reduce((a, b) => a + b, 0);
      mockCount += outcome.mockLocations;
      if (outcome.accepted.length > 0) {
        lastTelemetryAt = now;
        lastDistance = outcome.accepted[outcome.accepted.length - 1]!.distanceMeters;
      }
      if (outcome.transitions.length > 0) {
        geofenceStateSince = now;
        result.geofence.transitions += outcome.transitions.filter(
          (transition) => transition.from !== 'UNKNOWN',
        ).length;
      }

      for (const accepted of outcome.accepted) {
        const generated = bySequence.get(accepted.sample.sequence)!;
        trace.push({
          capturedAt: accepted.sample.capturedAt,
          latitude: accepted.sample.latitude,
          longitude: accepted.sample.longitude,
          accuracyMeters: accepted.sample.accuracyMeters,
          distanceToServiceMeters: accepted.distanceMeters,
          receivedAt: now,
        });

        // Geofence doğruluğu: yalnızca gerçek konumun **kesin** olduğu örnekler.
        const truth =
          generated.trueDistanceMeters <= RADIUS_METERS - band
            ? 'IN'
            : generated.trueDistanceMeters > RADIUS_METERS + band
              ? 'OUT'
              : null;
        if (truth === null || generated.injection !== null) {
          continue;
        }
        result.geofence.conclusiveTruth += 1;
        // Örnek anındaki durum (paket sonundaki değil): tamponlanmış 20'lik bir
        // pakette ilk örnekler son duruma göre yargılanmasın (review bulgusu).
        const decided = accepted.debouncedState;
        if (
          (truth === 'IN' && decided === 'INSIDE') ||
          (truth === 'OUT' && decided === 'OUTSIDE')
        ) {
          result.geofence.matches += 1;
        }
        // Gerçek geçişler de aynı ardışıklık (3 örnek) ile sayılır.
        if (truth === truthState) {
          truthCandidate = null;
          truthRun = 0;
        } else {
          truthRun = truthCandidate === truth ? truthRun + 1 : 1;
          truthCandidate = truth;
          if (truthRun >= DEBOUNCE_SAMPLES) {
            if (truthState !== null) {
              result.geofence.truthTransitions += 1;
            }
            truthState = truth;
            truthCandidate = null;
            truthRun = 0;
          }
        }
      }
      continue;
    }

    // --- Değerlendirme anı (üretimdeki `recentTrace` ile aynı pencere/sınır) ---
    const windowStart = event.at - TRACE_WINDOW_SECONDS * 1000;
    const recent = trace
      .filter((sample) => sample.receivedAt.getTime() >= windowStart)
      .slice(-TRACE_LIMIT);
    const signals = buildSignals(
      {
        status,
        scheduledStart: scenario.scheduledStart,
        scheduledEnd: scenario.scheduledEnd,
        telemetryIntervalSeconds: INTERVAL_SECONDS,
        geofenceRadiusMeters: RADIUS_METERS,
        monitoringStartedAt: scenario.departAt,
        activatedAt,
        activationGeofenceState,
        geofenceState: state.geofence.current,
        geofenceStateSince,
        lastDistanceMeters: lastDistance,
        lastTelemetryAt,
        telemetryCount,
        rejectedCount,
        integrityRejectionCount: integrityCount,
        mockLocationCount: mockCount,
      },
      summarizeTrace(recent, RADIUS_METERS),
      now,
    );
    const features = buildAnomalyFeatures(
      {
        status,
        scheduledStart: scenario.scheduledStart,
        scheduledEnd: scenario.scheduledEnd,
        telemetryIntervalSeconds: INTERVAL_SECONDS,
        activatedAt,
        latitude: SERVICE.latitude,
        longitude: SERVICE.longitude,
        lastLatitude: state.telemetry.lastLatitude,
        lastLongitude: state.telemetry.lastLongitude,
      },
      signals,
    );
    result.ticks.push({
      at: now,
      signals,
      panicRaised: scenario.panicAt !== null && event.at >= scenario.panicAt.getTime(),
      features,
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// 2. Gerçek Python modeli (toplu)
// ---------------------------------------------------------------------------

interface ModelOutput {
  model_version: string;
  anomaly_score: number;
  quality: number;
  contributions: { feature: string; contribution: number }[];
  route: { available: boolean; provider: string | null; eta_seconds: number | null } | null;
}

function score(features: AnomalyFeatures[], modelVersion: string): ModelOutput[] {
  const aiDir = resolve(__dirname, '../../ai');
  const run = spawnSync(
    'uv',
    ['run', 'python', '-m', 'app.evaluation.safety.score', modelVersion],
    {
      cwd: aiDir,
      input: JSON.stringify(features.map(toWire)),
      maxBuffer: 1024 * 1024 * 1024,
      encoding: 'utf8',
    },
  );
  if (run.status !== 0) {
    throw new Error(`Python skorlayıcı başarısız: ${run.stderr}`);
  }
  const outputs = JSON.parse(run.stdout) as ModelOutput[];
  if (outputs.length !== features.length || outputs[0]?.model_version !== modelVersion) {
    throw new Error('Python skorlayıcı beklenen sürüm/uzunlukta yanıt vermedi');
  }
  return outputs;
}

// ---------------------------------------------------------------------------
// 3. Kollar ve metrikler
// ---------------------------------------------------------------------------

interface ScenarioOutcome {
  id: string;
  family: string;
  label: 'NORMAL' | 'INCIDENT';
  expectedLevel: RiskLevel;
  /** Olay senaryosunda başlangıçtan sonraki, normal senaryoda tüm oturumdaki en yüksek seviye. */
  maxLevel: Record<Arm, RiskLevel>;
  firstAlarmAfterOnset: Record<Arm, Record<Threshold, number | null>>;
  preOnsetAlarm: Record<Arm, boolean>;
  rules: string[];
}

interface ModelSeries {
  v1: ModelOutput[];
  v2: ModelOutput[];
}

function quantile(values: number[], q: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (position - low);
}

function round(value: number | null, digits = 4): number | null {
  if (value === null) {
    return null;
  }
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : round(numerator / denominator);
}

function evaluateArms(
  simulated: Simulated,
  outputs: ModelSeries,
  flagThreshold: number,
): ScenarioOutcome {
  const { scenario } = simulated;
  const onset = scenario.onset?.getTime() ?? null;
  const current = emptyByArm<RiskLevel>(() => 'NORMAL');
  const outcome: ScenarioOutcome = {
    id: scenario.id,
    family: scenario.family,
    label: scenario.label,
    expectedLevel: scenario.expectedLevel,
    maxLevel: emptyByArm<RiskLevel>(() => 'NORMAL'),
    firstAlarmAfterOnset: emptyByArm<Record<Threshold, number | null>>(() => ({
      WARNING: null,
      HIGH_RISK: null,
    })),
    preOnsetAlarm: emptyByArm(() => false),
    rules: [],
  };
  const triggered = new Set<string>();

  simulated.ticks.forEach((tick, index) => {
    const v1 = outputs.v1[index]!;
    const v2 = outputs.v2[index]!;
    // Rota altyapıdır ve iki sürümde aynıdır (aynı routing portu).
    const route =
      v2.route !== null && v2.route.available && v2.route.eta_seconds !== null
        ? { etaSeconds: v2.route.eta_seconds, provider: v2.route.provider ?? 'unknown' }
        : null;
    const findings = evaluateRules(withRoute(tick.signals, route), DEFAULT_RULE_THRESHOLDS);
    findings.forEach((finding) => triggered.add(finding.ruleId));

    // Duyarlılık kolu: aynı toplama politikası, yalnızca bayrak eşiği farklı
    // (`flagThreshold`; üretim her zaman varsayılanı kullanır).
    const signal = (output: ModelOutput) => ({
      score: output.anomaly_score,
      quality: output.quality,
      contributions: output.contributions,
    });
    const panicRaised = tick.panicRaised;
    // Yalnız-model kolları **modeli** ölçer: panik (deterministik yol) bu kollara
    // kredi yazmaz; aksi hâlde panik oturumları modelin başarısı gibi görünürdü.
    const onlyModel = (output: ModelOutput): RiskLevel =>
      isAnomalyFlagged(signal(output), flagThreshold) ? 'WARNING' : 'NORMAL';
    const hybrid = (output: ModelOutput): RiskLevel =>
      aggregateRisk({ findings, anomaly: signal(output), panicRaised, flagThreshold }).level;

    const computed: Record<Arm, RiskLevel> = {
      rules: aggregateRisk({ findings, anomaly: null, panicRaised }).level,
      hybrid_v1: hybrid(v1),
      anomaly_v1: onlyModel(v1),
      hybrid: hybrid(v2),
      anomaly: onlyModel(v2),
    };

    const afterOnset = onset === null || tick.at.getTime() >= onset;
    for (const arm of ARMS) {
      current[arm] = resolveAppliedLevel(current[arm], computed[arm]);
      const level = current[arm];
      if (!afterOnset) {
        if (riskRank(level) >= riskRank('WARNING')) {
          outcome.preOnsetAlarm[arm] = true;
        }
        continue;
      }
      if (riskRank(level) > riskRank(outcome.maxLevel[arm])) {
        outcome.maxLevel[arm] = level;
      }
      if (onset === null) {
        continue;
      }
      for (const threshold of ['WARNING', 'HIGH_RISK'] as const) {
        if (
          outcome.firstAlarmAfterOnset[arm][threshold] === null &&
          riskRank(level) >= riskRank(threshold)
        ) {
          outcome.firstAlarmAfterOnset[arm][threshold] = Math.round(
            (tick.at.getTime() - onset) / 1000,
          );
        }
      }
    }
  });

  outcome.rules = [...triggered].sort();
  return outcome;
}

function armMetrics(outcomes: ScenarioOutcome[], arm: Arm, threshold: Threshold) {
  const incidents = outcomes.filter((outcome) => outcome.label === 'INCIDENT');
  const normals = outcomes.filter((outcome) => outcome.label === 'NORMAL');
  const detected = incidents.filter(
    (outcome) => outcome.firstAlarmAfterOnset[arm][threshold] !== null,
  );
  const falseAlarms = normals.filter(
    (outcome) => riskRank(outcome.maxLevel[arm]) >= riskRank(threshold),
  );
  const latencies = detected.map((outcome) => outcome.firstAlarmAfterOnset[arm][threshold]!);

  const tp = detected.length;
  const fp = falseAlarms.length;
  return {
    incidents: incidents.length,
    normals: normals.length,
    true_positives: tp,
    false_positives: fp,
    precision: ratio(tp, tp + fp),
    recall: ratio(tp, incidents.length),
    false_positive_rate: ratio(fp, normals.length),
    false_negative_rate: ratio(incidents.length - tp, incidents.length),
    detection_latency_seconds: {
      p50: round(quantile(latencies, 0.5), 0),
      p90: round(quantile(latencies, 0.9), 0),
      max: latencies.length === 0 ? null : Math.max(...latencies),
    },
  };
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort());
}

function byFamily(outcomes: ScenarioOutcome[], arm: Arm) {
  const families = [...new Set(outcomes.map((outcome) => outcome.family))];
  return Object.fromEntries(
    families.map((family) => {
      const group = outcomes.filter((outcome) => outcome.family === family);
      const label = group[0]!.label;
      const alarmed = group.filter((outcome) =>
        label === 'INCIDENT'
          ? outcome.firstAlarmAfterOnset[arm].WARNING !== null
          : riskRank(outcome.maxLevel[arm]) >= riskRank('WARNING'),
      ).length;
      const reachedExpected = group.filter(
        (outcome) => riskRank(outcome.maxLevel[arm]) >= riskRank(outcome.expectedLevel),
      ).length;
      const exact = group.filter(
        (outcome) => outcome.maxLevel[arm] === outcome.expectedLevel,
      ).length;
      const latencies = group
        .map((outcome) => outcome.firstAlarmAfterOnset[arm].WARNING)
        .filter((value): value is number => value !== null);
      return [
        family,
        {
          label,
          sessions: group.length,
          alarm_rate: ratio(alarmed, group.length),
          reached_expected_level_rate: ratio(reachedExpected, group.length),
          exact_level_rate: ratio(exact, group.length),
          warning_latency_p50_seconds: round(quantile(latencies, 0.5), 0),
          max_level_distribution: countBy(group.map((outcome) => outcome.maxLevel[arm])),
        },
      ];
    }),
  );
}

function distribution(values: number[]) {
  return {
    count: values.length,
    p50: round(quantile(values, 0.5)),
    p90: round(quantile(values, 0.9)),
    flagged_rate: ratio(
      values.filter((value) => value >= ANOMALY_FLAG_THRESHOLD).length,
      values.length,
    ),
  };
}

/** Bir tohum için tüm hat: üretim → simülasyon → iki model sürümüyle skorlama. */
function runSeed(seed: number) {
  const simulated = generateScenarios(seed, PER_FAMILY).map(simulate);
  const allTicks = simulated.flatMap((item) => item.ticks);
  const allFeatures = allTicks.map((tick) => tick.features);
  const outputs: ModelSeries = {
    v1: score(allFeatures, MODEL_V1),
    v2: score(allFeatures, MODEL_V2),
  };
  const outcomesAt = (threshold: number): ScenarioOutcome[] => {
    let offset = 0;
    return simulated.map((item) => {
      const slice = {
        v1: outputs.v1.slice(offset, offset + item.ticks.length),
        v2: outputs.v2.slice(offset, offset + item.ticks.length),
      };
      offset += item.ticks.length;
      return evaluateArms(item, slice, threshold);
    });
  };
  return { simulated, allTicks, outputs, outcomesAt };
}

async function main(): Promise<void> {
  const { simulated, allTicks, outputs, outcomesAt } = runSeed(SEED);

  // Ayrık tohum: aynı kod ve parametrelerle, deney tasarımı sırasında hiç
  // bakılmamış ikinci bir üretim. Birincil sonuçların tek bir tohuma özgü olup
  // olmadığının kaba kontrolüdür (review bulgusu; R-63'ü çözmez).
  const holdoutOutcomes = runSeed(HOLDOUT_SEED).outcomesAt(ANOMALY_FLAG_THRESHOLD);
  const holdout = {
    seed: HOLDOUT_SEED,
    arms: Object.fromEntries(
      ARMS.map((arm) => [
        arm,
        {
          at_warning: armMetrics(holdoutOutcomes, arm, 'WARNING'),
          at_high_risk: armMetrics(holdoutOutcomes, arm, 'HIGH_RISK'),
          alarm_rate_by_family: Object.fromEntries(
            Object.entries(byFamily(holdoutOutcomes, arm)).map(([family, value]) => [
              family,
              value.alarm_rate,
            ]),
          ),
        },
      ]),
    ),
  };

  const outcomes = outcomesAt(ANOMALY_FLAG_THRESHOLD);
  const withoutPanic = outcomes.filter((outcome) => outcome.family !== 'I07_panic');

  // Duyarlılık analizi: varsayılan değiştirilmez; ayrı kol olarak raporlanır
  // (EXP-002 ile aynı ilke — "iyi görünen eşiği seçip varsayılan yapmak" yok).
  const sensitivity = Object.fromEntries(
    [0.7, 0.6, 0.5].map((threshold) => {
      const shifted = outcomesAt(threshold);
      return [
        String(threshold),
        Object.fromEntries(
          (['hybrid_v1', 'anomaly_v1', 'hybrid', 'anomaly'] as const).map((arm) => [
            arm,
            {
              at_warning: armMetrics(shifted, arm, 'WARNING'),
              at_high_risk: armMetrics(shifted, arm, 'HIGH_RISK'),
              subtle_combination: byFamily(shifted, arm).I06_subtle_combination,
            },
          ]),
        ),
      ];
    }),
  );

  // Anomali skor dağılımı: normal oturumlar vs. olay başladıktan sonraki anlar.
  const scoreSplit = (series: ModelOutput[]) => {
    const normal: number[] = [];
    const incident: number[] = [];
    let offset = 0;
    for (const item of simulated) {
      const onset = item.scenario.onset?.getTime() ?? null;
      item.ticks.forEach((tick, index) => {
        const output = series[offset + index]!;
        if (output.quality < ANOMALY_MIN_QUALITY) {
          return;
        }
        if (item.scenario.label === 'NORMAL') {
          normal.push(output.anomaly_score);
        } else if (onset !== null && tick.at.getTime() >= onset && !tick.panicRaised) {
          incident.push(output.anomaly_score);
        }
      });
      offset += item.ticks.length;
    }
    return {
      normal_sessions: distribution(normal),
      incident_after_onset: distribution(incident),
    };
  };

  // Telemetri reddi ve geofence.
  const rejections: Record<string, { genuine: number; injected: number }> = {};
  let genuine = 0;
  let injected = 0;
  let injectedRejected = 0;
  const geofence = { conclusiveTruth: 0, matches: 0, transitions: 0, truthTransitions: 0 };
  const jitterExcess: number[] = [];
  for (const item of simulated) {
    genuine += item.genuineSamples;
    injected += item.injectedSamples;
    injectedRejected += item.injectedRejected;
    for (const [reason, tally] of item.rejections) {
      const entry = rejections[reason] ?? { genuine: 0, injected: 0 };
      entry.genuine += tally.genuine;
      entry.injected += tally.injected;
      rejections[reason] = entry;
    }
    geofence.conclusiveTruth += item.geofence.conclusiveTruth;
    geofence.matches += item.geofence.matches;
    geofence.transitions += item.geofence.transitions;
    geofence.truthTransitions += item.geofence.truthTransitions;
    if (item.scenario.family === 'N03_indoor_jitter') {
      jitterExcess.push(Math.max(0, item.geofence.transitions - item.geofence.truthTransitions));
    }
  }
  const genuineRejected = Object.values(rejections).reduce((sum, entry) => sum + entry.genuine, 0);

  // Kural tetiklenme sıklığı (oturum bazında).
  const ruleFrequency: Record<string, { normal_sessions: number; incident_sessions: number }> = {};
  for (const outcome of outcomes) {
    for (const rule of outcome.rules) {
      const entry = ruleFrequency[rule] ?? { normal_sessions: 0, incident_sessions: 0 };
      if (outcome.label === 'NORMAL') {
        entry.normal_sessions += 1;
      } else {
        entry.incident_sessions += 1;
      }
      ruleFrequency[rule] = entry;
    }
  }

  // Rota sapması (SAFETY-R09) davranışı.
  const r09 = (family: string) => {
    const group = outcomes.filter((outcome) => outcome.family === family);
    return ratio(
      group.filter((outcome) => outcome.rules.includes('SAFETY-R09')).length,
      group.length,
    );
  };

  const panicGroup = outcomes.filter((outcome) => outcome.family === 'I07_panic');

  const payload = {
    experiment: 'EXP-004',
    configuration: {
      dataset: 'synthetic',
      seed: SEED,
      sessions_per_family: PER_FAMILY,
      evaluation_tick_seconds: TICK_SECONDS,
      ruleset_version: SAFETY_RULESET_VERSION,
      aggregation_version: RISK_AGGREGATION_VERSION,
      anomaly_model_versions: { baseline: MODEL_V1, default: MODEL_V2 },
      anomaly_flag_threshold: ANOMALY_FLAG_THRESHOLD,
      anomaly_min_quality: ANOMALY_MIN_QUALITY,
      telemetry_policy: POLICY,
      geofence: {
        radius_meters: RADIUS_METERS,
        accuracy_limit_meters: ACCURACY_LIMIT_METERS,
        debounce_samples: DEBOUNCE_SAMPLES,
      },
      distance_source: 'haversine (üretimde PostGIS geography)',
      routing_provider: 'Faz 7 routing portu — haversine (gerçek rota değil)',
    },
    counts: {
      sessions: outcomes.length,
      normal_sessions: outcomes.filter((outcome) => outcome.label === 'NORMAL').length,
      incident_sessions: outcomes.filter((outcome) => outcome.label === 'INCIDENT').length,
      evaluation_ticks: allTicks.length,
    },
    arms: Object.fromEntries(
      ARMS.map((arm) => [
        arm,
        {
          at_warning: armMetrics(outcomes, arm, 'WARNING'),
          at_high_risk: armMetrics(outcomes, arm, 'HIGH_RISK'),
          // Panik deterministik yoldur; modelin ve kuralların katkısını panik
          // oturumları olmadan da görmek için (review bulgusu).
          at_warning_excluding_panic: armMetrics(withoutPanic, arm, 'WARNING'),
          at_high_risk_excluding_panic: armMetrics(withoutPanic, arm, 'HIGH_RISK'),
          pre_onset_alarm_sessions: outcomes.filter(
            (outcome) => outcome.label === 'INCIDENT' && outcome.preOnsetAlarm[arm],
          ).length,
          families: byFamily(outcomes, arm),
        },
      ]),
    ),
    holdout_seed: holdout,
    anomaly_threshold_sensitivity: sensitivity,
    anomaly_score_distribution: {
      v1: scoreSplit(outputs.v1),
      v2: scoreSplit(outputs.v2),
    },
    telemetry: {
      genuine_samples: genuine,
      injected_samples: injected,
      genuine_rejection_rate: ratio(genuineRejected, genuine),
      injected_rejection_rate: ratio(injectedRejected, injected),
      rejections_by_reason: Object.fromEntries(Object.entries(rejections).sort()),
    },
    geofence: {
      conclusive_truth_samples: geofence.conclusiveTruth,
      state_accuracy: ratio(geofence.matches, geofence.conclusiveTruth),
      debounced_transitions: geofence.transitions,
      truth_transitions: geofence.truthTransitions,
      indoor_jitter_excess_transitions_per_session: {
        mean: ratio(
          jitterExcess.reduce((a, b) => a + b, 0),
          jitterExcess.length,
        ),
        max: jitterExcess.length === 0 ? null : Math.max(...jitterExcess),
      },
    },
    rule_trigger_frequency: Object.fromEntries(Object.entries(ruleFrequency).sort()),
    route_deviation_r09: {
      moving_away_detection_rate: r09('I03_moving_away_arrival'),
      traffic_detour_false_trigger_rate: r09('N10_traffic_detour'),
      slow_traffic_false_trigger_rate: r09('N02_slow_traffic'),
    },
    // Şeffaflık: yalnız-kurallar kolunda alarm üreten normal oturumlar ve kuralları.
    rules_false_alarm_sessions: outcomes
      .filter((outcome) => outcome.label === 'NORMAL' && outcome.maxLevel.rules !== 'NORMAL')
      .map((outcome) => ({ id: outcome.id, level: outcome.maxLevel.rules, rules: outcome.rules })),
    panic: {
      note: 'Panik deterministik yoldur: simülasyonda basıldığı anda EMERGENCY (yapı gereği). Veritabanı gecikmesi ayrı ölçülür (exp-004-latency).',
      emergency_reached_rate: ratio(
        panicGroup.filter((outcome) => outcome.maxLevel.rules === 'EMERGENCY').length,
        panicGroup.length,
      ),
    },
  };

  const prettierConfig = await resolveConfig(OUTPUT);
  const serialized = await format(JSON.stringify(payload, null, 2), {
    ...prettierConfig,
    filepath: OUTPUT,
  });
  if (process.argv[2] === '--stdout') {
    process.stdout.write(serialized);
    return;
  }
  writeFileSync(OUTPUT, serialized, 'utf8');
  process.stdout.write(
    `EXP-004 yazıldı: ${OUTPUT} (${outcomes.length} oturum, ${allTicks.length} değerlendirme)\n`,
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(`EXP-004 başarısız: ${String(error)}\n`);
  process.exit(1);
});
