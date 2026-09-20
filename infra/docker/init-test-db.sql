-- Integration testleri için ayrı veritabanı.
-- Testler şemayı sıfırlar (`migrate down 0`) ve tablolara veri yazar; aynı veritabanı
-- geliştirme ortamıyla paylaşılırsa test koşmak yerel verileri siler.
SELECT 'CREATE DATABASE emek_test OWNER emek'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'emek_test')\gexec
