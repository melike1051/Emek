/**
 * OpenAPI sözleşmesini `packages/api-contracts` altına üretir.
 *
 * ADR-0011: istemciler bu sözleşmeye göre yazılır; sözleşme frontend ihtiyacına göre
 * sonradan değiştirilmez. Bu yüzden dosya repoda **versiyonlanır** ve bir contract
 * testi, kodun ürettiği sözleşme ile dosyanın aynı olduğunu doğrular
 * (`npm run contracts:generate` çalıştırılmayı unutulduğunda CI kırılır).
 *
 * Çalıştırma: npm run contracts:generate --workspace=@emek/api
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { format, resolveConfig } from 'prettier';
import { buildOpenApiDocument } from '../src/openapi';

const OUTPUT = resolve(__dirname, '../../../packages/api-contracts/openapi.json');

async function main(): Promise<void> {
  const document = await buildOpenApiDocument();

  // Çıktı Prettier'dan geçirilir. `JSON.stringify` kısa dizileri satırlara yayar,
  // Prettier ise tek satıra toplar: ikisi ayrıştığında `contracts:generate` her
  // çalıştığında `format:check` kırılır ve sözleşmeyi yenilemek iki adımlı bir
  // ritüele dönüşürdü (ve unutulan ikinci adım CI'ı düşürürdü).
  const prettierConfig = await resolveConfig(OUTPUT);
  const serialized = await format(JSON.stringify(document, null, 2), {
    ...prettierConfig,
    filepath: OUTPUT,
  });

  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, serialized, 'utf8');

  const pathCount = Object.keys(document.paths ?? {}).length;
  process.stdout.write(`OpenAPI yazıldı: ${OUTPUT} (${pathCount} yol)\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`OpenAPI üretilemedi: ${String(error)}\n`);
  process.exit(1);
});
