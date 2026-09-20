# ADR-0015 — Toolchain Kararları: NestJS 11 (CJS), TypeScript 6, uv, Sürüm Pinleme

- Durum: Accepted (2026-09-20)
- Faz: 1
- İlgili: ADR-0002

## Bağlam

Faz 1 kurulumunda üç bağımlılık kararı gerçek bir seçim gerektirdi:

1. **NestJS 12 ESM-only yayınlandı.** NestJS 12 paketleri `"type": "module"` ile geliyor;
   CommonJS bir servisten `require` ile kullanılamıyor. ESM'e geçiş jest/ts-jest,
   `__dirname`, `emitDecoratorMetadata` (esbuild desteklemiyor, swc gerekiyor) gibi
   zincirleme değişiklikler getiriyor.
2. **NestJS 11.x transitif `multer@2.2.0`** dört adet yüksek önemli DoS açığı taşıyordu.
3. **Yerel Python 3.9**, hedeflenen FastAPI/OR-Tools yığını için çok eski (risk R-21).

## Karar

1. **Faz 1 NestJS 11 (CommonJS) ile ilerler.** Gerekçe: ESM geçişi, altyapının henüz
   kurulduğu bir fazda test koşucusu ve DI metadata zincirini aynı anda değiştirmek anlamına
   gelir; bu, Faz 1'in amacı olan "sağlam temel" ile çelişir. Geçiş kendi başına bir iştir.
2. **`multer` açığı `overrides` ile kapatıldı** (`"overrides": { "multer": "^2.4.0" }`).
   Transitif bir bağımlılığın açığını, üst paketi majör atlamadan kapatmanın doğru yolu budur.
   `npm audit` çıktısı **0 açık** olarak doğrulandı ve CI'da bu kontrol Faz 12'de bloklayıcı olacak.
3. **TypeScript 6 kullanılır**, `module`/`moduleResolution: node16` ve `isolatedModules: true` ile.
   TS 6 `node10` çözümleyiciyi ve `baseUrl`'ü kaldırıyor; bunları `ignoreDeprecations` ile
   susturmak yerine modern ayara geçildi.
4. **`@nestjs/cli` ve `@nestjs/schematics` kullanılmaz.** `nest build` düz bir `tsc` sarmalayıcısıdır;
   CLI ayrıca TypeScript sürümü üzerinde çakışan bir peer kısıtı getiriyordu. Build:
   `tsc -p tsconfig.build.json`. Bu, dev bağımlılık sayısını ve çakışma yüzeyini azaltır.
5. **Python `uv` ile yönetilir ve 3.12'ye pinlenir** (`services/ai/.python-version`,
   Dockerfile `uv:python3.12`). Sistem Python'u (3.9) hiçbir yerde kullanılmaz.
6. **ESM geçişi teknik borç olarak kaydedilir** (risk R-34): Faz 13-14 civarında, test koşucusu
   kararıyla birlikte planlanır. O tarihe kadar `overrides` ve `npm audit` ile güvenlik izlenir.

## Sonuçlar

- CJS kaldığımız için `__dirname`, `require`, jest/ts-jest kurulumunun tamamı doğrudan çalışır.
- NestJS 11 desteklendiği sürece güvenlik yamaları izlenir; desteği düşerse ESM geçişi
  zorunlu hale gelir ve bu risk R-34'te takip edilir.
- `overrides` kalıcı bir çözüm değil, köprüdür: NestJS sürümü multer'ı kendi içinde
  yükselttiğinde override kaldırılır (CI'daki audit kontrolü bunu güvenli kılar).

## Alternatifler

- **NestJS 12 + ESM + vitest/swc (ertelendi):** modern hedef, ama Faz 1'de aynı anda DI metadata
  ve test altyapısını değiştirmek gereksiz risk.
- **NestJS 11 + açığı kabul etmek (reddedildi):** yüksek önemli DoS açığı kabul edilemez.
- **TypeScript 5.x'te kalmak (reddedildi):** NestJS 12'ye geçiş gününü zorlaştırır ve
  kaldırılmış çözümleyiciye bağımlılık üretir.
