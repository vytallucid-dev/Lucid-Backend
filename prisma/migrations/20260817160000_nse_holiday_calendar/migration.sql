-- NSE trading-day reference (B1 of the data-layer-integrity phase).
--
-- A database table rather than a constant, per instruction, so it can be
-- maintained without a deploy. Combined with a plain Sat/Sun weekend check
-- (see src/core/utils/trading-calendar.ts) to determine whether a date is an
-- NSE trading day.
--
-- Coverage: 2022-06-15 (earliest data_points row across every NIFTY
-- indicator — IND_NIFTY_11_BRENT) through 2026-12-25.
--
-- Source: calendarlabs.com's NSE market holiday pages (fetched 2026-08-17),
-- a third-party aggregator, NOT NSE's own circular directly — direct fetches
-- of nseindia.com/resources/exchange-communication-holidays (timeout) and
-- archives.nseindia.com's circular PDFs (403) both failed during this work.
-- Flagging the source tier explicitly rather than overstating it as primary.
--
-- One reconciliation note: a search-result summary (not calendarlabs itself)
-- described 2022 as having "13" trading holidays; the list actually inserted
-- for 2022 has 14 dates, taken directly from calendarlabs.com's page content.
-- Could not resolve this discrepancy against an official NSE circular PDF
-- (fetch failed) — reporting it rather than silently picking one.
--
-- 2027 GAP — EXPLICIT, NOT FILLED: verified via web search (2026-08-17) that
-- NSE had not yet published its 2027 trading-holiday circular. NSE typically
-- announces the following year's calendar in December. No 2027 rows are
-- inserted here. Until they exist, any date in 2027 is treated as a trading
-- day if it is not a weekend (see trading-calendar.ts) — this WILL
-- misclassify actual 2027 NSE holidays as trading days until this table is
-- updated with real data. That is a known, reported limitation, not an
-- oversight.
--
-- Dates that fall on a weekend already (e.g. 2026-08-15 Independence Day,
-- a Saturday in 2026) are not separately listed here — the weekend check
-- already covers them; no holiday row is needed.
CREATE TABLE "nse_holidays" (
  "date" DATE PRIMARY KEY,
  "name" VARCHAR(120) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO "nse_holidays" ("date", "name") VALUES
-- 2022
('2022-01-26', 'Republic Day'),
('2022-03-01', 'Maha Shivaratri'),
('2022-04-10', 'Ram Navami'),
('2022-04-14', 'Dr. Baba Saheb Ambedkar Jayanti'),
('2022-04-15', 'Good Friday'),
('2022-05-03', 'Id-ul-Fitr (Ramzan Id)'),
('2022-07-10', 'Bakri Id / Eid ul-Adha'),
('2022-08-09', 'Muharram'),
('2022-08-31', 'Ganesh Chaturthi'),
('2022-10-02', 'Mahatma Gandhi Jayanti'),
('2022-10-05', 'Dasara'),
('2022-10-24', 'Diwali-Laxmi Pujan / Diwali-Balipratipada'),
('2022-11-08', 'Guru Nanak Jayanti'),
('2022-12-25', 'Christmas'),
-- 2023
('2023-01-26', 'Republic Day'),
('2023-03-07', 'Holi'),
('2023-03-30', 'Ram Navami'),
('2023-04-04', 'Mahavir Jayanti'),
('2023-04-07', 'Good Friday'),
('2023-04-14', 'Dr. Baba Saheb Ambedkar Jayanti'),
('2023-04-21', 'Id-ul-Fitr (Ramzan Id)'),
('2023-05-01', 'Maharashtra Day'),
('2023-06-28', 'Bakri Id / Eid ul-Adha'),
('2023-08-15', 'Independence Day'),
('2023-09-19', 'Ganesh Chaturthi'),
('2023-10-02', 'Mahatma Gandhi Jayanti'),
('2023-10-24', 'Dasara'),
('2023-11-12', 'Diwali-Laxmi Pujan'),
('2023-11-14', 'Diwali-Balipratipada'),
('2023-11-27', 'Guru Nanak Jayanti'),
('2023-12-25', 'Christmas'),
-- 2024
('2024-01-26', 'Republic Day'),
('2024-03-08', 'Maha Shivaratri'),
('2024-03-25', 'Holi'),
('2024-03-29', 'Good Friday'),
('2024-04-10', 'Id-ul-Fitr (Ramzan Id)'),
('2024-04-14', 'Dr. Baba Saheb Ambedkar Jayanti'),
('2024-04-17', 'Ram Navami'),
('2024-04-21', 'Mahavir Jayanti'),
('2024-05-01', 'Maharashtra Day'),
('2024-06-17', 'Bakri Id / Eid ul-Adha'),
('2024-07-17', 'Muharram'),
('2024-08-15', 'Independence Day'),
('2024-09-07', 'Ganesh Chaturthi'),
('2024-10-02', 'Mahatma Gandhi Jayanti'),
('2024-10-13', 'Dasara'),
('2024-11-01', 'Diwali-Laxmi Pujan'),
('2024-11-02', 'Diwali-Balipratipada'),
('2024-11-15', 'Guru Nanak Jayanti'),
('2024-12-25', 'Christmas'),
-- 2025
('2025-01-26', 'Republic Day'),
('2025-02-26', 'Maha Shivaratri'),
('2025-03-14', 'Holi'),
('2025-03-31', 'Id-ul-Fitr (Ramzan Id)'),
('2025-04-06', 'Ram Navami'),
('2025-04-10', 'Mahavir Jayanti'),
('2025-04-14', 'Dr. Baba Saheb Ambedkar Jayanti'),
('2025-04-18', 'Good Friday'),
('2025-05-01', 'Maharashtra Day'),
('2025-06-07', 'Bakri Id / Eid ul-Adha'),
('2025-07-06', 'Muharram'),
('2025-08-15', 'Independence Day'),
('2025-08-27', 'Ganesh Chaturthi'),
('2025-10-02', 'Dasara / Mahatma Gandhi Jayanti'),
('2025-10-21', 'Diwali-Laxmi Pujan (Morning Off)'),
('2025-10-22', 'Diwali-Balipratipada'),
('2025-11-05', 'Guru Nanak Jayanti'),
('2025-12-25', 'Christmas'),
-- 2026
('2026-01-26', 'Republic Day'),
('2026-03-03', 'Holi'),
('2026-03-26', 'Ram Navami'),
('2026-03-31', 'Mahavir Jayanti'),
('2026-04-03', 'Good Friday'),
('2026-04-14', 'Dr. Baba Saheb Ambedkar Jayanti'),
('2026-05-01', 'Maharashtra Day'),
('2026-05-28', 'Bakri Id / Eid ul-Adha'),
('2026-06-26', 'Muharram'),
('2026-09-14', 'Ganesh Chaturthi'),
('2026-10-02', 'Mahatma Gandhi Jayanti'),
('2026-10-20', 'Dasara'),
('2026-11-08', 'Diwali-Laxmi Pujan (Morning Off)'),
('2026-11-10', 'Diwali-Balipratipada'),
('2026-11-24', 'Guru Nanak Jayanti'),
('2026-12-25', 'Christmas')
ON CONFLICT ("date") DO NOTHING;
