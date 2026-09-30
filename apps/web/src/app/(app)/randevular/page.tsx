import type { Metadata } from 'next';
import { BookingsList } from './BookingsList';

export const metadata: Metadata = { title: 'Randevularım' };

export default function BookingsPage() {
  return <BookingsList />;
}
