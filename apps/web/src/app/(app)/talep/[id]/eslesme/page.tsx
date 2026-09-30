import type { Metadata } from 'next';
import { MatchResultScreen } from './MatchResultScreen';

export const metadata: Metadata = { title: 'Eşleşme' };

export default async function MatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <MatchResultScreen requestId={id} />;
}
