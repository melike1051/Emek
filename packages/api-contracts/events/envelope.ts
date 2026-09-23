import { z } from 'zod';

export const ENVELOPE_SCHEMA_VERSION = 1;

export const DomainEventEnvelopeSchema = z.object({
  eventId: z.string().uuid(),
  eventType: z.string(),
  eventVersion: z.number(),
  schemaVersion: z.number(),
  occurredAt: z.string().datetime(), // ISO 8601
  aggregateType: z.string(),
  aggregateId: z.string().uuid(),
  producer: z.string(),
  correlationId: z.string().nullable(),
  payload: z.object({}).passthrough(),
});

export interface DomainEventEnvelope<T = Record<string, unknown>> {
  eventId: string;
  eventType: string;
  eventVersion: number;
  schemaVersion: number;
  occurredAt: string;
  aggregateType: string;
  aggregateId: string;
  producer: string;
  correlationId: string | null;
  payload: T;
}

export function validateEnvelope(data: unknown): DomainEventEnvelope {
  return DomainEventEnvelopeSchema.parse(data) as DomainEventEnvelope;
}
