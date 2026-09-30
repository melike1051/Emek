import type { Metadata } from 'next';
import { Suspense } from 'react';
import { LoginScreen } from './LoginScreen';

export const metadata: Metadata = { title: 'Giriş' };

export default function LoginPage() {
  return (
    <Suspense>
      <LoginScreen />
    </Suspense>
  );
}
