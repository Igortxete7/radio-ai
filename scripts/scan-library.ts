import { loadConfig } from '@radio/config';
import { createDatabase } from '@radio/db';
import { RadioService } from '@radio/core';
import { RadioError } from '@radio/shared';
const config = loadConfig();
const db = createDatabase(config.dbUrl);
const radio = new RadioService(config, db);
try {
  console.log(JSON.stringify(await radio.scanLibrary(), null, 2));
} catch (error) {
  console.error(
    JSON.stringify({
      errorCode: error instanceof RadioError ? error.code : 'LIBRARY_SCAN_FAILED',
      message: error instanceof RadioError ? error.message : 'No se pudo escanear la biblioteca',
    }),
  );
  process.exitCode = 1;
} finally {
  await radio.shutdown();
  await db.$disconnect();
}
