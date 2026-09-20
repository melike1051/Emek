import { IsEmail, IsOptional, Matches, MaxLength } from 'class-validator';
import type { AppRole, User, UserStatus } from '../user.types';

/** E.164: veritabanı CHECK'i ile aynı kural (docs/database/schema.md). */
const E164 = /^\+[1-9][0-9]{7,14}$/;

export class UpdateUserDto {
  @IsOptional()
  @IsEmail({}, { message: 'email geçerli bir e-posta adresi olmalı' })
  @MaxLength(320)
  email?: string;

  @IsOptional()
  @Matches(E164, { message: 'phone E.164 biçiminde olmalı (ör. +905551112233)' })
  phone?: string;
}

export class UserResponseDto {
  id!: string;
  email!: string | null;
  phone!: string | null;
  status!: UserStatus;
  roles!: AppRole[];
  createdAt!: string;
  lastLoginAt!: string | null;

  static from(user: User): UserResponseDto {
    return {
      id: user.id,
      email: user.email,
      phone: user.phone,
      status: user.status,
      roles: user.roles,
      createdAt: user.createdAt.toISOString(),
      lastLoginAt: user.lastLoginAt === null ? null : user.lastLoginAt.toISOString(),
    };
  }
}
