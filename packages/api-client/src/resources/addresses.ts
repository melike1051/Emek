import { pathSegment, type ApiClient } from '../client';

/** Kaynak: services/api/src/addresses/dto (AddressResponseDto). */
export interface Address {
  id: string;
  label: string | null;
  city: string;
  district: string;
  line: string;
  latitude: number;
  longitude: number;
}

/** Kaynak: CreateAddressDto — city/district 2..100, line 5..500, label ≤60. */
export interface CreateAddressInput {
  label?: string;
  city: string;
  district: string;
  line: string;
  latitude: number;
  longitude: number;
}

export function addressesApi(client: ApiClient) {
  return {
    list: () => client.get<Address[]>('/addresses'),
    create: (body: CreateAddressInput) => client.post<Address>('/addresses', body),
    archive: (id: string) => client.delete<void>(`/addresses/${pathSegment(id)}`),
  };
}
