import { HttpException } from '@nestjs/common';
import { CLIENT_MESSAGES, ERROR_STATUS, type ErrorCodeValue } from './error-codes';

export interface BusinessErrorDetails {
  /** İstemcinin ihtiyaç duyduğu yapısal bilgi. İç sistem detayı veya hassas veri içermez. */
  readonly [key: string]: unknown;
}

export interface BusinessExceptionOptions {
  /**
   * Kodun varsayılan metnini geçersiz kılar. **Yalnızca elle yazılmış, kullanıcıya
   * gösterilebilir metin** verilir; exception/DB mesajı buraya aktarılmaz.
   */
  clientMessage?: string;
  details?: BusinessErrorDetails;
}

/**
 * Domain kurallarının ihlalini temsil eden tek istisna tipi.
 *
 * Varsayılan olarak istemci mesajı koda bağlı sabit listeden gelir (`CLIENT_MESSAGES`);
 * böylece `new BusinessException(code, dbError.message)` gibi bir kaza mümkün olmaz.
 * Daha özel bir metin gerektiğinde `clientMessage` açıkça verilir.
 */
export class BusinessException extends HttpException {
  readonly code: ErrorCodeValue;
  readonly details?: BusinessErrorDetails;

  constructor(code: ErrorCodeValue, options: BusinessExceptionOptions = {}) {
    super(options.clientMessage ?? CLIENT_MESSAGES[code], ERROR_STATUS[code]);
    this.code = code;
    if (options.details !== undefined) {
      this.details = options.details;
    }
  }
}
