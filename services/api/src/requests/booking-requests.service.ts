import { Inject, Injectable } from '@nestjs/common';
import { AuditAction, AuditService } from '../common/audit/audit.service';
import { UnitOfWork } from '../common/database/unit-of-work';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { AddressesService } from '../addresses/addresses.service';
import { CatalogService } from '../catalog/catalog.service';
import { AppConfigService } from '../common/config/app-config.service';
import {
  NLP_CLIENT,
  type NlpClarification,
  type NlpClient,
  type NlpStructuredRequest,
} from '../nlp/nlp.port';

export interface BookingRequestRecord {
  id: string;
  serviceId: string;
  addressId: string;
  preferredStart: Date;
  preferredEnd: Date;
  durationMinutes: number;
  status: string;
  parserVersion: string | null;
  parserConfidence: string | null;
}

interface BookingRequestRow {
  id: string;
  service_id: string;
  address_id: string;
  preferred_start: Date;
  preferred_end: Date;
  duration_minutes: number;
  status: string;
  parser_version: string | null;
  parser_confidence: string | null;
}

/** Serbest metin yolunun sonucu: ya talep oluştu ya da netleştirme gerekiyor. */
export type CreateFromTextOutcome =
  | { kind: 'CREATED'; record: BookingRequestRecord; degraded: boolean }
  | {
      kind: 'NEEDS_CLARIFICATION';
      parserVersion: string | null;
      confidence: number | null;
      clarifications: NlpClarification[];
      /** AI erişilemediği için mi sorulyor? Öyleyse istemci doğrudan formu açar. */
      degraded: boolean;
    };

/**
 * Bu eşiğin altındaki güvende talep **otomatik oluşturulmaz**.
 *
 * Gerekçe: düşük güvenli bir ayrıştırma, yanlış hizmet türüyle sağlayıcı aramaya yol
 * açar; kullanıcı bunu ancak sağlayıcı kapıya geldiğinde fark eder. Bir soru sormak
 * bundan ucuzdur (ADR-0007 §2).
 */
const MIN_AUTO_CONFIDENCE = 0.6;

/**
 * Hizmet talepleri.
 *
 * İki giriş yolu vardır ve **ikisi de bağımsız çalışır**:
 *
 * - `createFromText`: serbest metin → NLP → doğrulama → talep.
 * - `createFromForm`: yapılandırılmış form → talep. NLP'ye hiç dokunmaz.
 *
 * AI servisi erişilemez olduğunda birinci yol ikinciye **yönlendirir**, çökmez (T-15).
 * NLP çıktısı burada core'un kendi doğrulamasından geçer: katalogda gerçekten var olan
 * bir hizmete çözülür, adres sahipliği kontrol edilir, zaman penceresi core'un
 * kurallarıyla hesaplanır. Yani NLP bir **öneridir**, karar değil (ADR-0007 §1).
 */
