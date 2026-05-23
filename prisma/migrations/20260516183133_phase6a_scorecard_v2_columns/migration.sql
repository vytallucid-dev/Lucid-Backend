-- AlterTable
ALTER TABLE "nifty_scorecards" ADD COLUMN     "band" VARCHAR(20),
ADD COLUMN     "composition_flag" VARCHAR(40),
ADD COLUMN     "conflict_flag" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "ind_9_raw_composite" SMALLINT,
ADD COLUMN     "peak_score_ceiling_state" JSONB;
