import { ApiError } from '../errors';
import { pathSegment, type ApiClient } from '../client';

/**
 * Kaynak: services/api/src/safety/dto/safety.dto.ts (SafetySessionParticipantDto).
 * Bilinçli olarak **dar**dır (ADR-0019 §9): risk seviyesi, kurallar, geofence ve koordinat yoktur;
 * karşı tarafın paniği gösterilmez.
 */
export interface SafetySession {
  sessionId: string;
  bookingId: string;
  status: string;
  acceptsTelemetry: boolean;
  telemetryExpectedFromYou: boolean;
  telemetryIntervalSeconds: number;
  lastSequence: number;
  emergencyActive: boolean;
  panicRaisedAt: string | null;
  closedAt: string | null;
}

/** Kaynak: services/api/src/safety/panic.service.ts (PANIC_CATEGORIES). */
export type PanicCategory = 'THREAT' | 'HEALTH' | 'OTHER';

/** Kaynak: PanicResponseDto. `duplicate`: panik zaten kayıtlıydı, yan etki yok. */
export interface PanicResult {
  sessionId: string;
  eventId: string;
  raisedAt: string;
  duplicate: boolean;
  bookingHoldApplied: boolean;
}

export function safetyApi(client: ApiClient) {
  return {
    /** Oturum henüz açılmadıysa `SAFETY_SESSION_NOT_FOUND` → `null` (durumdur, hata değil). */
    sessionForBooking: async (bookingId: string): Promise<SafetySession | null> => {
      try {
        return await client.get<SafetySession>(
          `/bookings/${pathSegment(bookingId)}/safety-session`,
        );
      } catch (error) {
        if (error instanceof ApiError && error.code === 'SAFETY_SESSION_NOT_FOUND') return null;
        throw error;
      }
    },
    /**
     * Panik — backend oran sınırı uygulamaz ve tekrar basışı kendisi tekilleştirir;
     * Idempotency-Key gönderilmez ki Redis kesintisi paniği bloklamasın (ADR-0008 §3).
     */
    panic: (sessionId: string, category?: PanicCategory) =>
      client.post<PanicResult>(
        `/safety/sessions/${pathSegment(sessionId)}/panic`,
        category ? { category } : {},
      ),
  };
}
