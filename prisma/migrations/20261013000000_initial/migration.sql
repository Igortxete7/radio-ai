-- CreateTable
CREATE TABLE "Track" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "path" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "artist" TEXT NOT NULL,
    "album" TEXT,
    "genre" TEXT,
    "durationSec" REAL NOT NULL,
    "bpm" REAL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "missing" BOOLEAN NOT NULL DEFAULT false,
    "contentHash" TEXT,
    "fileSize" INTEGER,
    "mtimeMs" REAL,
    "metadataEdited" BOOLEAN NOT NULL DEFAULT false,
    "lastPlayedAt" DATETIME,
    "playCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Jingle" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "path" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'ident',
    "durationSec" REAL NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true
);

-- CreateTable
CREATE TABLE "PlayEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "externalId" TEXT,
    "type" TEXT NOT NULL,
    "assetId" TEXT,
    "queueItemId" TEXT,
    "title" TEXT NOT NULL,
    "artist" TEXT,
    "path" TEXT,
    "startedAt" DATETIME NOT NULL,
    "endedAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'PLAYING'
);

-- CreateTable
CREATE TABLE "QueueItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "assetId" TEXT,
    "path" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "artist" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "scheduledFor" DATETIME,
    "dedupeKey" TEXT NOT NULL,
    "queueRequestId" TEXT,
    "errorCode" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AiBreak" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "scheduledFor" DATETIME NOT NULL,
    "script" TEXT,
    "audioPath" TEXT,
    "durationSec" REAL,
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "contextJson" JSONB,
    "dedupeKey" TEXT NOT NULL,
    "queueRequestId" TEXT,
    "errorCode" TEXT,
    "retryable" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "NewsItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "publishedAt" DATETIME NOT NULL,
    "summary" TEXT,
    "fingerprint" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "category" TEXT NOT NULL DEFAULT 'general'
);

-- CreateTable
CREATE TABLE "WeatherSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "location" TEXT NOT NULL,
    "observedAt" DATETIME NOT NULL,
    "payloadJson" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "RadioSetting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "valueJson" JSONB NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "JobRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobName" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "scheduledFor" DATETIME NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "error" TEXT
);

-- CreateTable
CREATE TABLE "SystemEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "level" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "correlationId" TEXT,
    "durationMs" REAL,
    "errorCode" TEXT,
    "detailJson" JSONB
);

-- CreateIndex
CREATE UNIQUE INDEX "Track_path_key" ON "Track"("path");

-- CreateIndex
CREATE UNIQUE INDEX "Jingle_path_key" ON "Jingle"("path");

-- CreateIndex
CREATE UNIQUE INDEX "PlayEvent_externalId_key" ON "PlayEvent"("externalId");

-- CreateIndex
CREATE INDEX "PlayEvent_startedAt_idx" ON "PlayEvent"("startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "QueueItem_dedupeKey_key" ON "QueueItem"("dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "AiBreak_dedupeKey_key" ON "AiBreak"("dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "NewsItem_fingerprint_key" ON "NewsItem"("fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "JobRun_dedupeKey_key" ON "JobRun"("dedupeKey");

-- CreateIndex
CREATE INDEX "SystemEvent_timestamp_idx" ON "SystemEvent"("timestamp");

