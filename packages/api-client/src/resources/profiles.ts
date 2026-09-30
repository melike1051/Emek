import type { ApiClient } from '../client';
import { ApiError } from '../errors';

/** Kaynak: services/api/src/customers/dto (CustomerProfileResponseDto). */
export interface CustomerProfile {
  userId: string;
  displayName: string;
  preferences: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** Kaynak: services/api/src/providers/providers.service.ts (PROVIDER_STATES). */
export type ProviderState = 'DRAFT' | 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';

/** Kaynak: services/api/src/providers/dto/provider.dto.ts (ProviderProfileResponseDto). */
export interface ProviderProfile {
  userId: string;
  displayName: string;
  bio: string | null;
  experienceYears: number | null;
  ratingAvg: number | null;
  ratingCount: number;
  maxDailyBookings: number;
  state: ProviderState;
  createdAt: string;
  updatedAt: string;
}

/** Kaynak: services/api/src/customers/dto (CreateCustomerProfileDto) — displayName 2..120. */
export interface CreateCustomerProfileInput {
  displayName: string;
  preferences?: Record<string, unknown>;
}

/** Kaynak: services/api/src/providers/dto/provider.dto.ts (CreateProviderProfileDto). */
export interface CreateProviderProfileInput {
  displayName: string;
  bio?: string;
  experienceYears?: number;
}

/** Profil henüz yoksa backend `404 PROFILE_NOT_FOUND` döner; bu "hata" değil, durumdur. */
async function orNullIfMissing<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch (error) {
    if (error instanceof ApiError && error.code === 'PROFILE_NOT_FOUND') return null;
    throw error;
  }
}

export function profilesApi(client: ApiClient) {
  return {
    customer: () => orNullIfMissing(client.get<CustomerProfile>('/customers/me')),
    provider: () => orNullIfMissing(client.get<ProviderProfile>('/providers/me')),
    createCustomer: (body: CreateCustomerProfileInput) =>
      client.post<CustomerProfile>('/customers/profile', body),
    createProvider: (body: CreateProviderProfileInput) =>
      client.post<ProviderProfile>('/providers/profile', body),
  };
}
