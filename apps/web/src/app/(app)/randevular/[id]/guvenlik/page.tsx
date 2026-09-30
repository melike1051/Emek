import type { Metadata } from 'next';
import { SafetyScreen } from './SafetyScreen';

export const metadata: Metadata = { title: 'Güvenlik & Oturum' };

export default async function SafetyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SafetyScreen bookingId={id} />;
}
