import {
  CallHandler,
  ExecutionContext,
  HttpStatus,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, firstValueFrom, from } from 'rxjs';
import { BusinessException } from '../errors/business.exception';
import { ErrorCode } from '../errors/error-codes';
import { IdempotencyService } from './idempotency.service';

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
const MAX_KEY_LENGTH = 255;

/**
 * `Idempotency-Key` başlığı gönderilen yan etkili isteklerde aynı komutun iki kez
 * işlenmesini engeller (ADR-0006 §5).
 *
 * Başlık **zorunlu değildir**: istemci göndermezse istek normal işlenir. Kritik
 * akışlarda (ödeme, booking) başlığı zorunlu kılmak ilgili fazın kararıdır.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly idempotency: IdempotencyService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<Request>();
    const key = request.header(IDEMPOTENCY_KEY_HEADER);

    if (key === undefined || key === '') {
      return next.handle();
    }

    return from(this.handleWithKey(context, next, request, key));
  }

  private async handleWithKey(
    context: ExecutionContext,
    next: CallHandler,
    request: Request,
    key: string,
  ): Promise<unknown> {
    if (key.length > MAX_KEY_LENGTH) {
      throw new BusinessException(ErrorCode.VALIDATION_FAILED, {
        clientMessage: 'Idempotency-Key çok uzun.',
        details: { field: 'Idempotency-Key', maxLength: MAX_KEY_LENGTH },
      });
    }

    // Kapsam metot, yol **ve kullanıcıdır**.
    //
    // Kullanıcı kapsamda olmazsa, bir istemci başka bir kullanıcının anahtarını aynı
    // gövdeyle tekrar göndererek onun saklanmış yanıtını (ör. `userId` içeren profil
    // yanıtını) okuyabilirdi: guard'ları atlayan bir veri sızıntısı. Kimlik doğrulama
    // guard'ı interceptor'dan önce çalıştığı için `request.user` burada hazırdır.
    const actor = (request as Request & { user?: { id: string } }).user?.id ?? 'anonymous';
    const scope = `${request.method} ${request.route?.path ?? request.path} ${actor}`;
    const fingerprint = this.idempotency.fingerprint(request.body);
    const lookup = await this.idempotency.begin(scope, key, fingerprint);

    if (lookup.outcome === 'FINGERPRINT_MISMATCH') {
      // Anahtar başka bir isteğe ait: serbest bırakılmaz.
      throw new BusinessException(ErrorCode.IDEMPOTENCY_KEY_REUSED);
    }

    if (lookup.outcome === 'IN_PROGRESS') {
      // Aynı komut hâlâ işleniyor; paralel yürütülmez. Rezervasyon **bu isteğe ait
      // değildir**, bu yüzden serbest bırakılmaz.
      throw new BusinessException(ErrorCode.IDEMPOTENCY_IN_PROGRESS);
    }

    const response = context.switchToHttp().getResponse<Response>();

    if (lookup.outcome === 'COMPLETED') {
      response.status(lookup.response.status);
      response.setHeader('idempotent-replay', 'true');
      return lookup.response.body;
    }

    // Buradan itibaren rezervasyon bu isteğe aittir.
    try {
      const body = await firstValueFrom(next.handle());

      // Kayıt, yanıt gönderilmeden **önce** tamamlanır: istemci 2xx alıp hemen tekrar
      // denediğinde kaydı yazılmamış bir anahtarla karşılaşıp komutu ikinci kez
      // çalıştırmamalı.
      await this.idempotency.complete(scope, key, {
        status: response.statusCode ?? HttpStatus.OK,
        body,
      });

      return body;
    } catch (error) {
      // Başarısız istek anahtarı tüketmez; istemci aynı anahtarla yeniden deneyebilir.
      await this.idempotency.release(scope, key).catch(() => undefined);
      throw error;
    }
  }
}
