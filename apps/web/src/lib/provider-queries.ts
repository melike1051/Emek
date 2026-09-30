import { providersApi } from '@emek/api-client';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '@/providers/AppProviders';

/** Sağlayıcı ekranlarının ortak sorgu anahtarları — yazma sonrası aynı anahtar geçersizlenir. */
export const PROVIDER_KEYS = {
  all: ['provider'] as const,
  services: ['provider', 'services'] as const,
  skills: ['provider', 'skills'] as const,
  areas: ['provider', 'areas'] as const,
  availability: (from: string, to: string) => ['provider', 'availability', from, to] as const,
  upcoming: ['provider', 'availability', 'upcoming'] as const,
};

const UPCOMING_DAYS = 30;

/** Hazırlık listesi ve panel için: hizmetler, bölgeler ve önümüzdeki 30 günün müsaitliği. */
export function useProviderQueries() {
  const api = useApi();
  const providers = providersApi(api);
  const services = useQuery({ queryKey: PROVIDER_KEYS.services, queryFn: providers.services });
  const areas = useQuery({ queryKey: PROVIDER_KEYS.areas, queryFn: providers.serviceAreas });
  const upcoming = useQuery({
    queryKey: PROVIDER_KEYS.upcoming,
    queryFn: () => {
      const from = new Date();
      const to = new Date(from.getTime() + UPCOMING_DAYS * 24 * 60 * 60 * 1000);
      return providers.availability(from.toISOString(), to.toISOString());
    },
  });
  return { services, areas, upcoming };
}
