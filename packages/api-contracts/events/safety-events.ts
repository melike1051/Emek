import { z } from 'zod';

export const SafetyAlertRaisedSchema = z.object({
  safetySessionId: z.string().uuid(),
  bookingId: z.string().uuid(),
  severity: z.string(),
  source: z.string(),
  eventId: z.string().uuid().nullable(),
  assessmentId: z.string().uuid().nullable(),
  raisedBy: z.string().uuid().nullable(),
  category: z.string().nullable(),
  corroborating: z.array(z.string()).nullable(), // Could be evidence IDs
});

export type SafetyAlertRaisedEventPayload = z.infer<typeof SafetyAlertRaisedSchema>;
