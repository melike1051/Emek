import type { Metadata } from 'next';
import { ProviderReviews } from './ProviderReviews';

export const metadata: Metadata = { title: 'Sağlayıcı değerlendirmeleri' };

export default async function ProviderReviewsPage({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  const { userId } = await params;
  return <ProviderReviews userId={userId} />;
}
