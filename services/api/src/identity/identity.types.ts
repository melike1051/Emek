/** Veritabanı enum'larıyla birebir aynı (docs/database/schema.md). */

export const VERIFICATION_LEVELS = [
  'UNVERIFIED',
  'PHONE_VERIFIED',
  'IDENTITY_VERIFIED',
  'PROVIDER_VERIFIED',
  'FULLY_VERIFIED',
] as const;
export type VerificationLevel = (typeof VERIFICATION_LEVELS)[number];

export const VERIFICATION_STATUSES = ['PENDING', 'VERIFIED', 'REJECTED', 'EXPIRED'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

/**
 * Doğrulamanın gücü. NFC tek başına "telefonu tutan kişi = kart sahibi" kanıtı
 * değildir (ADR-0005); canlılık/yüz eşleştirme gibi ek kontroller seviyeyi yükseltir.
 */
export const ASSURANCE_LEVELS = ['LOW', 'SUBSTANTIAL', 'HIGH'] as const;
export type AssuranceLevel = (typeof ASSURANCE_LEVELS)[number];

export const VERIFICATION_PURPOSES = ['ACCOUNT_VERIFICATION', 'ACCOUNT_RECOVERY'] as const;
export type VerificationPurpose = (typeof VERIFICATION_PURPOSES)[number];

/** Seviyelerin sıralaması: "en az şu seviye" kontrolleri buna dayanır. */
const LEVEL_ORDER: Record<VerificationLevel, number> = {
  UNVERIFIED: 0,
  PHONE_VERIFIED: 1,
  IDENTITY_VERIFIED: 2,
  PROVIDER_VERIFIED: 3,
  FULLY_VERIFIED: 4,
};

export function isAtLeastLevel(actual: VerificationLevel, required: VerificationLevel): boolean {
  return LEVEL_ORDER[actual] >= LEVEL_ORDER[required];
}

const ASSURANCE_ORDER: Record<AssuranceLevel, number> = {
  LOW: 0,
  SUBSTANTIAL: 1,
  HIGH: 2,
};

export function isAtLeastAssurance(actual: AssuranceLevel, required: AssuranceLevel): boolean {
  return ASSURANCE_ORDER[actual] >= ASSURANCE_ORDER[required];
}

export interface IdentityRecord {
  userId: string;
  verificationProvider: string;
  providerSubjectId: string;
  verificationLevel: VerificationLevel;
  verificationStatus: VerificationStatus;
  assuranceLevel: AssuranceLevel;
  verifiedAt: Date | null;
  /** Hash'in kendisi domain dışına çıkmaz; yalnızca varlığı bilinir. */
  hasIdentityHash: boolean;
}

export interface VerificationAttempt {
  id: string;
  userId: string;
  provider: string;
  externalSessionId: string;
  method: string;
  purpose: VerificationPurpose;
  status: VerificationStatus;
  resultCode: string | null;
  assuranceLevel: AssuranceLevel | null;
  createdAt: Date;
  expiresAt: Date;
  completedAt: Date | null;
}
