import type { Metadata } from 'next';
import { ProofScreen } from './ProofScreen';

export const metadata: Metadata = { title: 'Dijital İspat' };

export default async function ProofPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ProofScreen bookingId={id} />;
}
