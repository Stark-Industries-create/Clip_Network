CREATE TABLE "InstagramConnection" (
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "existingIdsJson" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "InstagramConnection_pkey" PRIMARY KEY ("workspaceId")
);
CREATE UNIQUE INDEX "InstagramConnection_stateHash_key" ON "InstagramConnection"("stateHash");