@Injectable()
export class BookingRequestsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly audit: AuditService,
    private readonly addresses: AddressesService,
    private readonly catalog: CatalogService,
    private readonly config: AppConfigService,
    @Inject(NLP_CLIENT) private readonly nlp: NlpClient,
  ) {}

  async createFromText(input: {
    customerId: string;
    rawText: string;
    addressId: string;
    today?: Date;
  }): Promise<CreateFromTextOutcome> {
    await this.assertAddressOwned(input.customerId, input.addressId);

    const outcome = await this.nlp.parse({
      rawText: input.rawText,
      ...(input.today !== undefined ? { today: input.today } : {}),
    });

    if (outcome.status === 'UNAVAILABLE') {
      // AI yok: akış durmaz, kullanıcı formu doldurur (T-15).
      return {
        kind: 'NEEDS_CLARIFICATION',
        parserVersion: null,
        confidence: null,
        clarifications: [],
        degraded: true,
      };
    }

    if (outcome.status === 'NEEDS_CLARIFICATION' || outcome.confidence < MIN_AUTO_CONFIDENCE) {
      return {
        kind: 'NEEDS_CLARIFICATION',
        parserVersion: outcome.parserVersion,
        confidence: outcome.confidence,
        clarifications: outcome.status === 'NEEDS_CLARIFICATION' ? outcome.clarifications : [],
        degraded: false,
      };
    }

    const window = this.resolveWindow(outcome.request);
    if (window === null) {
      // Şema geçerli ama zaman bilgisi eksik: uydurulmaz, sorulur.
      return {
        kind: 'NEEDS_CLARIFICATION',
        parserVersion: outcome.parserVersion,
        confidence: outcome.confidence,
        clarifications: [
          {
            field: 'service_date',
            question: 'Hizmeti hangi gün ve saatlerde istiyorsunuz?',
            options: [],
          },
        ],
        degraded: false,
      };
    }

    const service = await this.catalog.findServiceBySlug(outcome.request.serviceType);
    if (service === null) {
      // AI bilinen bir slug döndürdü ama katalogda aktif karşılığı yok: sessizce
      // başka bir hizmete düşmek yerine forma yönlendirilir.
      return {
        kind: 'NEEDS_CLARIFICATION',
        parserVersion: outcome.parserVersion,
        confidence: outcome.confidence,
        clarifications: [
          { field: 'service_type', question: 'Hangi hizmeti istiyorsunuz?', options: [] },
        ],
        degraded: false,
      };
    }

    const record = await this.insert({
      customerId: input.customerId,
      serviceId: service.id,
      addressId: input.addressId,
      preferredStart: window.start,
      preferredEnd: window.end,
      durationMinutes: outcome.request.durationMinutes,
      rawText: input.rawText,
      structuredRequest: outcome.request,
      parserVersion: outcome.parserVersion,
      parserConfidence: outcome.confidence,
    });

    return { kind: 'CREATED', record, degraded: false };
  }

  /**
   * Yapılandırılmış form yolu.
   *
   * AI servisine **hiç dokunmaz**: bu, "AI down iken core akış çalışır" garantisinin
   * kendisidir. Ham metin de saklanmaz — form doldurmuş kullanıcının serbest metni yoktur.
   */
  async createFromForm(input: {
    customerId: string;
    serviceId: string;
    addressId: string;
    preferredStart: Date;
    preferredEnd: Date;
    durationMinutes: number;
  }): Promise<BookingRequestRecord> {
    await this.assertAddressOwned(input.customerId, input.addressId);

    // Hizmet yoksa `findService` kodlu 404 fırlatır; ayrıca kontrol gerekmez.
    await this.catalog.findService(input.serviceId);

    this.assertWindowFitsDuration(input);

    return this.insert({
      customerId: input.customerId,
      serviceId: input.serviceId,
      addressId: input.addressId,
      preferredStart: input.preferredStart,
      preferredEnd: input.preferredEnd,
      durationMinutes: input.durationMinutes,
    });
  }

  async findOwned(requestId: string, customerId: string): Promise<BookingRequestRecord | null> {
    const rows = await this.uow.query<BookingRequestRow>(
      `SELECT id, service_id, address_id, preferred_start, preferred_end,
              duration_minutes, status::text AS status, parser_version,
              parser_confidence::text AS parser_confidence
         FROM booking_requests
        WHERE id = $1 AND customer_id = $2`,
      [requestId, customerId],
    );

    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  private async insert(input: {
    customerId: string;
    serviceId: string;
    addressId: string;
    preferredStart: Date;
    preferredEnd: Date;
    durationMinutes: number;
    rawText?: string;
    structuredRequest?: NlpStructuredRequest;
    parserVersion?: string;
    parserConfidence?: number;
  }): Promise<BookingRequestRecord> {
    return this.uow.withTransaction(async (client) => {
      const result = await client.query<BookingRequestRow>(
        `INSERT INTO booking_requests
           (customer_id, service_id, address_id, raw_text, structured_request,
            parser_version, parser_confidence, preferred_start, preferred_end, duration_minutes)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)
         RETURNING id, service_id, address_id, preferred_start, preferred_end,
                   duration_minutes, status::text AS status, parser_version,
                   parser_confidence::text AS parser_confidence`,
        [
          input.customerId,
          input.serviceId,
          input.addressId,
          input.rawText ?? null,
          input.structuredRequest !== undefined ? JSON.stringify(input.structuredRequest) : null,
          input.parserVersion ?? null,
          input.parserConfidence ?? null,
          input.preferredStart,
          input.preferredEnd,
          input.durationMinutes,
        ],
      );

      const row = result.rows[0];
      if (row === undefined) {
        throw new Error('talep kaydı oluşturulamadı');
      }

      await this.audit.record(client, {
        action: AuditAction.BOOKING_REQUEST_CREATED,
        entityType: 'booking_request',
        entityId: row.id,
        actorUserId: input.customerId,
        // Ham metin audit'e yazılmaz: kişisel veri içerebilir (ADR-0013 §10).
        newValue: {
          serviceId: input.serviceId,
          durationMinutes: input.durationMinutes,
          parserVersion: input.parserVersion ?? null,
          source: input.rawText !== undefined ? 'TEXT' : 'FORM',
        },
      });

      return toRecord(row);
    });
  }

  /**
   * NLP'nin verdiği tarih + saat aralığından core'un zaman penceresini kurar.
   *
   * **Saatler yerel saattir, UTC değil** (Faz 6 review bulgusu H2). NLP şemasındaki
   * `TimeWindow` ve `DAY_PART_HOURS` müşterinin anladığı saati taşır: "sabah" = 08:00
   * Türkiye saati. Bu saatler doğrudan `setUTCHours` ile yazılsaydı her metin yollu
   * rezervasyon **3 saat kaymış** olurdu — "sabah" diyen müşteriye öğleden sonra
   * randevu verilirdi. Form yolu zaten istemciden `timestamptz` aldığı için aynı
   * tabloda iki farklı zaman anlayışı oluşurdu.
   *
   * Tarih veya saat eksikse `null` döner: "bugünden itibaren bir hafta" gibi geniş bir
   * pencere uydurmak, sağlayıcıya yanlış beklenti yaratırdı.
   */
  private resolveWindow(request: NlpStructuredRequest): { start: Date; end: Date } | null {
    if (request.serviceDate === null || request.timeWindow === null) {
      return null;
    }

    const windowStart = this.atLocalHour(request.serviceDate, request.timeWindow.startHour);
    const windowEnd = this.atLocalHour(request.serviceDate, request.timeWindow.endHour);
    if (windowStart === null || windowEnd === null) {
      return null;
    }

    // Pencere istenen süreyi barındırmalı; `booking_requests` CHECK'i bunu zaten
    // zorlar, burada erken ve anlaşılır biçimde yakalanır.
    const windowMinutes = (windowEnd.getTime() - windowStart.getTime()) / 60000;
    if (windowMinutes < request.durationMinutes) {
      windowEnd.setTime(windowStart.getTime() + request.durationMinutes * 60000);
    }

    return { start: windowStart, end: windowEnd };
  }

  /**
   * `YYYY-MM-DD` + yerel saat → mutlak an.
   *
   * Saat 24 olabilir (gün sonu): `T24:00` geçerli bir ISO gösterimi olmadığı için
   * bir sonraki günün 00:00'ı olarak kurulur.
   */
  private atLocalHour(serviceDate: string, hour: number): Date | null {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate) || hour < 0 || hour > 24) {
      return null;
    }

    const offset = this.config.env.SERVICE_TIMEZONE_OFFSET;
    const base =
      hour === 24
        ? new Date(`${serviceDate}T00:00:00${offset}`)
        : new Date(`${serviceDate}T${String(hour).padStart(2, '0')}:00:00${offset}`);

    if (Number.isNaN(base.getTime())) {
      return null;
    }
    if (hour === 24) {
      base.setTime(base.getTime() + 24 * 60 * 60 * 1000);
    }
    return base;
  }

  private assertWindowFitsDuration(input: {
    preferredStart: Date;
    preferredEnd: Date;
    durationMinutes: number;
  }): void {
    const windowMinutes = (input.preferredEnd.getTime() - input.preferredStart.getTime()) / 60000;

    if (windowMinutes < input.durationMinutes) {
      throw new BusinessException(ErrorCode.VALIDATION_FAILED, {
        clientMessage: 'Seçilen zaman aralığı istenen süreyi kapsamıyor.',
        details: { windowMinutes, durationMinutes: input.durationMinutes },
      });
    }
  }

  private async assertAddressOwned(customerId: string, addressId: string): Promise<void> {
    const address = await this.addresses.findOwned(customerId, addressId);
    if (address === null) {
      throw new BusinessException(ErrorCode.ADDRESS_NOT_FOUND);
    }
  }
}

function toRecord(row: BookingRequestRow): BookingRequestRecord {
  return {
    id: row.id,
    serviceId: row.service_id,
    addressId: row.address_id,
    preferredStart: row.preferred_start,
    preferredEnd: row.preferred_end,
    durationMinutes: Number(row.duration_minutes),
    status: row.status,
    parserVersion: row.parser_version,
    parserConfidence: row.parser_confidence,
  };
}
