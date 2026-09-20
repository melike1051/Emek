import { Injectable } from '@nestjs/common';
import { UnitOfWork } from '../common/database/unit-of-work';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCode } from '../common/errors/error-codes';

export interface ServiceCategory {
  id: string;
  slug: string;
  name: string;
  description: string | null;
}

export interface ServiceDefinition {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  categoryId: string;
  categorySlug: string;
  defaultDurationMinutes: number | null;
  pricingModel: 'FIXED' | 'HOURLY';
}

export interface Skill {
  id: string;
  slug: string;
  name: string;
}

/**
 * Hizmet katalogu okuma servisi.
 *
 * Katalog referans veridir ve yalnızca aktif kayıtlar sunulur: pasife alınmış bir hizmet
 * geçmiş rezervasyonlarda görünmeye devam eder ama yeni talep kabul etmez.
 * Katalog yönetimi (yazma) admin API'siyle Faz 10'da gelir.
 */
@Injectable()
export class CatalogService {
  constructor(private readonly uow: UnitOfWork) {}

  async listCategories(): Promise<ServiceCategory[]> {
    const rows = await this.uow.query<{
      id: string;
      slug: string;
      name: string;
      description: string | null;
    }>(`SELECT id, slug, name, description FROM service_categories WHERE active ORDER BY name`);
    return rows;
  }

  async listServices(filter: { categorySlug?: string }): Promise<ServiceDefinition[]> {
    const rows = await this.uow.query<{
      id: string;
      slug: string;
      name: string;
      description: string | null;
      category_id: string;
      category_slug: string;
      default_duration_minutes: number | null;
      pricing_model: 'FIXED' | 'HOURLY';
    }>(
      `SELECT s.id, s.slug, s.name, s.description, s.category_id,
              c.slug AS category_slug, s.default_duration_minutes, s.pricing_model
         FROM services s
         JOIN service_categories c ON c.id = s.category_id
        WHERE s.active AND c.active
          AND ($1::text IS NULL OR c.slug = $1)
        ORDER BY s.name`,
      [filter.categorySlug ?? null],
    );

    return rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      categoryId: row.category_id,
      categorySlug: row.category_slug,
      defaultDurationMinutes: row.default_duration_minutes,
      pricingModel: row.pricing_model,
    }));
  }

  async findService(id: string): Promise<ServiceDefinition> {
    const services = await this.uow.query<{
      id: string;
      slug: string;
      name: string;
      description: string | null;
      category_id: string;
      category_slug: string;
      default_duration_minutes: number | null;
      pricing_model: 'FIXED' | 'HOURLY';
    }>(
      `SELECT s.id, s.slug, s.name, s.description, s.category_id,
              c.slug AS category_slug, s.default_duration_minutes, s.pricing_model
         FROM services s
         JOIN service_categories c ON c.id = s.category_id
        WHERE s.id = $1 AND s.active AND c.active`,
      [id],
    );

    const row = services[0];
    if (row === undefined) {
      throw new BusinessException(ErrorCode.NOT_FOUND);
    }

    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      categoryId: row.category_id,
      categorySlug: row.category_slug,
      defaultDurationMinutes: row.default_duration_minutes,
      pricingModel: row.pricing_model,
    };
  }

  async listSkills(): Promise<Skill[]> {
    return this.uow.query<Skill>(`SELECT id, slug, name FROM skills ORDER BY name`);
  }
}
