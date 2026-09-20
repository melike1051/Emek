/** Veritabanındaki `app_role` enum'u ile birebir aynı (docs/database/schema.md). */
export const APP_ROLES = ['CUSTOMER', 'PROVIDER', 'ADMIN', 'SUPPORT'] as const;
export type AppRole = (typeof APP_ROLES)[number];

export const USER_STATUSES = ['PENDING', 'ACTIVE', 'SUSPENDED', 'DELETED'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export interface User {
  id: string;
  phone: string | null;
  email: string | null;
  status: UserStatus;
  roles: AppRole[];
  createdAt: Date;
  lastLoginAt: Date | null;
}
