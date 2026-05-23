/*
  Warnings:

  - The `special_flags` column on the `nifty_scorecards` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - A unique constraint covering the columns `[observation_date,vintage_date]` on the table `nifty_scorecards` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `rating_rule_id` to the `nifty_scorecards` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "nifty_scorecards_observation_date_key";

-- AlterTable
ALTER TABLE "nifty_scorecards" ADD COLUMN     "is_current" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "rating_rule_id" TEXT NOT NULL,
ADD COLUMN     "tool_version" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "vintage_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
DROP COLUMN "special_flags",
ADD COLUMN     "special_flags" JSONB;

-- CreateIndex
CREATE INDEX "nifty_scorecards_observation_current_idx" ON "nifty_scorecards"("observation_date", "is_current");

-- CreateIndex
CREATE UNIQUE INDEX "nifty_scorecards_observation_date_vintage_date_key" ON "nifty_scorecards"("observation_date", "vintage_date");

-- AddForeignKey
ALTER TABLE "nifty_scorecards" ADD CONSTRAINT "nifty_scorecards_rating_rule_id_fkey" FOREIGN KEY ("rating_rule_id") REFERENCES "scorecard_rating_rules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
