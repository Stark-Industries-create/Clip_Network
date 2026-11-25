-- Admin-managed integration credentials, plus real profile photos and recording thumbnails.
CREATE TABLE "PlatformSetting" (
  "key" TEXT NOT NULL,
  "encryptedValue" TEXT NOT NULL,
  "updatedById" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PlatformSetting_pkey" PRIMARY KEY ("key")
);
ALTER TABLE "CreatorAccount" ADD COLUMN "avatarUrl" TEXT;
ALTER TABLE "SocialAccount" ADD COLUMN "avatarUrl" TEXT;
ALTER TABLE "ChannelVideo" ADD COLUMN "thumbnailUrl" TEXT;
