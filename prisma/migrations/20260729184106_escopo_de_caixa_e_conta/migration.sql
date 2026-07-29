/*
  Warnings:

  - You are about to drop the `AgentInbox` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "AgentInbox" DROP CONSTRAINT "AgentInbox_agentId_fkey";

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "inboxIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
ADD COLUMN     "inboxMode" TEXT NOT NULL DEFAULT 'all';

-- AlterTable
ALTER TABLE "AgentChatwootBot" ADD COLUMN     "accountId" INTEGER;

-- DropTable
DROP TABLE "AgentInbox";
