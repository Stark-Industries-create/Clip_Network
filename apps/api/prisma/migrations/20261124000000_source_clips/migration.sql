ALTER TABLE "ClipJob" ADD COLUMN "sourceVideoId" TEXT REFERENCES "ChannelVideo"("id") ON DELETE SET NULL;
ALTER TABLE "ClipJob" ADD COLUMN "sourceOffsetSec" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "ChannelVideo" ADD COLUMN "automationError" TEXT;
UPDATE "ClipJob" SET "sourceVideoId" = v.id FROM "ChannelVideo" v WHERE v."clipJobId" = "ClipJob".id;
CREATE INDEX "ClipJob_sourceVideoId_idx" ON "ClipJob"("sourceVideoId");
ALTER TABLE "CreatorAccount" ADD COLUMN "discoveryCursor" TEXT;
