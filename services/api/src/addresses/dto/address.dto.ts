import {
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import type { Address } from '../addresses.service';

export class CreateAddressDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  label?: string;

  @IsString()
  @MinLength(2)
  @MaxLength(100)
  city!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(100)
  district!: string;

  @IsString()
  @MinLength(5)
  @MaxLength(500)
  line!: string;

  @IsLatitude()
  latitude!: number;

  @IsLongitude()
  longitude!: number;
}

export class AddressResponseDto {
  id!: string;
  label!: string | null;
  city!: string;
  district!: string;
  line!: string;
  latitude!: number;
  longitude!: number;

  static from(address: Address): AddressResponseDto {
    return {
      id: address.id,
      label: address.label,
      city: address.city,
      district: address.district,
      line: address.line,
      latitude: address.latitude,
      longitude: address.longitude,
    };
  }
}
