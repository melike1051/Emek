import type { Metadata } from 'next';
import { Suspense } from 'react';
import { PaymentsScreen } from './PaymentsScreen';

export const metadata: Metadata = { title: 'Ödemeler' };

export default function PaymentsPage() {
  return (
    <Suspense>
      <PaymentsScreen />
    </Suspense>
  );
}
