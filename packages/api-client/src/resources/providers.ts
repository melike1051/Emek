import { pathSegment, type ApiClient } from '../client';
import type { ProviderProfile } from './profiles';

/** Kaynak: services/api/src/providers/providers.service.ts (SKILL_LEVELS). */
export type SkillLevel = 'BEGINNER' | 'INTERMEDIATE' | 'EXPERT';

/**
 * Kaynak: services/api/src/providers/dto/provider.dto.ts (UpdateProviderProfileDto).
 * displayName 2..120, bio ≤2000, experienceYears 0..80 (1 ondalık), maxDailyBookings 1..10.
 */
export interface UpdateProviderProfileInput {
  displayName?: string;
  bio?: string;
  experienceYears?: number;
  maxDailyBookings?: number;
}

/**
 * Kaynak: ProviderSkillResponseDto. `verified` yalnızca operatör tarafından verilir;
 * eşleştirme doğrulanmamış yetkinliği saymaz (Faz 7 hard constraint).
 */
export interface ProviderSkill {
  skillId: string;
  slug: string;
  name: string;
  level: SkillLevel;
  verified: boolean;
}

/** Kaynak: ProviderServiceResponseDto — aday havuzu buradan başlar (beyan edilmeyen hizmet yok). */
export interface ProviderService {
  serviceId: string;
  slug: string;
  name: string;
  active: boolean;
}

/** Kaynak: ProviderServiceAreaResponseDto — merkez + yarıçap; serbest poligon yok. */
export interface ServiceArea {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  active: boolean;
}

/** Kaynak: AddServiceAreaDto — name 2..80, koordinat ≤6 ondalık, yarıçap 500..100000 m. */
export interface AddServiceAreaInput {
  name: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
}

/** Kaynak: services/api/src/providers/dto/availability.dto.ts (AvailabilityResponseDto). */
export interface AvailabilityWindow {
  id: string;
  startsAt: string;
  endsAt: string;
}

/**
 * Sağlayıcının kendi profili (`/providers/me*`) — hepsi PROVIDER rolü ister ve **yalnızca**
 * oturumdaki kullanıcının kaydına yazar (yol parametresi sahibi belirtmez; IDOR yüzeyi yok).
 */
export function providersApi(client: ApiClient) {
  const me = '/providers/me';
  return {
    update: (body: UpdateProviderProfileInput) => client.patch<ProviderProfile>(me, body),
    /** `DRAFT`/`REJECTED` → `PENDING_REVIEW`. Onay/ret operatöre aittir. */
    submit: () => client.post<ProviderProfile>(`${me}/submit`),

    skills: () => client.get<ProviderSkill[]>(`${me}/skills`),
    addSkill: (skillId: string, level: SkillLevel) =>
      client.post<ProviderSkill[]>(`${me}/skills`, { skillId, level }),
    removeSkill: (skillId: string) => client.delete<void>(`${me}/skills/${pathSegment(skillId)}`),

    services: () => client.get<ProviderService[]>(`${me}/services`),
    addService: (serviceId: string) =>
      client.post<ProviderService[]>(`${me}/services`, { serviceId }),
    removeService: (serviceId: string) =>
      client.delete<void>(`${me}/services/${pathSegment(serviceId)}`),

    serviceAreas: () => client.get<ServiceArea[]>(`${me}/service-areas`),
    addServiceArea: (body: AddServiceAreaInput) =>
      client.post<ServiceArea>(`${me}/service-areas`, body),
    removeServiceArea: (areaId: string) =>
      client.delete<void>(`${me}/service-areas/${pathSegment(areaId)}`),

    /** `from`/`to` zorunludur (backend aralıksız listeyi kabul etmez). ISO 8601. */
    availability: (from: string, to: string) =>
      client.get<AvailabilityWindow[]>(`${me}/availability`, { query: { from, to } }),
    addAvailability: (startsAt: string, endsAt: string) =>
      client.post<AvailabilityWindow>(`${me}/availability`, { startsAt, endsAt }),
    removeAvailability: (availabilityId: string) =>
      client.delete<void>(`${me}/availability/${pathSegment(availabilityId)}`),
  };
}
