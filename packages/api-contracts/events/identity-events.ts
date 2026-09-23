import { z } from 'zod';

export const UserRegisteredSchema = z.object({
  userId: z.string().uuid(),
  roles: z.array(z.string()),
});

export type UserRegisteredEventPayload = z.infer<typeof UserRegisteredSchema>;

export const IdentityVerifiedSchema = z.object({
  userId: z.string().uuid(),
  verificationLevel: z.string(),
  assuranceLevel: z.string(),
});

export type IdentityVerifiedEventPayload = z.infer<typeof IdentityVerifiedSchema>;
