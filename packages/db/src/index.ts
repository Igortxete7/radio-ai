import { PrismaClient } from '@prisma/client';
export { Prisma, PrismaClient } from '@prisma/client';
export { createTestDatabase } from './testing.ts';
const instances = new Map<string, PrismaClient>();
export function createDatabase(url: string): PrismaClient {
  const client = new PrismaClient({ datasources: { db: { url } } });
  return client;
}
export function getDatabase(url: string): PrismaClient {
  let client = instances.get(url);
  if (!client) {
    client = createDatabase(url);
    instances.set(url, client);
  }
  return client;
}
