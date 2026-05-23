-- Rename 3 PPI indicator codes to match Forex Factory cadence (MoM not YoY)
BEGIN;
UPDATE indicators SET code = 'US_PPI_MOM', name = 'US PPI Month-over-Month' WHERE code = 'US_PPI_YOY';
UPDATE indicators SET code = 'EU_PPI_MOM', name = 'EU PPI Month-over-Month' WHERE code = 'EU_PPI_YOY';
UPDATE indicators SET code = 'UK_PPI_MOM', name = 'UK PPI Output Month-over-Month' WHERE code = 'UK_PPI_YOY';

UPDATE pair_template_rows
SET us_indicator_code = 'US_PPI_MOM',
    eur_indicator_code = 'EU_PPI_MOM',
    gbp_indicator_code = 'UK_PPI_MOM'
WHERE row_code = 'PPI';
COMMIT;
