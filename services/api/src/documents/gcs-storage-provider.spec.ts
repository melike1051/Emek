import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import type { Bucket } from '@google-cloud/storage';
import type { AppConfigService } from '../common/config/app-config.service';
import { GcsStorageProvider } from './gcs-storage-provider';
import { StorageError } from './storage.port';

const config = {
  env: {
    GCP_PROJECT_ID: 'emek-test',
    STORAGE_BUCKET: 'emek-test-documents',
    STORAGE_SIGNED_URL_TTL_SECONDS: 300,
    STORAGE_MAX_UPLOAD_BYTES: 1024,
  },
} as unknown as AppConfigService;

function createBucket(options: {
  body?: Buffer;
  size?: number;
  metadataError?: unknown;
  bucketMetadata?: Record<string, unknown>;
}) {
  const getSignedUrl = jest.fn().mockResolvedValue(['https://signed.example/object']);
  const file = {
    getSignedUrl,
    getMetadata: jest.fn(() =>
      options.metadataError !== undefined
        ? Promise.reject(options.metadataError)
        : Promise.resolve([{ size: String(options.size ?? options.body?.byteLength ?? 0) }]),
    ),
    createReadStream: jest.fn(() => Readable.from([options.body ?? Buffer.alloc(0)])),
  };

  const bucket = {
    name: 'emek-test-documents',
    file: jest.fn().mockReturnValue(file),
    getMetadata: jest.fn().mockResolvedValue([
      options.bucketMetadata ?? {
        iamConfiguration: {
          uniformBucketLevelAccess: { enabled: true },
          publicAccessPrevention: 'enforced',
        },
      },
    ]),
  } as unknown as Bucket;

  return { bucket, file, getSignedUrl };
}

describe('GcsStorageProvider', () => {
  it('yükleme URL.i v4 imzalı, yazma amaçlı ve içerik tipine bağlıdır', async () => {
    const { bucket, getSignedUrl } = createBucket({});

    const result = await new GcsStorageProvider(bucket, config).createUploadUrl({
      storageKey: 'documents/a.jpg',
      contentType: 'image/jpeg',
      maxBytes: 1024,
    });

    expect(getSignedUrl).toHaveBeenCalledWith(
      expect.objectContaining({ version: 'v4', action: 'write', contentType: 'image/jpeg' }),
    );
    expect(result.headers['content-type']).toBe('image/jpeg');
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('indirme URL.i v4 imzalı ve okuma amaçlıdır', async () => {
    const { bucket, getSignedUrl } = createBucket({});

    await new GcsStorageProvider(bucket, config).createDownloadUrl('documents/a.jpg');

    expect(getSignedUrl).toHaveBeenCalledWith(
      expect.objectContaining({ version: 'v4', action: 'read' }),
    );
  });

  // Kanıt istemcinin beyanı değildir: özet nesnenin kendisinden hesaplanır.
  it('sha256.yı nesne içeriğinden hesaplar', async () => {
    const body = Buffer.from('kanıt fotoğrafı');
    const { bucket } = createBucket({ body });

    const stat = await new GcsStorageProvider(bucket, config).statObject('documents/a.jpg');

    expect(stat).toEqual({
      sha256: createHash('sha256').update(body).digest('hex'),
      sizeBytes: body.byteLength,
    });
  });

  it('olmayan nesne için null döner', async () => {
    const { bucket } = createBucket({
      metadataError: Object.assign(new Error('nope'), { code: 404 }),
    });

    expect(await new GcsStorageProvider(bucket, config).statObject('yok')).toBeNull();
  });

  // Sınırı aşan nesneyi hash'lemek için indirmek, yükleme sınırını bant genişliği
  // saldırısına çevirirdi (R-41).
  it('sınırı aşan nesne okunmadan reddedilir', async () => {
    const { bucket, file } = createBucket({ size: 2048 });
    const provider = new GcsStorageProvider(bucket, config);

    await expect(provider.statObject('documents/big.jpg')).rejects.toThrow(StorageError);
    expect(file.createReadStream).not.toHaveBeenCalled();
  });

  it('uniform access kapalıysa boot başarısız olur', async () => {
    const { bucket } = createBucket({
      bucketMetadata: {
        iamConfiguration: {
          uniformBucketLevelAccess: { enabled: false },
          publicAccessPrevention: 'enforced',
        },
      },
    });

    await expect(new GcsStorageProvider(bucket, config).onApplicationBootstrap()).rejects.toThrow(
      /güvenli değil/,
    );
  });

  it('public erişim engeli yoksa boot başarısız olur', async () => {
    const { bucket } = createBucket({
      bucketMetadata: {
        iamConfiguration: {
          uniformBucketLevelAccess: { enabled: true },
          publicAccessPrevention: 'inherited',
        },
      },
    });

    await expect(new GcsStorageProvider(bucket, config).onApplicationBootstrap()).rejects.toThrow(
      /güvenli değil/,
    );
  });

  it('doğru yapılandırılmış bucket ile boot geçer', async () => {
    const { bucket } = createBucket({});

    await expect(
      new GcsStorageProvider(bucket, config).onApplicationBootstrap(),
    ).resolves.toBeUndefined();
  });
});
