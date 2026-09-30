import type { Metadata } from 'next';
import { ServiceAreasScreen } from './ServiceAreasScreen';

export const metadata: Metadata = { title: 'Hizmet bölgelerim' };

export default function ProviderAreasPage() {
  return <ServiceAreasScreen />;
}
