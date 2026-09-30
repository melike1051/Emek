import styles from './Avatar.module.css';

export interface AvatarProps {
  name: string;
  size?: 'sm' | 'md' | 'lg';
  verified?: boolean;
}

/** "Hatice Yılmaz" → "HY". Türkçe büyük harf kuralı (i → İ) uygulanır. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return `${first}${last}`.toLocaleUpperCase('tr-TR');
}

/** Monogram avatar — fotoğraf yoksa baş harfler; doğrulanmış kullanıcıda sage onay işareti. */
export function Avatar({ name, size = 'md', verified = false }: AvatarProps) {
  return (
    <span className={`${styles.avatar} ${styles[size]}`} role="img" aria-label={name}>
      <span aria-hidden="true">{initialsOf(name)}</span>
      {verified ? (
        <span className={styles.verified} title="Kimliği doğrulandı">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4 8.5l2.5 2.5L12 5.5" fill="none" stroke="currentColor" strokeWidth="2" />
          </svg>
          <span className="emek-visually-hidden">Kimliği doğrulandı</span>
        </span>
      ) : null}
    </span>
  );
}
