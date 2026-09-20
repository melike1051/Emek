import { Injectable, type LoggerService } from '@nestjs/common';
import type { Logger } from 'pino';

/**
 * NestJS'in LoggerService arayüzünü pino'ya bağlar; framework logları da
 * uygulama logları ile aynı structured JSON formatında akar.
 */
@Injectable()
export class PinoLoggerService implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, context?: unknown): void {
    this.logger.info({ context }, String(message));
  }

  error(message: unknown, stack?: unknown, context?: unknown): void {
    this.logger.error({ context, stack }, String(message));
  }

  warn(message: unknown, context?: unknown): void {
    this.logger.warn({ context }, String(message));
  }

  debug(message: unknown, context?: unknown): void {
    this.logger.debug({ context }, String(message));
  }

  verbose(message: unknown, context?: unknown): void {
    this.logger.trace({ context }, String(message));
  }

  fatal(message: unknown, context?: unknown): void {
    this.logger.fatal({ context }, String(message));
  }
}
