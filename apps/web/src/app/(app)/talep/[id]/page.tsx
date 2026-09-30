import type { Metadata } from 'next';
import { RequestReview } from './RequestReview';

export const metadata: Metadata = { title: 'Talebiniz' };

export default async function RequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RequestReview requestId={id} />;
}
