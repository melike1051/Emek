import type { Metadata } from 'next';
import { OverviewScreen } from './OverviewScreen';

export const metadata: Metadata = { title: 'Genel bakış' };

export default function OverviewPage() {
  return <OverviewScreen />;
}
