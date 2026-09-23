import type { Logger } from 'pino';
import { BookingsService } from './bookings.service';
import type { UnitOfWork } from '../common/database/unit-of-work';

/**
 * Faz 14 close-out bulgusu: aynı slota eşzamanlı rezervasyon isteklerinde
 * `availability` üzerindeki `FOR SHARE` kilidi ile `bookings` EXCLUDE
 * constraint'i bir kilit döngüsü kurabiliyor ve Postgres kurbanı `40P01` ile
 * düşürüyordu — istemciye 409 yerine **500** dönüyordu (15 istekte 13 × 500).
 *
 * Buradaki testler yeniden deneme **sözleşmesini** sabitler. Gerçek deadlock'u
 * deterministik olarak üretmek mümkün değildir; bu yüzden transaction sınırı
 * taklit edilir ve retry kararının kendisi sınanır.
 */
describe('BookingsService.create — deadlock yeniden denemesi', () => {
  const pgError = (code: string): Error => Object.assign(new Error(`pg ${code}`), { code });

  function makeService(uow: Pick<UnitOfWork, 'withTransaction'>): BookingsService {
    const logger = { warn: jest.fn() } as unknown as Logger;
    // create() yalnızca logger + uow kullanır; kalan bağımlılıklar transaction
    // geri çağrısının içinde kalır ve burada hiç çağrılmaz.
    const unused = {} as never;
    return new BookingsService(
      logger,
      uow as UnitOfWork,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
    );
  }

  const input = {} as Parameters<BookingsService['create']>[0];

  it('deadlock (40P01) sonrası transaction yeniden denenir ve sonuç döner', async () => {
    const withTransaction = jest
      .fn()
      .mockRejectedValueOnce(pgError('40P01'))
      .mockResolvedValueOnce({ id: 'booking-1' });

    const service = makeService({ withTransaction });

    await expect(service.create(input)).resolves.toEqual({ id: 'booking-1' });
    expect(withTransaction).toHaveBeenCalledTimes(2);
  });

  it('serileştirme hatası (40001) da yeniden denenir', async () => {
    const withTransaction = jest
      .fn()
      .mockRejectedValueOnce(pgError('40001'))
      .mockResolvedValueOnce({ id: 'booking-2' });

    await expect(makeService({ withTransaction }).create(input)).resolves.toEqual({
      id: 'booking-2',
    });
    expect(withTransaction).toHaveBeenCalledTimes(2);
  });

  it('deadlock ısrar ederse 3 denemeden sonra hata yüzeye çıkar (sonsuz döngü yok)', async () => {
    const withTransaction = jest.fn().mockRejectedValue(pgError('40P01'));

    await expect(makeService({ withTransaction }).create(input)).rejects.toMatchObject({
      code: '40P01',
    });
    expect(withTransaction).toHaveBeenCalledTimes(3);
  });

  it('çakışma (23P01) yeniden DENENMEZ: gerçek çakışmadır, çağırana aynen döner', async () => {
    // Kritik: EXCLUDE ihlalini yeniden denemek, dolu bir slotu tekrar tekrar
    // yoklamak olurdu. 409 doğru yanıttır ve ilk denemede üretilmelidir.
    const withTransaction = jest.fn().mockRejectedValue(pgError('23P01'));

    await expect(makeService({ withTransaction }).create(input)).rejects.toMatchObject({
      code: '23P01',
    });
    expect(withTransaction).toHaveBeenCalledTimes(1);
  });

  it('alakasız hata yeniden denenmez', async () => {
    const withTransaction = jest.fn().mockRejectedValue(new Error('boom'));

    await expect(makeService({ withTransaction }).create(input)).rejects.toThrow('boom');
    expect(withTransaction).toHaveBeenCalledTimes(1);
  });
});
