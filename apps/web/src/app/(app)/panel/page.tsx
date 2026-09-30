import type { Metadata } from 'next';
import { ProviderHome } from './ProviderHome';

export const metadata: Metadata = { title: 'Atölyem' };

export default function ProviderPanelPage() {
  return <ProviderHome />;
}
