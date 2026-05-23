-- AlterTable
ALTER TABLE "cot_data" ADD COLUMN     "change_in_long_contracts" INTEGER,
ADD COLUMN     "change_in_long_pct" DECIMAL(8,4),
ADD COLUMN     "change_in_short_contracts" INTEGER,
ADD COLUMN     "change_in_short_pct" DECIMAL(8,4);
