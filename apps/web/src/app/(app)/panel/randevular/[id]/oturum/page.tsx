import type { Metadata } from 'next';
import { SafetyScreen } from '@/app/(app)/randevular/[id]/guvenlik/SafetyScreen';

export const metadata: Metadata = { title: 'Güvenlik & Oturum' };

export default async function ProviderSafetyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SafetyScreen bookingId={id} perspective="provider" />;
}
