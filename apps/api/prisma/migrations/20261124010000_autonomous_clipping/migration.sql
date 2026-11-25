ALTER TABLE "CreatorAccount" ADD COLUMN "sourceAccessError" TEXT;
ALTER TABLE "CreatorAccount" ADD COLUMN "sourceAccessCheckedAt" TIMESTAMP(3);
ALTER TABLE "ClipJob" ADD COLUMN "sourceChunkCount" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "ClipJob" ADD COLUMN "contentType" TEXT NOT NULL DEFAULT 'CONVERSATION';
ALTER TABLE "ClipJob" ADD COLUMN "framingMode" TEXT NOT NULL DEFAULT 'AUTO';
ALTER TABLE "ClipJob" ADD COLUMN "renderAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ClipJob" ADD COLUMN "qualityIssue" TEXT;
-- Re-run the one-to-many backfill for any source linked after the previous migration.
UPDATE "ClipJob" SET "sourceVideoId" = v.id FROM "ChannelVideo" v
  WHERE v."clipJobId" = "ClipJob".id AND "ClipJob"."sourceVideoId" IS NULL;
ALTER TABLE "ClipJob" ADD COLUMN "speakerTurnsJson" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "CreatorAccount" ADD COLUMN "spokenLanguage" TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE "Workspace" ADD COLUMN "analysisSecondsUsed" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "Workspace" ADD COLUMN "autoPublishEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Workspace" ADD COLUMN "lastServedAt" TIMESTAMP(3);
ALTER TABLE "ChannelVideo" ADD COLUMN "analysisStartedAt" TIMESTAMP(3);
ALTER TABLE "ChannelVideo" ADD COLUMN "analysisCostJson" TEXT NOT NULL DEFAULT '{}';
ALTER TABLE "ClipJob" ADD COLUMN "sourceSectionUrl" TEXT;
-- Keep the former pilot workspace publishing after the env switch is removed (set it by hand if used).
ALTER TABLE "PublishPost" ADD COLUMN "metricsStage" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PublishPost" ADD COLUMN "metricsCheckedAt" TIMESTAMP(3);
ALTER TABLE "PublishPost" ADD COLUMN "metricsError" TEXT;
CREATE TABLE "RecordingAnalysis" (
  "id" TEXT NOT NULL,
  "platform" TEXT NOT NULL,
  "externalVideoId" TEXT NOT NULL,
  "spokenLanguage" TEXT NOT NULL DEFAULT 'auto',
  "status" TEXT NOT NULL DEFAULT 'RUNNING',
  "leaseUntil" TIMESTAMP(3),
  "manifestKey" TEXT,
  "durationSec" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "costJson" TEXT NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RecordingAnalysis_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RecordingAnalysis_platform_externalVideoId_spokenLanguage_key" ON "RecordingAnalysis"("platform", "externalVideoId", "spokenLanguage");
