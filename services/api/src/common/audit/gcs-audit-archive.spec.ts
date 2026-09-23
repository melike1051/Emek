import type { Bucket } from '@google-cloud/storage';
import { AuditArchiveError } from './audit-archive.port';
import { GcsAuditArchive } from './gcs-audit-archive';

const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;

function createBucket(overrides: { save?: jest.Mock; metadata?: Record<string, unknown> } = {}) {
  const save = overrides.save ?? jest.fn().mockResolvedValue(undefined);
  const file = { save };

  const bucket = {
    name: 'emek-test-audit-archive',
    file: jest.fn().mockReturnValue(file),
    getMetadata: jest.fn().mockResolvedValue([
      overrides.metadata ?? {
        retentionPolicy: { isLocked: true, retentionPeriod: String(THIRTY_DAYS_SECONDS) },
        iamConfiguration: { publicAccessPrevention: 'enforced' },
      },
    ]),
  } as unknown as Bucket;

  return { bucket, file, save };
}

/** Doğrulanmış (boot etmiş) bir arşiv — put testleri bunu kullanır. */
async function bootedArchive(overrides?: Parameters<typeof createBucket>[0]) {
  const created = createBucket(overrides);
  const archive = new GcsAuditArchive(created.bucket);
  await archive.onApplicationBootstrap();
  return { ...created, archive };
}

function input(retentionDays = 7) {
  return {
    storageKey: 'audit/2026/segment-1.json',
    body: '{"from":1,"to":100}',
    retentionUntil: new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000),
  };
}

describe('GcsAuditArchive', () => {
  it('nesneyi üzerine yazmayı engelleyen önkoşulla yazar', async () => {
    const { archive, save } = await bootedArchive();

    await archive.put(input());

    expect(save).toHaveBeenCalledWith(
      input().body,
      expect.objectContaining({ preconditionOpts: { ifGenerationMatch: 0 } }),
    );
  });

  // Retention-locked depolamada üzerine yazma reddedilir; sessizce başarılı
  // görünmek "arşivlendi" iddiasını yalan yapardı.
  it('aynı anahtara ikinci yazma reddedilir', async () => {
    const { archive } = await bootedArchive({
      save: jest.fn().mockRejectedValue(Object.assign(new Error('precondition'), { code: 412 })),
    });

    await expect(archive.put(input())).rejects.toThrow(AuditArchiveError);
  });

  // Uygulamanın nesne bazlı saklama süresi yazma izni **yoktur** (objectCreator).
  // Garanti bucket'tan gelir; bucket daha kısa garanti veriyorsa yazma reddedilir —
  // aksi halde 10 yıl saklandığı sanılan bir nesne 30 gün sonra silinebilirdi.
  it('bucket garantisini aşan saklama süresi reddedilir', async () => {
    const { archive, save } = await bootedArchive();

    await expect(archive.put(input(3650))).rejects.toThrow(/garantisini/);
    expect(save).not.toHaveBeenCalled();
  });

  it('doğrulanmadan yazma yapılamaz', async () => {
    const { bucket } = createBucket();

    await expect(new GcsAuditArchive(bucket).put(input())).rejects.toThrow(/doğrulanmadan/);
  });

  it('kilitli retention policy olmayan bucket ile boot başarısız olur', async () => {
    const { bucket } = createBucket({
      metadata: {
        retentionPolicy: { isLocked: false, retentionPeriod: String(THIRTY_DAYS_SECONDS) },
        iamConfiguration: { publicAccessPrevention: 'enforced' },
      },
    });

    await expect(new GcsAuditArchive(bucket).onApplicationBootstrap()).rejects.toThrow(
      /kilitli retention policy/,
    );
  });

  it('public erişime kapalı olmayan bucket ile boot başarısız olur', async () => {
    const { bucket } = createBucket({
      metadata: {
        retentionPolicy: { isLocked: true, retentionPeriod: String(THIRTY_DAYS_SECONDS) },
        iamConfiguration: { publicAccessPrevention: 'inherited' },
      },
    });

    await expect(new GcsAuditArchive(bucket).onApplicationBootstrap()).rejects.toThrow(
      /public erişime kapalı değil/,
    );
  });

  it('saklama süresi bildirmeyen bucket ile boot başarısız olur', async () => {
    const { bucket } = createBucket({
      metadata: {
        retentionPolicy: { isLocked: true },
        iamConfiguration: { publicAccessPrevention: 'enforced' },
      },
    });

    await expect(new GcsAuditArchive(bucket).onApplicationBootstrap()).rejects.toThrow(
      /saklama süresi bildirmiyor/,
    );
  });

  it('doğru yapılandırılmış bucket ile boot geçer', async () => {
    const { bucket } = createBucket();

    await expect(new GcsAuditArchive(bucket).onApplicationBootstrap()).resolves.toBeUndefined();
  });
});
