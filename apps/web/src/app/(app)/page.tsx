import type { Metadata } from 'next';
import { ExploreHome } from './ExploreHome';

export const metadata: Metadata = { title: 'Keşfet & Talep' };

export default function HomePage() {
  return <ExploreHome />;
}
