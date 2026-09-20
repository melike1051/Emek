import { Injectable } from '@nestjs/common';
import { AuditAction, AuditService } from '../common/audit/audit.service';
import { UnitOfWork } from '../common/database/unit-of-work';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCode } from '../common/errors/error-codes';
import type { BookingStatus } from '../bookings/state/booking-status';

export interface Review {
  id: string;
  bookingId: string;
  subjectUserId: string;
  rating: number;
  comment: string | null;
  createdAt: Date;
}

interface ReviewRow {
  id: string;
  booking_id: string;
  author_user_id: string;
  subject_user_id: string;
  rating: number;
  comment: string | null;
  created_at: Date;
}

function toReview(row: ReviewRow): Review {
  return {
    id: row.id,
    bookingId: row.booking_id,
    subjectUserId: row.subject_user_id,
    rating: Number(row.rating),
    comment: row.comment,
    createdAt: row.created_at,
    // `author_user_id` dışarı verilmez: değerlendirme, karşı taraf için tek tek
    // kime ait olduğu görünmeyen bir sinyaldir (misilleme yüzeyini daraltır).
  };
}

/**
 * Değerlendirmeler.
 *
 * Değerlendirme matching skorunun girdisidir (Faz 7): manipüle edilebilir bir review
 * tablosu doğrudan algoritmayı manipüle eder. Bu yüzden üç kapı vardır:
 *
 * 1. Yalnızca **tamamlanmış** rezervasyon değerlendirilebilir (uydurma rezervasyonla
 *    puan üretilemesin).
 * 2. Yalnızca rezervasyonun **tarafı** yazabilir ve yalnızca karşı tarafı puanlar.
 * 3. Bir rezervasyonda bir taraf **bir kez** yazar (veritabanı UNIQUE).
 */
@Injectable()
export class ReviewsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly audit: AuditService,
  ) {}

  async create(input: {
    bookingId: string;
    authorUserId: string;
    rating: number;
    comment?: string;
  }): Promise<Review> {
    return this.uow.withTransaction(async (client) => {
      const booking = await client.query<{
        status: BookingStatus;
        customer_id: string;
        provider_id: string | null;
      }>(
        `SELECT status, customer_id, provider_id FROM bookings
          WHERE id = $1 AND (customer_id = $2 OR provider_id = $2)`,
        [input.bookingId, input.authorUserId],
      );

      const row = booking.rows[0];
      if (row === undefined) {
        throw new BusinessException(ErrorCode.NOT_FOUND);
      }

      // Tamamlanmamış hizmet değerlendirilemez: aksi halde iptal edilmiş bir
      // rezervasyon üzerinden sağlayıcıya puan yazılabilirdi.
      if (row.status !== 'COMPLETED' && row.status !== 'SETTLED') {
        throw new BusinessException(ErrorCode.REVIEW_NOT_ALLOWED, {
          details: { bookingStatus: row.status },
        });
      }

      const subjectUserId =
        row.customer_id === input.authorUserId ? row.provider_id : row.customer_id;
      if (subjectUserId === null) {
        throw new BusinessException(ErrorCode.REVIEW_NOT_ALLOWED);
      }

      let inserted;
      try {
        inserted = await client.query<ReviewRow>(
          `INSERT INTO reviews (booking_id, author_user_id, subject_user_id, rating, comment)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, booking_id, author_user_id, subject_user_id, rating, comment, created_at`,
          [input.bookingId, input.authorUserId, subjectUserId, input.rating, input.comment ?? null],
        );
      } catch (error) {
        if ((error as { code?: string }).code === '23505') {
          throw new BusinessException(ErrorCode.REVIEW_ALREADY_EXISTS);
        }
        throw error;
      }

      const review = inserted.rows[0];
      if (review === undefined) {
        throw new Error('değerlendirme oluşturulamadı');
      }

      await this.audit.record(client, {
        action: AuditAction.REVIEW_CREATED,
        entityType: 'review',
        entityId: review.id,
        actorUserId: input.authorUserId,
        newValue: { bookingId: input.bookingId, rating: input.rating },
      });

      return toReview(review);
    });
  }

  /** Bir kullanıcı hakkında yazılmış değerlendirmeler (profil görünümü). */
  async listForSubject(subjectUserId: string): Promise<Review[]> {
    const rows = await this.uow.query<ReviewRow>(
      `SELECT id, booking_id, author_user_id, subject_user_id, rating, comment, created_at
         FROM reviews WHERE subject_user_id = $1
        ORDER BY created_at DESC LIMIT 100`,
      [subjectUserId],
    );
    return rows.map(toReview);
  }
}
