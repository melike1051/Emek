import type { Metadata } from 'next';
import { AvailabilityScreen } from './AvailabilityScreen';

export const metadata: Metadata = { title: 'Müsaitliğim' };

export default function ProviderAvailabilityPage() {
  return <AvailabilityScreen />;
}
