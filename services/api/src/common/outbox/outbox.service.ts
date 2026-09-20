import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { getRequestContext } from '../logging/request-context';

/** Event sözlüğü: docs/architecture/event-catalog.md ile aynı isimler. */
export const EventType = {
  USER_REGISTERED: 'UserRegistered',
  PROVIDER_PROFILE_SUBMITTED: 'ProviderProfileSubmitted',
  IDENTITY_VERIFIED: 'IdentityVerified',
  BOOKING_CREATED: 'BookingCreated',
  BOOKING_CONFIRMED: 'BookingConfirmed',
  BOOKING_CANCELLED: 'BookingCancelled',
  SERVICE_STARTED: 'ServiceStarted',
  SERVICE_COMPLETED: 'ServiceCompleted',
} as const;

export type EventTypeValue = (typeof EventType)[keyof typeof EventType];

export interface DomainEventInput {
  eventType: EventTypeValue;
  eventVersion?: number;
  subjectType: string;
  subjectId?: string;
  /** Yalnızca referans/id taşır; kişisel veri event payload'ında gitmez (event-catalog.md §1). */
  payload: Record<string, unknown>;
}

/**
 * Transactional outbox (ADR-0010 §2).
 *
 * `enqueue`, domain değişikliğiyle **aynı** `PoolClient` üzerinde çağrılır: transaction
 * geri alınırsa event de geri alınır, commit edilirse event kesin olarak kayıtlıdır.
 * Doğrudan transport'a yayın yapmak "commit edildi ama event kayboldu" durumunu üretir.
 */
@Injectable()
export class OutboxService {
  async enqueue(client: PoolClient, event: DomainEventInput): Promise<string> {
    const correlationId = getRequestContext()?.requestId ?? null;

    const result = await client.query<{ event_id: string }>(
      `INSERT INTO outbox
         (event_type, event_version, subject_type, subject_id, payload, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING event_id`,
      [
        event.eventType,
        event.eventVersion ?? 1,
        event.subjectType,
        event.subjectId ?? null,
        JSON.stringify(event.payload),
        correlationId,
      ],
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error('outbox kaydı oluşturulamadı');
    }
    return row.event_id;
  }
}
