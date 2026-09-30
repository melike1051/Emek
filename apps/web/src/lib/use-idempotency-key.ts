import { useCallback, useRef } from 'react';

/**
 * Bir kullanıcı eyleminin `Idempotency-Key`'i. Aynı eylemin **aynı gövdeyle** tekrarında (ağ
 * hatası sonrası "Tekrar dene") **aynı** anahtar gider ki backend komutu ikinci kez işlemesin.
 * Gövde değişince (`signature`) yeni anahtar üretilir: backend gövde parmak izini karşılaştırır ve
 * aynı anahtarla farklı gövdeyi `IDEMPOTENCY_KEY_REUSED` ile kalıcı olarak reddeder — kayıp
 * yanıttan sonra formu düzelten kullanıcı aksi hâlde eylemi hiç tamamlayamazdı. Eylem başarıyla
 * bitince `rotate()` ile yeni anahtara geçilir. Anahtar belleğe yazılır, depolamaya asla.
 */
export function useIdempotencyKey(): {
  current: (signature?: string) => string;
  rotate: () => void;
} {
  const entry = useRef<{ key: string; signature: string } | null>(null);
  const current = useCallback((signature = '') => {
    if (entry.current === null || entry.current.signature !== signature) {
      entry.current = { key: crypto.randomUUID(), signature };
    }
    return entry.current.key;
  }, []);
  const rotate = useCallback(() => {
    entry.current = null;
  }, []);
  return { current, rotate };
}
