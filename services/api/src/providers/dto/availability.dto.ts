import { Type } from 'class-transformer';
import { IsDate } from 'class-validator';
import type { AvailabilityWindow } from '../availability.service';

export class AddAvailabilityDto {
  @Type(() => Date)
  @IsDate()
  startsAt!: Date;

  @Type(() => Date)
  @IsDate()
  endsAt!: Date;
}

export class AvailabilityQueryDto {
  @Type(() => Date)
  @IsDate()
  from!: Date;

  @Type(() => Date)
  @IsDate()
  to!: Date;
}

export class AvailabilityResponseDto {
  id!: string;
  startsAt!: string;
  endsAt!: string;

  static from(window: AvailabilityWindow): AvailabilityResponseDto {
    return {
      id: window.id,
      startsAt: window.startsAt.toISOString(),
      endsAt: window.endsAt.toISOString(),
    };
  }
}
