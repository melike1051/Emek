import styles from './Logo.module.css';

/** Emek kelime işareti: yaprak monogramı + "emek." (Stitch marka logosu referansı). */
export function Logo() {
  return (
    <span className={styles.logo}>
      <span className={styles.mark} aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <path d="M12 20c0-6 2-10 7-13-1 6-3 10-7 13z" fill="var(--color-secondary)" />
          <path d="M12 20c0-5-2-9-6-11 0 5 2 9 6 11z" fill="var(--color-primary)" />
          <path d="M12 21v-6" stroke="var(--color-primary-strong)" strokeWidth="1.5" />
        </svg>
      </span>
      <span className={styles.word}>
        emek<span className={styles.dot}>.</span>
      </span>
    </span>
  );
}
