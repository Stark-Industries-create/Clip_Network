ALTER TABLE "ClipJob" ADD COLUMN "automationSourceKey" TEXT;
ALTER TABLE "ChannelVideo" ADD COLUMN "nextAutomationAttemptAt" TIMESTAMP(3);
