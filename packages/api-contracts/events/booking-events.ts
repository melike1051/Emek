import { z } from 'zod';

export const BookingCreatedSchema = z.object({
  bookingId: z.string().uuid(),
  customerId: z.string().uuid(),
  providerId: z.string().uuid().nullable(),
  serviceId: z.string().uuid(),
  scheduledStart: z.string().datetime(),
  scheduledEnd: z.string().datetime(),
});

export type BookingCreatedEventPayload = z.infer<typeof BookingCreatedSchema>;

export const BookingMatchedSchema = z.object({
  bookingId: z.string().uuid(),
  requestId: z.string().uuid(),
  providerId: z.string().uuid(),
  runId: z.string(),
  algorithmVersion: z.string(),
});

export type BookingMatchedEventPayload = z.infer<typeof BookingMatchedSchema>;

export const BookingConfirmedSchema = z.object({
  bookingId: z.string().uuid(),
  status: z.string(),
});

export type BookingConfirmedEventPayload = z.infer<typeof BookingConfirmedSchema>;

export const BookingCancelledSchema = z.object({
  bookingId: z.string().uuid(),
  status: z.string(),
  cancelledBy: z.string().uuid().nullable(),
});

export type BookingCancelledEventPayload = z.infer<typeof BookingCancelledSchema>;

export const ServiceStartedSchema = z.object({
  bookingId: z.string().uuid(),
  safetySessionId: z.string().uuid().nullable(),
  startedAt: z.string().datetime(),
});

export type ServiceStartedEventPayload = z.infer<typeof ServiceStartedSchema>;

export const ServiceCompletedSchema = z.object({
  bookingId: z.string().uuid(),
  completedAt: z.string().datetime(),
  durationMinutes: z.number(),
});

export type ServiceCompletedEventPayload = z.infer<typeof ServiceCompletedSchema>;
