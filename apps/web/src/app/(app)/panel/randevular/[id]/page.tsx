import type { Metadata } from 'next';
import { ProviderBookingDetail } from './ProviderBookingDetail';

export const metadata: Metadata = { title: 'Randevu' };

export default async function ProviderBookingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ProviderBookingDetail bookingId={id} />;
}
