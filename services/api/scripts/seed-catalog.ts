/**
 * Hizmet katalogu referans verisi.
 *
 * Migration değil, **seed**'dir: katalog içeriği ortamdan ortama değişebilir ve
 * operasyon tarafından yönetilir (Faz 10 admin API'si). Migration'lara gömülü veri,
 * üretimde düzeltilmesi zor bir bağımlılık yaratır.
 *
 * Çalıştırma: npm run seed:catalog --workspace=@emek/api
 * Idempotenttir: tekrar çalıştırmak kayıt çoğaltmaz.
 */

import { Pool } from 'pg';

interface CategorySeed {
  slug: string;
  name: string;
  description: string;
  services: { slug: string; name: string; durationMinutes: number; pricing: 'FIXED' | 'HOURLY' }[];
}

const CATEGORIES: CategorySeed[] = [
  {
    slug: 'ev-temizligi',
    name: 'Ev Temizliği',
    description: 'Düzenli ve detaylı ev temizliği hizmetleri',
    services: [
      {
        slug: 'standart-temizlik',
        name: 'Standart Temizlik',
        durationMinutes: 180,
        pricing: 'HOURLY',
      },
      {
        slug: 'detayli-temizlik',
        name: 'Detaylı Temizlik',
        durationMinutes: 300,
        pricing: 'HOURLY',
      },
      {
        slug: 'tasinma-temizligi',
        name: 'Taşınma Temizliği',
        durationMinutes: 480,
        pricing: 'FIXED',
      },
    ],
  },
  {
    slug: 'bakim-hizmetleri',
    name: 'Bakım Hizmetleri',
    description: 'Yaşlı, hasta ve çocuk bakımı',
    services: [
      { slug: 'yasli-bakimi', name: 'Yaşlı Bakımı', durationMinutes: 240, pricing: 'HOURLY' },
      { slug: 'cocuk-bakimi', name: 'Çocuk Bakımı', durationMinutes: 240, pricing: 'HOURLY' },
      { slug: 'hasta-refakati', name: 'Hasta Refakati', durationMinutes: 360, pricing: 'HOURLY' },
    ],
  },
  {
    slug: 'yemek-hazirlik',
    name: 'Yemek ve Hazırlık',
    description: 'Ev yemeği hazırlığı ve mutfak düzeni',
    services: [
      {
        slug: 'gunluk-yemek',
        name: 'Günlük Yemek Hazırlığı',
        durationMinutes: 180,
        pricing: 'HOURLY',
      },
      {
        slug: 'haftalik-mealprep',
        name: 'Haftalık Yemek Hazırlığı',
        durationMinutes: 300,
        pricing: 'FIXED',
      },
    ],
  },
];

const SKILLS: { slug: string; name: string }[] = [
  { slug: 'pet-friendly', name: 'Evcil Hayvan Dostu' },
  { slug: 'derin-temizlik', name: 'Derin Temizlik' },
  { slug: 'ilk-yardim', name: 'İlk Yardım Sertifikalı' },
  { slug: 'yasli-bakim-deneyimi', name: 'Yaşlı Bakım Deneyimi' },
  { slug: 'cocuk-gelisimi', name: 'Çocuk Gelişimi' },
  { slug: 'utu', name: 'Ütü' },
  { slug: 'cam-temizligi', name: 'Cam Temizliği' },
  { slug: 'vegan-mutfak', name: 'Vegan Mutfak' },
];

/**
 * Katalogu yazar. Idempotenttir; testler de bu fonksiyonu kullanır (seed verisinin
 * ikinci bir kopyası test kodunda tutulmaz).
 */
export async function seedCatalog(pool: Pool): Promise<void> {
  for (const category of CATEGORIES) {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO service_categories (slug, name, description)
       VALUES ($1, $2, $3)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description
       RETURNING id`,
      [category.slug, category.name, category.description],
    );
    const categoryId = result.rows[0]?.id;
    if (categoryId === undefined) {
      throw new Error(`kategori yazılamadı: ${category.slug}`);
    }

    for (const service of category.services) {
      await pool.query(
        `INSERT INTO services (category_id, slug, name, default_duration_minutes, pricing_model)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (slug) DO UPDATE
           SET name = EXCLUDED.name,
               category_id = EXCLUDED.category_id,
               default_duration_minutes = EXCLUDED.default_duration_minutes,
               pricing_model = EXCLUDED.pricing_model`,
        [categoryId, service.slug, service.name, service.durationMinutes, service.pricing],
      );
    }
  }

  for (const skill of SKILLS) {
    await pool.query(
      `INSERT INTO skills (slug, name) VALUES ($1, $2)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name`,
      [skill.slug, skill.name],
    );
  }
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined) {
    throw new Error('DATABASE_URL tanımlı değil');
  }

  const pool = new Pool({ connectionString, max: 2 });

  try {
    await seedCatalog(pool);

    const counts = await pool.query<{ categories: string; services: string; skills: string }>(
      `SELECT (SELECT count(*) FROM service_categories)::text AS categories,
              (SELECT count(*) FROM services)::text AS services,
              (SELECT count(*) FROM skills)::text AS skills`,
    );
    process.stdout.write(`Katalog seed tamam: ${JSON.stringify(counts.rows[0])}\n`);
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`Seed başarısız: ${String(error)}\n`);
  process.exit(1);
});
