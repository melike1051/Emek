import type { Logger } from 'pino';

/**
 * Hata sınıflandırıcı.
 *
 * Bir consumer hatasının geçici (yeniden denenebilir) mi yoksa kalıcı
 * (yeniden denemenin anlamsız olduğu) mı olduğunu belirler.
 *
 * Sınıflandırma kararı güvenli yöndedir: bilinmeyen hata TRANSIENT sayılır
 * çünkü erken vazgeçmek (PERMANENT) veri kaybına, yanlış deneme ise
 * yalnızca gecikmeye neden olur.
 */

import { FailureClassification } from './event-consumer';

/** Kalıcı hata kodu kalıpları: yeniden denemenin sonucu değiştirmeyeceği hatalar. */
const PERMANENT_ERROR_PATTERNS = [
  'SyntaxError',
  'ZodError',
  'ValidationError',
  'TypeError',
  'RangeError',
  'UnsupportedEventVersion',
  'MalformedEvent',
  'InvalidPayload',
  'InvariantViolation',
] as const;

/** Geçici hata kodu kalıpları. */
const TRANSIENT_ERROR_PATTERNS = [
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'TimeoutError',
  'AbortError',
  'ServiceUnavailable',
  'TooManyRequests',
  // PostgreSQL geçici hataları
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
  '08006', // connection_failure
] as const;

export function classifyFailure(error: unknown, logger?: Logger): FailureClassification {
  if (!(error instanceof Error)) {
    // Error nesnesi bile değilse bilinmeyen — güvenli yön: geçici
    return FailureClassification.TRANSIENT;
  }

  const errorName = error.name;
  const errorMessage = error.message;
  const errorCode = (error as Error & { code?: string }).code;

  // Kalıcı hata kontrolü
  for (const pattern of PERMANENT_ERROR_PATTERNS) {
    if (errorName === pattern || errorName.includes(pattern)) {
      return FailureClassification.PERMANENT;
    }
  }

  // Geçici hata kontrolü (kod tabanlı)
  if (errorCode !== undefined) {
    for (const pattern of TRANSIENT_ERROR_PATTERNS) {
      if (errorCode === pattern) {
        return FailureClassification.TRANSIENT;
      }
    }
  }

  // Geçici hata kontrolü (isim tabanlı)
  for (const pattern of TRANSIENT_ERROR_PATTERNS) {
    if (errorName === pattern || errorMessage.includes(pattern)) {
      return FailureClassification.TRANSIENT;
    }
  }

  // Bilinmeyen hata: güvenli yön geçicidir
  logger?.warn(
    { errorName, errorCode },
    'Sınıflandırılamayan consumer hatası, TRANSIENT olarak işaretleniyor',
  );
  return FailureClassification.TRANSIENT;
}

/**
 * Belirli bir hata sınıflandırması döndüren Error alt sınıfları.
 * Consumer'lar bu sınıfları fırlatarak sınıflandırmayı açıkça belirtebilir.
 */
export class UnsupportedEventVersionError extends Error {
  override readonly name = 'UnsupportedEventVersion';
  constructor(eventType: string, version: number) {
    super(`Desteklenmeyen event sürümü: ${eventType} v${version}`);
  }
}

export class MalformedEventError extends Error {
  override readonly name = 'MalformedEvent';
  constructor(reason: string) {
    super(`Bozuk event: ${reason}`);
  }
}
