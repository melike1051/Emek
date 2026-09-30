import type { Metadata } from 'next';
import { SessionDetail } from './SessionDetail';

export const metadata: Metadata = { title: 'Güvenlik oturumu' };

export default async function SessionPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  return <SessionDetail sessionId={sessionId} />;
}
