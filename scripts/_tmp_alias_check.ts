import { eodhdClient } from '@core/clients/eodhd/eodhd.client';
import { dataPointsRepository } from '@core/repositories/data-points.repository';
// eslint-disable-next-line no-console
console.log('alias-ok', typeof eodhdClient, typeof dataPointsRepository.upsert);
