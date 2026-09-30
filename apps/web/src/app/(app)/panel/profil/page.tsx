import type { Metadata } from 'next';
import { ProviderProfileScreen } from './ProviderProfileScreen';

export const metadata: Metadata = { title: 'Profilim' };

export default function ProviderProfilePage() {
  return <ProviderProfileScreen />;
}
