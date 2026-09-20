import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { IsOptional, IsString, Matches } from 'class-validator';
import { Public } from '../auth/auth.decorators';
import { RateLimit } from '../common/ratelimit/rate-limit.decorator';
import {
  CatalogService,
  type ServiceCategory,
  type ServiceDefinition,
  type Skill,
} from './catalog.service';

export class ListServicesQueryDto {
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, { message: 'categorySlug slug biçiminde olmalı' })
  categorySlug?: string;
}

/**
 * Katalog herkese açıktır: müşteri hizmet seçmek için oturum açmadan da göz atabilmeli.
 * Kişisel veri içermez. Oran sınırı, anonim taramayı sınırlar.
 */
@Controller()
@Public()
@RateLimit({ name: 'catalog', limit: 120, windowSeconds: 60 })
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('service-categories')
  categories(): Promise<ServiceCategory[]> {
    return this.catalog.listCategories();
  }

  @Get('services')
  services(@Query() query: ListServicesQueryDto): Promise<ServiceDefinition[]> {
    return this.catalog.listServices(query);
  }

  @Get('services/:id')
  service(@Param('id', ParseUUIDPipe) id: string): Promise<ServiceDefinition> {
    return this.catalog.findService(id);
  }

  @Get('skills')
  skills(): Promise<Skill[]> {
    return this.catalog.listSkills();
  }
}
