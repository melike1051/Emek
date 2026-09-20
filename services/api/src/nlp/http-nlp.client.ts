import { Inject, Injectable } from '@nestjs/common';
import { AppConfigService } from '../common/config/app-config.service';
import type { Logger } from 'pino';
import { ROOT_LOGGER } from '../common/logging/logging.tokens';
import {
  SERVICE_SLUGS,
  type NlpClient,
  type NlpParseOutcome,
  type NlpStructuredRequest,
  type ServiceSlug,
} from './nlp.port';

/**
 * AI servisine HTTP ile bağlanan NLP istemcisi.
 *
 * Üç davranış bilinçlidir:
 *
 * 1. **Timeout zorunludur.** AI servisi yavaşladığında rezervasyon akışı onunla
 *    birlikte yavaşlayamaz; süre dolduğunda form yoluna düşülür (T-15).
 * 2. **Yanıt yeniden doğrulanır.** AI servisi kendi şemasını uygular ama core ona
 *    güvenmez: sözleşmeye uymayan yanıt `INVALID_RESPONSE` sayılır. "Karşı taraf
 *    zaten doğruluyor" varsayımı, iki servis sürümü ayrıştığında sessizce bozulur.
 * 3. **Hata yükseltilmez.** NLP erişilemezliği bir iş hatası değildir: çağıran
 *    bunu bir sonuç olarak alır ve kullanıcıya form gösterir.
 */
@Injectable()
export class HttpNlpClient implements NlpClient {
  constructor(
    private readonly config: AppConfigService,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
  ) {}

  async parse(input: { rawText: string; today?: Date }): Promise<NlpParseOutcome> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.config.env.AI_SERVICE_TIMEOUT_MS);

    try {
      const response = await fetch(`${this.config.env.AI_SERVICE_URL}/api/v1/nlp/parse`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.config.env.AI_SERVICE_API_KEY !== undefined
            ? { 'x-service-key': this.config.env.AI_SERVICE_API_KEY }
            : {}),
        },
        body: JSON.stringify({
          raw_text: input.rawText,
          ...(input.today !== undefined ? { today: input.today.toISOString().slice(0, 10) } : {}),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        this.logger.warn({ status: response.status }, 'nlp servisi hata döndürdü');
        return { status: 'UNAVAILABLE', reason: 'INVALID_RESPONSE' };
      }

      return this.toOutcome(await response.json());
    } catch (error) {
      const reason = controller.signal.aborted ? 'TIMEOUT' : 'TRANSPORT';
      // Ham metin loglanmaz: kullanıcı talebi kişisel veri içerebilir.
      this.logger.warn({ reason }, 'nlp servisine ulaşılamadı');
      void error;
      return { status: 'UNAVAILABLE', reason };
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Yanıtı core'un kendi sözleşmesine çevirir ve doğrular. */
  private toOutcome(payload: unknown): NlpParseOutcome {
    if (typeof payload !== 'object' || payload === null) {
      return { status: 'UNAVAILABLE', reason: 'INVALID_RESPONSE' };
    }

    const body = payload as Record<string, unknown>;
    const parserVersion = body.parser_version;
    const confidence = body.confidence;

    if (typeof parserVersion !== 'string' || parserVersion.length === 0) {
      // Sürümsüz bir çıktı kaydedilemez (ADR-0012 §1): deney izlenebilirliği kaybolur.
      return { status: 'UNAVAILABLE', reason: 'INVALID_RESPONSE' };
    }
    if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) {
      return { status: 'UNAVAILABLE', reason: 'INVALID_RESPONSE' };
    }

    const request = this.toRequest(body.request);

    if (body.status === 'PARSED') {
      if (request === null) {
        return { status: 'UNAVAILABLE', reason: 'INVALID_RESPONSE' };
      }
      return { status: 'PARSED', parserVersion, confidence, request };
    }

    if (body.status === 'NEEDS_CLARIFICATION') {
      return {
        status: 'NEEDS_CLARIFICATION',
        parserVersion,
        confidence,
        request,
        clarifications: this.toClarifications(body.clarifications),
      };
    }

    // `REJECTED` veya bilinmeyen durum: core için ikisi de "kullanılabilir çıktı yok".
    return { status: 'UNAVAILABLE', reason: 'INVALID_RESPONSE' };
  }

  private toRequest(value: unknown): NlpStructuredRequest | null {
    if (typeof value !== 'object' || value === null) {
      return null;
    }

    const request = value as Record<string, unknown>;
    const serviceType = request.service_type;
    const durationMinutes = request.duration_minutes;

    // Hizmet slug'ı **beyaz listeye** karşı doğrulanır: AI servisi yeni bir slug
    // üretirse core onu katalogda aramaz, reddeder.
    if (
      typeof serviceType !== 'string' ||
      !(SERVICE_SLUGS as readonly string[]).includes(serviceType)
    ) {
      return null;
    }
    if (
      typeof durationMinutes !== 'number' ||
      !Number.isInteger(durationMinutes) ||
      durationMinutes < 30 ||
      durationMinutes > 1440
    ) {
      return null;
    }

    const serviceDate = request.service_date;
    const window = request.time_window;

    return {
      serviceType: serviceType as ServiceSlug,
      durationMinutes,
      serviceDate: typeof serviceDate === 'string' ? serviceDate : null,
      timeWindow: this.toTimeWindow(window),
      requirements: Array.isArray(request.requirements)
        ? request.requirements.filter((item): item is string => typeof item === 'string')
        : [],
    };
  }

  private toTimeWindow(value: unknown): { startHour: number; endHour: number } | null {
    if (typeof value !== 'object' || value === null) {
      return null;
    }
    const window = value as Record<string, unknown>;
    const startHour = window.start_hour;
    const endHour = window.end_hour;

    if (
      typeof startHour !== 'number' ||
      typeof endHour !== 'number' ||
      startHour < 0 ||
      endHour > 24 ||
      endHour <= startHour
    ) {
      return null;
    }
    return { startHour, endHour };
  }

  private toClarifications(
    value: unknown,
  ): { field: string; question: string; options: string[] }[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value.flatMap((item) => {
      if (typeof item !== 'object' || item === null) {
        return [];
      }
      const entry = item as Record<string, unknown>;
      if (typeof entry.field !== 'string' || typeof entry.question !== 'string') {
        return [];
      }
      return [
        {
          field: entry.field,
          question: entry.question,
          options: Array.isArray(entry.options)
            ? entry.options.filter((option): option is string => typeof option === 'string')
            : [],
        },
      ];
    });
  }
}
