import type { Metadata } from 'next';
import { DisputesScreen } from './DisputesScreen';

export const metadata: Metadata = { title: 'İtirazlar' };

export default function DisputesPage() {
  return <DisputesScreen />;
}
