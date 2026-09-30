import type { Metadata } from 'next';
import { ServicesScreen } from './ServicesScreen';

export const metadata: Metadata = { title: 'Hizmetlerim' };

export default function ProviderServicesPage() {
  return <ServicesScreen />;
}
