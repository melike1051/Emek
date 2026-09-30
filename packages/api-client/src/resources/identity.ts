import type { ApiClient } from '../client';

/**
 * Kaynak: services/api/src/identity/dto/identity.dto.ts (IdentityStatusResponseDto).
 * Ham kimlik verisi yoktur — yalnızca seviye ve doğrulanma bilgisi (ADR-0004).
 */
export interface IdentityStatus {
  level: string;
  identityVerified: boolean;
  assuranceLevel: string | null;
  verifiedAt: string | null;
  provider: string | null;
}

export function identityApi(client: ApiClient) {
  return {
    status: () => client.get<IdentityStatus>('/verification/status'),
  };
}
