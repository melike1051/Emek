/**
 * Integration testleri için ortak kurulum.
 *
 * Testler şemayı sıfırlar ve tablolara veri yazar. Bu yüzden **yalnızca** adı `_test`
 * ile biten bir veritabanına bağlanılır: aksi halde `npm run test:integration`
 * geliştirme verisini sessizce silerdi.
 */

const testUrl = process.env.DATABASE_URL_TEST;

if (testUrl === undefined || testUrl === '') {
  throw new Error(
    'DATABASE_URL_TEST tanımlı değil. .env.example dosyasındaki değeri .env içine kopyalayın; ' +
      'integration testleri ayrı bir veritabanı gerektirir.',
  );
}

const databaseName = new URL(testUrl).pathname.replace(/^\//, '');

if (!databaseName.endsWith('_test')) {
  throw new Error(
    `Integration testleri yalnızca '_test' ile biten veritabanında çalışır (verilen: '${databaseName}'). ` +
      'Bu kontrol, testlerin geliştirme veritabanını sıfırlamasını engeller.',
  );
}

// Uygulama kodu ve migration CLI'ı DATABASE_URL okur; test koşumu boyunca test DB'sine yönlendirilir.
process.env.DATABASE_URL = testUrl;

// Testler **test** ortamında çalışır — `.env` ne derse desin.
//
// `.env` dosyası geliştirme içindir ve `NODE_ENV=development` taşır; dotenv onu
// Jest'in varsayılanının üzerine yazar. Bu durumda logger `pino-pretty` transport'unu
// açar ve bu worker thread test koşumu bittikten sonra da yaşar ("Jest did not exit").
// Ortamı doğru ayarlamak, uyarıyı bastırmaktan daha doğrudur.
process.env.NODE_ENV = 'test';
