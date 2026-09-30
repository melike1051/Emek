import type { ApiClient } from '../client';

/** Kaynak: services/api/src/catalog/catalog.service.ts (ServiceCategory). Katalog herkese açıktır. */
export interface ServiceCategory {
  id: string;
  slug: string;
  name: string;
  description: string | null;
}

/** Kaynak: services/api/src/catalog/catalog.service.ts (ServiceDefinition). */
export interface ServiceDefinition {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  categoryId: string;
  categorySlug: string;
  defaultDurationMinutes: number | null;
  pricingModel: 'FIXED' | 'HOURLY';
}

/** Kaynak: services/api/src/catalog/catalog.service.ts (Skill). */
export interface Skill {
  id: string;
  slug: string;
  name: string;
}

export function catalogApi(client: ApiClient) {
  return {
    categories: () => client.get<ServiceCategory[]>('/service-categories'),
    services: (categorySlug?: string) =>
      client.get<ServiceDefinition[]>('/services', { query: { categorySlug } }),
    skills: () => client.get<Skill[]>('/skills'),
  };
}
