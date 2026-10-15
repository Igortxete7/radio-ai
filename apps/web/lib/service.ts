import { loadConfig } from '@radio/config';
import { getDatabase } from '@radio/db';
import { RadioService } from '@radio/core';
const globals = globalThis as typeof globalThis & { radioService?: RadioService };
export function getService() {
  if (!globals.radioService) {
    const config = loadConfig();
    globals.radioService = new RadioService(config, getDatabase(config.dbUrl));
  }
  return globals.radioService;
}
