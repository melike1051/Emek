import {
  Catch,
  HttpException,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Logger } from 'pino';
import { getRequestContext } from '../logging/request-context';
import { BusinessException } from './business.exception';
import { CLIENT_MESSAGES, ErrorCode, errorCodeForStatus, type ErrorCodeValue } from './error-codes';

export interface ErrorResponseBody {
  error: {
    code: ErrorCodeValue;
    message: string;
    requestId?: string;
    details?: unknown;
  };
}

/**
 * Tek çıkış noktası: her hata kodlu ve güvenli bir gövdeye dönüşür.
 * Ham exception mesajı, stack trace veya SQL hatası istemciye sızmaz —
 * bunlar yalnızca sunucu loguna yazılır.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    // Filter globaldir; HTTP dışı bağlamlarda (Faz 9 Pub/Sub consumer'ları, RPC)
    // Express response yoktur. Bu durumda hata yalnızca loglanır — hata yönetiminin
    // kendisi hata üretmemeli.
    if (host.getType() !== 'http') {
      this.logger.error({ err: exception, contextType: host.getType() }, 'Unhandled exception');
      return;
    }

    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request>();
    const requestId = getRequestContext()?.requestId;

    const { status, body } = this.toResponse(exception, requestId);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        {
          err: exception,
          method: request.method,
          path: request.url,
          statusCode: status,
          errorCode: body.error.code,
        },
        'Unhandled exception',
      );
    } else {
      this.logger.warn(
        {
          method: request.method,
          path: request.url,
          statusCode: status,
          errorCode: body.error.code,
        },
        'Request failed',
      );
    }

    response.status(status).json(body);
  }

  private toResponse(
    exception: unknown,
    requestId: string | undefined,
  ): { status: number; body: ErrorResponseBody } {
    if (exception instanceof BusinessException) {
      return {
        status: exception.getStatus(),
        body: this.body(exception.code, exception.message, requestId, exception.details),
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = errorCodeForStatus(status);
      // Mesaj sabit listeden gelir; framework metni ("Cannot GET /...") sözleşmeye ait değildir.
      // Yalnızca yapısal doğrulama ayrıntıları taşınır.
      const details =
        status < HttpStatus.INTERNAL_SERVER_ERROR
          ? this.validationDetails(exception.getResponse())
          : undefined;

      return { status, body: this.body(code, CLIENT_MESSAGES[code], requestId, details) };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: this.body(
        ErrorCode.INTERNAL_ERROR,
        CLIENT_MESSAGES[ErrorCode.INTERNAL_ERROR],
        requestId,
      ),
    };
  }

  /** ValidationPipe'ın ürettiği alan hatalarını yapısal biçimde taşır. */
  private validationDetails(payload: unknown): { fields: string[] } | undefined {
    if (typeof payload !== 'object' || payload === null) {
      return undefined;
    }

    const message = (payload as { message?: unknown }).message;
    if (!Array.isArray(message)) {
      return undefined;
    }

    return { fields: message.map((entry) => String(entry)) };
  }

  private body(
    code: ErrorCodeValue,
    message: string,
    requestId: string | undefined,
    details?: unknown,
  ): ErrorResponseBody {
    return {
      error: {
        code,
        message,
        ...(requestId !== undefined ? { requestId } : {}),
        ...(details !== undefined ? { details } : {}),
      },
    };
  }
}
