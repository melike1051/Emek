import { haversineMeters } from './geo';
import type { TelemetryRejectionReason } from './safety.constants';

/**
 * Telemetri doğrulayıcı — saf fonksiyon.
 *
 * Telemetri **güvenilmez istemci girdisidir** (ADR-0008 §7). İstemci konumu, zamanı
 * ve sıra numarasını bildirir; sunucu bunların hiçbirine olduğu gibi güvenmez:
 *
 * - **Sıra numarası** oturum içinde kesin artan olmalıdır. Görülmüş bir numara
 *   (ağ yeniden denemesi ya da replay) durumu değiştirmez.
 * - **Zaman** sunucu saatine göre sınırlanır: gelecekten gelen örnek reddedilir,
 *   gecikmeli teslim penceresinden eski örnek reddedilir, izleme başlamadan önce
 *   alınmış örnek reddedilir (amaç sınırlaması: oturum dışı konum kabul edilmez).
 * - **Hareket** fiziksel olarak mümkün olmalıdır. Hız, iki örneğin doğruluk
 *   daireleri **düşüldükten sonra** hesaplanır: jitter'ı "imkânsız sıçrama" saymak,
 *   şehir içinde zayıf sinyalde çalışan sağlayıcıyı sahtekâr gibi gösterirdi.
 *
 * Aynı fonksiyon üretimde (ingest) ve EXP-004 harness'inde çalışır; kararın
 * ölçülen hâli ile çalışan hâli aynı koddur.
 */

export interface TelemetryPolicy {
  maxSkewSeconds: number;
  maxAgeSeconds: number;
  maxSpeedMps: number;
  /** İki örnek arasındaki asgari süre (istemci saatiyle). */
  minSpacingSeconds: number;
  /**
   * Bu kadar ardışık "imkânsız hız" retinden sonra yeni örnek çapa kabul edilir.
   *
   * Tek bir hatalı çapa (ör. cihazın ilk açılıştaki yanlış konumu), çapa
   * yenilenmezse sonraki **tüm doğru** örnekleri reddettirirdi — oturum sessizce
   * kör kalırdı. Ardışık retler tutarlı bir yeni konuma işaret eder; çapa değişir
   * ama olay `TELEMETRY_REANCHORED` ile kayda geçer ve bütünlük sayacı artmıştır.
   */
  reanchorAfter: number;
}

/** Varsayılan asgari aralık ve çapa eşiği; yapılandırma dışı sabitlerdir. */
export const TELEMETRY_MIN_SPACING_SECONDS = 5;
export const TELEMETRY_REANCHOR_AFTER = 3;

export interface TelemetryState {
  lastSequence: number;
  lastCapturedAt: Date | null;
  lastLatitude: number | null;
  lastLongitude: number | null;
  lastAccuracyMeters: number | null;
  consecutiveSpeedRejections: number;
  /** Varış izlemenin başladığı an; bundan önce alınmış örnek kabul edilmez. */
  monitoringStartedAt: Date | null;
}

export interface TelemetrySample {
  sequence: number;
  capturedAt: Date;
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  speedMps: number | null;
  headingDegrees: number | null;
  isMockLocation: boolean;
}

export type SampleVerdict =
  | { verdict: 'ACCEPTED'; reanchored: boolean }
  | { verdict: 'REJECTED'; reason: TelemetryRejectionReason };

export interface ValidationStep {
  result: SampleVerdict;
  next: TelemetryState;
}

export function validateSample(
  state: TelemetryState,
  sample: TelemetrySample,
  now: Date,
  policy: TelemetryPolicy,
): ValidationStep {
  // Replay/tekrar: durum **hiç** değişmez. Sıra numarası tüketilmez çünkü zaten tüketilmiş.
  if (sample.sequence <= state.lastSequence) {
    return { result: { verdict: 'REJECTED', reason: 'SEQUENCE_REPLAY' }, next: state };
  }

  // Bundan sonraki her ret sıra numarasını **tüketir**: aynı numarayla içeriği
  // değiştirilmiş ikinci bir gönderimin kabul edilmesi mümkün olmamalı.
  const consumed: TelemetryState = { ...state, lastSequence: sample.sequence };
  const reject = (reason: TelemetryRejectionReason, next = consumed): ValidationStep => ({
    result: { verdict: 'REJECTED', reason },
    next,
  });

  const nowMs = now.getTime();
  const capturedMs = sample.capturedAt.getTime();

  if (capturedMs > nowMs + policy.maxSkewSeconds * 1000) {
    return reject('CLOCK_SKEW_FUTURE');
  }
  if (capturedMs < nowMs - policy.maxAgeSeconds * 1000) {
    return reject('CLOCK_SKEW_STALE');
  }
  if (
    state.monitoringStartedAt !== null &&
    capturedMs < state.monitoringStartedAt.getTime() - policy.maxSkewSeconds * 1000
  ) {
    return reject('CAPTURED_BEFORE_SESSION');
  }

  if (state.lastCapturedAt !== null) {
    const elapsedMs = capturedMs - state.lastCapturedAt.getTime();
    if (elapsedMs < 0) {
      return reject('CLOCK_REGRESSION');
    }
    if (elapsedMs < policy.minSpacingSeconds * 1000) {
      return reject('TOO_FREQUENT');
    }
  }

  let reanchored = false;
  if (
    state.lastLatitude !== null &&
    state.lastLongitude !== null &&
    state.lastCapturedAt !== null
  ) {
    const distance = haversineMeters(
      { latitude: state.lastLatitude, longitude: state.lastLongitude },
      { latitude: sample.latitude, longitude: sample.longitude },
    );
    // İki belirsizlik dairesi düşülür: dairelerin kesiştiği her sıçrama
    // fiziksel olarak mümkün kabul edilir (jitter toleransı).
    const effective = Math.max(
      0,
      distance - (state.lastAccuracyMeters ?? 0) - sample.accuracyMeters,
    );
    const seconds = Math.max(1, (capturedMs - state.lastCapturedAt.getTime()) / 1000);

    if (effective / seconds > policy.maxSpeedMps) {
      const rejections = state.consecutiveSpeedRejections + 1;
      if (rejections < policy.reanchorAfter) {
        return reject('IMPOSSIBLE_SPEED', {
          ...consumed,
          consecutiveSpeedRejections: rejections,
        });
      }
      reanchored = true;
    }
  }

  return {
    result: { verdict: 'ACCEPTED', reanchored },
    next: {
      ...consumed,
      lastCapturedAt: sample.capturedAt,
      lastLatitude: sample.latitude,
      lastLongitude: sample.longitude,
      lastAccuracyMeters: sample.accuracyMeters,
      consecutiveSpeedRejections: 0,
    },
  };
}
