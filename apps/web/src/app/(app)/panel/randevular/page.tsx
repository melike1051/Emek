import type { Metadata } from 'next';
import { ProviderBookingsList } from './ProviderBookingsList';

export const metadata: Metadata = { title: 'Randevular' };

export default function ProviderBookingsPage() {
  return <ProviderBookingsList />;
}
