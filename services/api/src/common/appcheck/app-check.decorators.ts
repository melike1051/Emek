import { SetMetadata } from '@nestjs/common';

export const SKIP_APP_CHECK_KEY = 'emek:skip-app-check';

/**
 * Rotayı App Check zorunluluğunun dışında bırakır.
 *
 * Yalnızca **istemci uygulamasından gelmeyen** uçlar için kullanılır: sağlayıcı
 * webhook'ları, kimlik callback'i, health probe'ları ve sunucudan sunucuya
 * çağrılar. Bu uçların kendi doğrulama modeli vardır (imza, paylaşılan sır) ve
 * App Check onları hiçbir zaman geçemez — çünkü ortada bir mobil uygulama yoktur.
 *
 * İşaretlemek bilinçli ve görünür bir karar olmalıdır: varsayılan zorunluluktur.
 */
export const SkipAppCheck = (): MethodDecorator & ClassDecorator =>
  SetMetadata(SKIP_APP_CHECK_KEY, true);
