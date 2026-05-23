-- CreateTable
CREATE TABLE "edgefinder_pair_scores" (
    "id" TEXT NOT NULL,
    "pair_id" TEXT NOT NULL,
    "score_date" DATE NOT NULL,
    "vintage_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_current" BOOLEAN NOT NULL DEFAULT true,
    "base_pair_score" SMALLINT NOT NULL,
    "pair_cot_score" SMALLINT NOT NULL,
    "base_total" SMALLINT NOT NULL,
    "compass_adjustment" SMALLINT NOT NULL DEFAULT 0,
    "total_score" SMALLINT NOT NULL,
    "compass_overrides_applied" JSONB,
    "regime_at_compute" VARCHAR(15),
    "rating_label" VARCHAR(30) NOT NULL,
    "row_breakdown" JSONB NOT NULL,
    "cot_breakdown" JSONB,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "edgefinder_pair_scores_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "edgefinder_pair_scores_pair_id_score_date_vintage_date_key" ON "edgefinder_pair_scores"("pair_id", "score_date", "vintage_date");

-- CreateIndex
CREATE INDEX "edgefinder_pair_scores_pair_id_score_date_idx" ON "edgefinder_pair_scores"("pair_id", "score_date" DESC);

-- CreateIndex
CREATE INDEX "edgefinder_pair_scores_score_date_current_idx" ON "edgefinder_pair_scores"("score_date", "is_current");

-- AddForeignKey
ALTER TABLE "edgefinder_pair_scores" ADD CONSTRAINT "edgefinder_pair_scores_pair_id_fkey" FOREIGN KEY ("pair_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
