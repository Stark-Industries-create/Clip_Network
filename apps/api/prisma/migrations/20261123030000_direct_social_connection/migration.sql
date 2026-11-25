CREATE TABLE "DirectSocialConnection" (
    "stateHash" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "verifier" TEXT NOT NULL,
    "choices" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "DirectSocialConnection_workspaceId_userId_idx" ON "DirectSocialConnection"("workspaceId", "userId");
ALTER TABLE "PublishPost" ADD COLUMN "directProvider" TEXT;
ALTER TABLE "SocialAccount" ADD COLUMN "directAccountId" TEXT;
CREATE UNIQUE INDEX "SocialAccount_workspaceId_platform_directAccountId_key" ON "SocialAccount"("workspaceId", "platform", "directAccountId");
