import { BigQuery } from '@google-cloud/bigquery';
import type { FactoryProvider } from '@nestjs/common';
import { AppConfigService } from '../common/config/app-config.service';
import { BigQueryClientAdapter } from './bigquery-client.adapter';
import { BIGQUERY_PORT, type BigQueryPort } from './bigquery.port';
import { MockBigQueryAdapter } from './mock-bigquery-adapter';

/** ADR-0005/0009 ile aynı desen: production'da sahte sağlayıcı config katmanında reddedilir. */
export function bigQueryPortFactory(config: AppConfigService): BigQueryPort {
  if (config.env.BIGQUERY_PROVIDER === 'mock') {
    return new MockBigQueryAdapter();
  }

  const client = new BigQuery({
    projectId: config.env.BIGQUERY_PROJECT_ID ?? config.env.GCP_PROJECT_ID,
  });
  return new BigQueryClientAdapter(client, config.env.BIGQUERY_DATASET);
}

export const bigQueryPortProvider: FactoryProvider<BigQueryPort> = {
  provide: BIGQUERY_PORT,
  useFactory: bigQueryPortFactory,
  inject: [AppConfigService],
};
