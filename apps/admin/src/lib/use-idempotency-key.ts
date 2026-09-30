import { useCallback, useRef } from 'react';

/**
 * Bir kullanıcı eyleminin `Idempotency-Key`'i. Aynı eylemin tekrarında (ağ hatası sonrası
 * "Tekrar dene") **aynı** anahtar gider ki backend komutu ikinci kez işlemesin; eylem başarıyla
 * bitince `rotate()` ile yeni anahtara geçilir. Anahtar belleğe yazılır, depolamaya asla.
 */
export function useIdempotencyKey(): { current: () => string; rotate: () => void } {
  const key = useRef<string | null>(null);
  const current = useCallback(() => {
    key.current ??= crypto.randomUUID();
    return key.current;
  }, []);
  const rotate = useCallback(() => {
    key.current = null;
  }, []);
  return { current, rotate };
}
