import type { Metadata } from 'next';
import { BookingDetail } from './BookingDetail';

export const metadata: Metadata = { title: 'Randevu' };

export default async function BookingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <BookingDetail bookingId={id} />;
}
