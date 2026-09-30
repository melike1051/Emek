import type { Metadata } from 'next';
import { AccountScreen } from './AccountScreen';

export const metadata: Metadata = { title: 'Profilim' };

export default function AccountPage() {
  return <AccountScreen />;
}
