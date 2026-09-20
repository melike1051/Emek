import { Injectable } from '@nestjs/common';
import type { AppEnv } from './env.schema';

/**
 * Doğrulanmış yapılandırmayı DI üzerinden sunar.
 *
 * `env` zaten şema ile doğrulanmış ve tiplenmiş olduğu için alan başına getir
 * yazılmaz — aradaki her getir yalnızca tekrar eden koddur. Yalnızca türetilmiş
 * değerler metot/getter olur.
 */
@Injectable()
export class AppConfigService {
  constructor(readonly env: AppEnv) {}

  get isProduction(): boolean {
    return this.env.NODE_ENV === 'production';
  }

  get isDevelopment(): boolean {
    return this.env.NODE_ENV === 'development';
  }
}
