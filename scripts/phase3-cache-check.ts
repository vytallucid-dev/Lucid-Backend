/* eslint-disable no-console */
import express from 'express';
import request from 'supertest';
import { oracleRouter } from '@modules/edgefinder/api/oracle.routes';
import { errorHandler } from '@core/middleware/error-handler';
import { getInstrumentRegistry, invalidateInstrumentRegistry } from '@modules/edgefinder/api/instrument-registry';
const app = express(); app.use(express.json()); app.use('/api/oracle', oracleRouter); app.use(errorHandler);
(async () => {
  invalidateInstrumentRegistry();
  const t0 = Date.now(); await getInstrumentRegistry(); const cold = Date.now() - t0;
  const t1 = Date.now(); for (let i = 0; i < 50; i++) await getInstrumentRegistry(); const warm = Date.now() - t1;
  console.log(`  cold build: ${cold}ms | 50 warm reads: ${warm}ms (${(warm / 50).toFixed(2)}ms each)`);
  const r = await request(app).get('/api/oracle/assets');
  console.log(`  /assets after warm cache: ${r.status}, ${r.body.data.length} rows`);
  invalidateInstrumentRegistry();
  console.log('  invalidateInstrumentRegistry() available for explicit busting');
})();
