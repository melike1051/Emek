import type { Metadata } from 'next';
import { BookingsScreen } from './BookingsScreen';

export const metadata: Metadata = { title: 'Randevular' };

export default function BookingsPage() {
  return <BookingsScreen />;
}
