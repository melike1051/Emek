'use client';

import { Badge, Button, ErrorState, TextField } from '@emek/ui';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import type { ConfirmationResult } from 'firebase/auth';
// Yalnız tip: Firebase SDK'sı bu ekranın paketine girmez (create-adapter.ts dinamik yükler).
import type { FirebaseAuthAdapter } from '@/lib/auth/firebase-adapter';
import type { MockAuthAdapter } from '@/lib/auth/mock-adapter';
import { firebaseAuthMessage, normalizeTrPhone } from '@/lib/auth/phone';
import { safeNextPath } from '@/lib/auth/redirect';
import { toDisplayError } from '@/lib/errors';
import { useSession } from '@/providers/AppProviders';
import styles from '../auth.module.css';

export function LoginScreen() {
  const { auth, authState, session, sessionError, refreshSession } = useSession();
  const router = useRouter();
  const next = useSearchParams().get('next');

  // Oturum kurulduysa: istenen sayfaya (güvenli) ya da varsayılan ana sayfaya.
  useEffect(() => {
    if (authState === 'signedIn' && session) {
      router.replace(safeNextPath(next, '/'));
    }
  }, [authState, session, next, router]);

  return (
    <>
      <div className={styles.intro}>
        <Badge tone="neutral">Operasyon</Badge>
        <h1>Emek Operasyon</h1>
        <p className={styles.lead}>
          Yalnızca ADMIN ve SUPPORT rolündeki ekip üyeleri içindir. Her işlem kayıt altına alınır.
        </p>
      </div>
      {sessionError && authState === 'signedIn' ? (
        <ErrorState
          title="Oturum açılamadı"
          {...toDisplayError(sessionError)}
          onRetry={() => void refreshSession()}
        />
      ) : auth?.mode === 'mock' ? (
        <MockLoginForm adapter={auth as MockAuthAdapter} />
      ) : auth?.mode === 'firebase' ? (
        <PhoneLoginForm adapter={auth as FirebaseAuthAdapter} />
      ) : null}
    </>
  );
}

function PhoneLoginForm({ adapter }: { adapter: FirebaseAuthAdapter }) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [confirmation, setConfirmation] = useState<ConfirmationResult | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  async function sendCode(event: FormEvent) {
    event.preventDefault();
    const normalized = normalizeTrPhone(phone);
    if (!normalized) {
      setError('Geçerli bir cep telefonu girin (ör. 0532 111 22 33).');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      setConfirmation(await adapter.sendCode(normalized, 'recaptcha-container'));
    } catch (caught) {
      setError(firebaseAuthMessage((caught as { code?: string }).code));
    } finally {
      setBusy(false);
    }
  }

  async function verify(event: FormEvent) {
    event.preventDefault();
    if (!confirmation) return;
    setBusy(true);
    setError(undefined);
    try {
      await confirmation.confirm(code.trim());
      // onIdTokenChanged → oturum kurulur → yönlendirme LoginScreen'de.
    } catch (caught) {
      setError(firebaseAuthMessage((caught as { code?: string }).code));
      setBusy(false);
    }
  }

  return confirmation === null ? (
    <form className={styles.form} onSubmit={sendCode} noValidate>
      <TextField
        label="Cep telefonu"
        type="tel"
        inputMode="tel"
        autoComplete="tel-national"
        placeholder="0532 111 22 33"
        value={phone}
        onChange={(event) => setPhone(event.target.value)}
        error={error}
        required
      />
      <div id="recaptcha-container" />
      <Button type="submit" size="lg" fullWidth loading={busy}>
        Kod gönder
      </Button>
    </form>
  ) : (
    <form className={styles.form} onSubmit={verify} noValidate>
      <TextField
        label="Doğrulama kodu"
        hint="Telefonunuza gelen 6 haneli kod"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        value={code}
        onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
        error={error}
        required
      />
      <Button type="submit" size="lg" fullWidth loading={busy} disabled={code.length !== 6}>
        Giriş yap
      </Button>
      <p className={styles.footnote}>
        <button type="button" className={styles.linkButton} onClick={() => setConfirmation(null)}>
          Numarayı değiştir
        </button>
      </p>
    </form>
  );
}

function MockLoginForm({ adapter }: { adapter: MockAuthAdapter }) {
  const [subject, setSubject] = useState('dev-admin');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [phoneError, setPhoneError] = useState<string | undefined>();

  function submit(event: FormEvent) {
    event.preventDefault();
    // Backend hesap oluştururken iletişim bilgisi ister (AUTH_CONTACT_REQUIRED).
    const normalized = normalizeTrPhone(phone);
    if (normalized === null) {
      setPhoneError('Geçerli bir cep telefonu girin (ör. 0532 111 22 33).');
      return;
    }
    setPhoneError(undefined);
    try {
      adapter.signIn(subject, normalized);
    } catch (caught) {
      setError((caught as Error).message);
    }
  }

  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      <p className={styles.devNote}>
        Geliştirici girişi — yalnızca yerel ortamda (backend <code>AUTH_PROVIDER=mock</code>). Aynı
        kimlik her seferinde aynı kullanıcıyı açar.
      </p>
      <TextField
        label="Geliştirici kimliği"
        value={subject}
        onChange={(event) => setSubject(event.target.value)}
        error={error}
        required
      />
      <TextField
        label="Cep telefonu"
        type="tel"
        placeholder="0532 111 22 33"
        value={phone}
        onChange={(event) => setPhone(event.target.value)}
        error={phoneError}
        required
      />
      <Button type="submit" size="lg" fullWidth>
        Giriş yap
      </Button>
    </form>
  );
}
