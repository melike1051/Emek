import type { Metadata } from 'next';
import { ProvidersScreen } from './ProvidersScreen';

export const metadata: Metadata = { title: 'Sağlayıcılar' };

export default function ProvidersPage() {
  return <ProvidersScreen />;
}
