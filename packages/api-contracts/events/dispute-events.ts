import { z } from 'zod';

export const DisputeOpenedSchema = z.object({
  disputeId: z.string().uuid(),
  bookingId: z.string().uuid(),
  reason: z.string(),
});

export type DisputeOpenedEventPayload = z.infer<typeof DisputeOpenedSchema>;

export const DisputeResolvedSchema = z.object({
  disputeId: z.string().uuid(),
  bookingId: z.string().uuid(),
  resolution: z.string(),
});

export type DisputeResolvedEventPayload = z.infer<typeof DisputeResolvedSchema>;
