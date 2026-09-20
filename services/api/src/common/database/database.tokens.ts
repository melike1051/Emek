/**
 * DI token'ları modül dosyasından ayrı tutulur.
 *
 * Aksi halde modül → provider → modül şeklinde döngüsel import oluşur
 * (Nest bunu "circular dependency" olarak reddeder).
 */
export const POSTGRES_POOL = Symbol('POSTGRES_POOL');
