import { Module } from '@nestjs/common';
import { HttpNlpClient } from './http-nlp.client';
import { NLP_CLIENT } from './nlp.port';

/**
 * NLP istemcisi.
 *
 * Tek bir uygulama vardır ve o da HTTP üzerinden AI servisine bağlanır. Mock bir
 * istemci **yoktur**: "AI down" senaryosu testlerde gerçek istemcinin erişilemeyen
 * bir adrese bağlanmasıyla kurulur, çünkü ölçülmek istenen tam olarak o yoldur.
 */
@Module({
  providers: [HttpNlpClient, { provide: NLP_CLIENT, useExisting: HttpNlpClient }],
  exports: [NLP_CLIENT],
})
export class NlpModule {}
