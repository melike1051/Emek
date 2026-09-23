import { z } from 'zod';

export const PaymentAuthorizedSchema = z.object({
  paymentId: z.string().uuid(),
  bookingId: z.string().uuid(),
  amountMinor: z.number(),
  currency: z.string(),
});

export type PaymentAuthorizedEventPayload = z.infer<typeof PaymentAuthorizedSchema>;

export const PaymentReleasedSchema = z.object({
  paymentId: z.string().uuid(),
  bookingId: z.string().uuid(),
  amountMinor: z.number(),
});

export type PaymentReleasedEventPayload = z.infer<typeof PaymentReleasedSchema>;

export const PaymentRefundedSchema = z.object({
  paymentId: z.string().uuid(),
  bookingId: z.string().uuid(),
  refundedMinor: z.number(),
  partial: z.boolean(),
});

export type PaymentRefundedEventPayload = z.infer<typeof PaymentRefundedSchema>;
