/// <reference types="node" />
/* eslint-disable no-console */
import {
  AssetClass,
  DataSource,
  IndicatorCategory,
  IndicatorFrequency,
  IndicatorTool,
  PrismaClient,
  ScoringRuleType,
  ToolName,
} from '@prisma/client';

const prisma = new PrismaClient();

type AssetSeed = {
  code: string;
  name: string;
  assetClass: AssetClass;
  toolScope: string[];
  isActive: boolean;
  metadata: Record<string, unknown>;
};

const ASSETS: AssetSeed[] = [
  {
    code: 'USD',
    name: 'US Dollar',
    assetClass: 'currency',
    toolScope: ['edgefinder'],
    isActive: true,
    metadata: {
      country: 'US',
      cotContractCode: '098662',
      cotTraderCategory: 'Non-Commercials',
      display: { flag: '🇺🇸', name: 'US Dollar', cotOrder: 10 },
    },
  },
  {
    code: 'EUR',
    name: 'Euro',
    assetClass: 'currency',
    toolScope: ['edgefinder'],
    isActive: true,
    metadata: {
      country: 'EU',
      cotContractCode: '099741',
      cotTraderCategory: 'Non-Commercials',
      display: { flag: '🇪🇺', name: 'Euro', cotOrder: 20 },
    },
  },
  {
    code: 'GBP',
    name: 'British Pound',
    assetClass: 'currency',
    toolScope: ['edgefinder'],
    isActive: true,
    metadata: {
      country: 'UK',
      cotContractCode: '096742',
      cotTraderCategory: 'Non-Commercials',
      display: { flag: '🇬🇧', name: 'British Pound', cotOrder: 30 },
    },
  },
  {
    code: 'JPY',
    name: 'Japanese Yen',
    assetClass: 'currency',
    toolScope: ['edgefinder'],
    isActive: true,
    metadata: {
      country: 'JP',
      cotContractCode: '097741',
      cotTraderCategory: 'Non-Commercials',
      display: { flag: '🇯🇵', name: 'Japanese Yen', cotOrder: 40 },
    },
  },
  {
    code: 'XAUUSD',
    name: 'Gold',
    assetClass: 'commodity',
    toolScope: ['edgefinder'],
    isActive: true,
    metadata: {
      rate_row_source: 'FED_ONLY',
      cotContractCode: '088691',
      cotTraderCategory: 'Non-Commercials',
      display: { flag: '🥇', name: 'Gold', type: 'Commodity', cotFlag: '🪙',
        scorecardKey: 'Gold', scorecardName: 'Gold (XAUUSD)', screenerOrder: 60, cotOrder: 50 },
    },
  },
  {
    code: 'EURUSD',
    name: 'EUR/USD',
    assetClass: 'forex_pair',
    toolScope: ['edgefinder'],
    isActive: true,
    metadata: { base: 'EUR', quote: 'USD', row_count: 14, display: { screenerOrder: 10 } },
  },
  {
    code: 'GBPUSD',
    name: 'GBP/USD',
    assetClass: 'forex_pair',
    toolScope: ['edgefinder'],
    isActive: true,
    metadata: { base: 'GBP', quote: 'USD', row_count: 14, display: { screenerOrder: 20 } },
  },
  {
    code: 'USDJPY',
    name: 'USD/JPY',
    assetClass: 'forex_pair',
    toolScope: ['edgefinder'],
    isActive: true,
    metadata: { base: 'USD', quote: 'JPY', row_count: 15, display: { screenerOrder: 30 } },
  },
  {
    code: 'EURJPY',
    name: 'EUR/JPY',
    assetClass: 'forex_pair',
    toolScope: ['edgefinder'],
    isActive: true,
    // Phase 5: carry-eligible for Override 5 (EUR funded by zero-yield JPY).
    metadata: { base: 'EUR', quote: 'JPY', row_count: 15, display: { screenerOrder: 40 }, isCarryPair: true },
  },
  {
    code: 'GBPJPY',
    name: 'GBP/JPY',
    assetClass: 'forex_pair',
    toolScope: ['edgefinder'],
    isActive: true,
    // Phase 5: carry-eligible for Override 5 (GBP funded by zero-yield JPY).
    metadata: { base: 'GBP', quote: 'JPY', row_count: 15, display: { screenerOrder: 50 }, isCarryPair: true },
  },
  {
    code: 'SPY',
    name: 'S&P 500 ETF',
    assetClass: 'index',
    toolScope: ['edgefinder'],
    // Phase 1: COT mapping added (verified against the live CFTC Socrata
    // endpoint — "E-MINI S&P 500 - CHICAGO MERCANTILE EXCHANGE").
    // Phase 4: activated. 15 fundamentals + SPY_COT are already mapped.
    isActive: true,
    metadata: {
      rate_row_source: 'FED_ONLY',
      deferred: true,
      cotContractCode: '13874A',
      cotTraderCategory: 'Non-Commercials',
      display: { flag: '🇺🇸', screenerOrder: 110, cotOrder: 70 },
    },
  },
  {
    code: 'NAS100',
    name: 'NASDAQ 100',
    assetClass: 'index',
    toolScope: ['edgefinder'],
    // "NASDAQ MINI - CHICAGO MERCANTILE EXCHANGE" — the E-mini Nasdaq-100 (NQ).
    // Phase 4: activated.
    isActive: true,
    metadata: {
      rate_row_source: 'FED_ONLY',
      deferred: true,
      cotContractCode: '209742',
      cotTraderCategory: 'Non-Commercials',
      display: { flag: '🇺🇸', screenerOrder: 120, cotOrder: 80 },
    },
  },

  // ---------------------------------------------------------------
  // Phase 1 (AUD expansion) — new assets.
  // ---------------------------------------------------------------
  {
    code: 'AUD',
    name: 'Australian Dollar',
    assetClass: 'currency',
    toolScope: ['edgefinder'],
    isActive: true,
    // "AUSTRALIAN DOLLAR - CHICAGO MERCANTILE EXCHANGE".
    metadata: {
      country: 'AU',
      cotContractCode: '232741',
      cotTraderCategory: 'Non-Commercials',
      display: { flag: '🇦🇺', name: 'Australian Dollar', cotOrder: 60 },
    },
  },
  {
    code: 'AUDUSD',
    name: 'AUD/USD',
    assetClass: 'forex_pair',
    toolScope: ['edgefinder'],
    isActive: true,
    metadata: { base: 'AUD', quote: 'USD', row_count: 16, display: { screenerOrder: 70 } },
  },
  {
    code: 'AUDJPY',
    name: 'AUD/JPY',
    assetClass: 'forex_pair',
    toolScope: ['edgefinder'],
    isActive: true,
    // Phase 5: carry-eligible for Override 5 — AUDJPY is the canonical carry
    // pair (high-yield AUD funded by zero-yield JPY), previously excluded by
    // Override 5's hand-maintained EURJPY/GBPJPY-only pair-code check.
    metadata: { base: 'AUD', quote: 'JPY', row_count: 19, display: { screenerOrder: 80 }, isCarryPair: true },
  },
  {
    code: 'EURAUD',
    name: 'EUR/AUD',
    assetClass: 'forex_pair',
    toolScope: ['edgefinder'],
    isActive: true,
    metadata: { base: 'EUR', quote: 'AUD', row_count: 16, display: { screenerOrder: 90 } },
  },
  {
    code: 'GBPAUD',
    name: 'GBP/AUD',
    assetClass: 'forex_pair',
    toolScope: ['edgefinder'],
    isActive: true,
    metadata: { base: 'GBP', quote: 'AUD', row_count: 16, display: { screenerOrder: 100 } },
  },
  {
    code: 'US30',
    name: 'Dow Jones 30',
    assetClass: 'index',
    toolScope: ['edgefinder'],
    // Matches SPY/NAS100. Phase 4: activated.
    isActive: true,
    // "DJIA x $5 - CHICAGO BOARD OF TRADE" — the E-mini Dow (YM, $5 multiplier).
    metadata: {
      rate_row_source: 'FED_ONLY',
      deferred: true,
      cotContractCode: '124603',
      cotTraderCategory: 'Non-Commercials',
      display: { flag: '🇺🇸', screenerOrder: 130, cotOrder: 90 },
    },
  },
];

type IndicatorSeed = {
  code: string;
  name: string;
  category: IndicatorCategory;
  tool: IndicatorTool;
  frequency: IndicatorFrequency;
  country: string;
  uiGroup: string;
  dataSource: DataSource;
  sourceSeriesId: string | null;
  description?: string;
  /**
   * Phase 6: defaults to true (unset), matching every indicator's behaviour
   * before this field existed. Set false to retire an indicator's LIVE
   * scoring/pair participation without deleting it or its historical data.
   */
  isActive?: boolean;
};

const INDICATORS: IndicatorSeed[] = [
  // US (14)
  {
    code: 'US_GDP_QOQ',
    name: 'US GDP Growth Rate QoQ',
    category: 'global',
    tool: 'edgefinder',
    frequency: 'quarterly',
    country: 'US',
    uiGroup: 'Growth',
    dataSource: 'forex_factory',
    sourceSeriesId: null,
    description: 'Latest release (Adv→2nd→Final). Take whichever print is current.',
  },
  {
    code: 'US_ISM_MFG',
    name: 'US ISM Manufacturing PMI',
    category: 'global',
    tool: 'edgefinder',
    frequency: 'monthly',
    country: 'US',
    uiGroup: 'Growth',
    dataSource: 'forex_factory',
    sourceSeriesId: null,
    description: 'ISM, NOT S&P Global.',
  },
  {
    code: 'US_ISM_SVC',
    name: 'US ISM Services PMI',
    category: 'global',
    tool: 'edgefinder',
    frequency: 'monthly',
    country: 'US',
    uiGroup: 'Growth',
    dataSource: 'forex_factory',
    sourceSeriesId: null,
    description: 'ISM Services (Non-Mfg), NOT S&P Global.',
  },
  {
    code: 'US_RETAIL_MOM',
    name: 'US Retail Sales MoM',
    category: 'global',
    tool: 'edgefinder',
    frequency: 'monthly',
    country: 'US',
    uiGroup: 'Growth',
    dataSource: 'forex_factory',
    sourceSeriesId: null,
    description: 'Headline, NOT control group.',
  },
  {
    code: 'US_CB_CONSCONF',
    name: 'US Consumer Confidence (Conf. Board)',
    category: 'sentiment',
    tool: 'edgefinder',
    frequency: 'monthly',
    country: 'US',
    uiGroup: 'Sentiment',
    dataSource: 'forex_factory',
    sourceSeriesId: null,
    description: 'Conference Board, NOT Michigan Sentiment.',
  },
  {
    code: 'US_CPI_YOY',
    name: 'US CPI YoY (Headline)',
    category: 'global',
    tool: 'edgefinder',
    frequency: 'monthly',
    country: 'US',
    uiGroup: 'Inflation',
    dataSource: 'forex_factory',
    sourceSeriesId: null,
    description: 'Headline all-items, NOT Core.',
  },
  {
    code: 'US_PPI_MOM',
    name: 'US PPI MoM (Headline)',
    category: 'global',
    tool: 'edgefinder',
    frequency: 'monthly',
    country: 'US',
    uiGroup: 'Inflation',
    dataSource: 'forex_factory',
    sourceSeriesId: null,
    description: 'Headline final demand, NOT Core.',
  },
  {
    code: 'US_PCE_YOY',
    name: 'US Core PCE YoY',
    category: 'global',
    tool: 'edgefinder',
    frequency: 'monthly',
    country: 'US',
    uiGroup: 'Inflation',
    dataSource: 'forex_factory',
    sourceSeriesId: null,
    description: 'CORE PCE (~3.4), NOT headline (~4.1). Most common error.',
  },
  {
    code: 'US_02Y_SMA',
    name: 'US 2Y Yield (21-day SMA)',
    category: 'global',
    tool: 'edgefinder',
    frequency: 'daily',
    country: 'US',
    uiGroup: 'Rates',
    dataSource: 'fred',
    sourceSeriesId: 'DGS2',
    description: '2Y yield, 21-day SMA computed. Not a calendar print.',
  },
  {
    code: 'US_NFP',
    name: 'US Non-Farm Payrolls',
    category: 'global',
    tool: 'edgefinder',
    frequency: 'monthly',
    country: 'US',
    uiGroup: 'Jobs',
    dataSource: 'forex_factory',
    sourceSeriesId: null,
    description: 'Original print, not later revision.',
  },
  {
    code: 'US_UNEMP',
    name: 'US Unemployment Rate',
    category: 'global',
    tool: 'edgefinder',
    frequency: 'monthly',
    country: 'US',
    uiGroup: 'Jobs',
    dataSource: 'forex_factory',
    sourceSeriesId: null,
  },
  {
    code: 'US_JOBLESS_CLAIMS',
    name: 'US Initial Jobless Claims',
    category: 'global',
    tool: 'edgefinder',
    frequency: 'weekly',
    country: 'US',
    uiGroup: 'Jobs',
    dataSource: 'forex_factory',
    sourceSeriesId: null,
    description: 'Initial, NOT continuing.',
  },
  {
    code: 'US_ADP',
    name: 'US ADP Employment Change',
    category: 'global',
    tool: 'edgefinder',
    frequency: 'monthly',
    country: 'US',
    uiGroup: 'Jobs',
    dataSource: 'forex_factory',
    sourceSeriesId: null,
  },
  {
    code: 'US_JOLTS',
    name: 'US JOLTS Job Openings',
    category: 'global',
    tool: 'edgefinder',
    frequency: 'monthly',
    country: 'US',
    uiGroup: 'Jobs',
    dataSource: 'forex_factory',
    sourceSeriesId: null,
  },

  // EU (8)
  {
    code: 'EU_GDP_QOQ',
    name: 'EU GDP Growth Rate QoQ',
    category: 'global',
    tool: 'edgefinder',
    frequency: 'quarterly',
    country: 'EU',
    uiGroup: 'Growth',
    dataSource: 'forex_factory',
    sourceSeriesId: null,
    description: 'Latest print (flash→final).',
  },
  {
    code: 'EU_MFG_PMI',
    name: 'EU HCOB Manufacturing PMI',
    category: 'global',
    tool: 'edgefinder',
    frequency: 'monthly',
    country: 'EU',
    uiGroup: 'Growth',
    dataSource: 'forex_factory',
    sourceSeriesId: null,
    description: 'Eurozone aggregate, flash→final. NOT country-level.',
  },
  {
    code: 'EU_SVC_PMI',
    name: 'EU HCOB Services PMI',
    category: 'global',
    tool: 'edgefinder',
    frequency: 'monthly',
    country: 'EU',
    uiGroup: 'Growth',
    dataSource: 'forex_factory',
    sourceSeriesId: null,
    description: 'Eurozone aggregate, flash→final.',
  },
  {
    code: 'EU_RETAIL_MOM',
    name: 'EU Retail Sales MoM',
    category: 'global',
    tool: 'edgefinder',
    frequency: 'monthly',
    country: 'EU',
    uiGroup: 'Growth',
    dataSource: 'forex_factory',
    sourceSeriesId: null,
    description: 'First estimate.',
  },
  {
    code: 'EU_CCI',
    name: 'EU Consumer Confidence (EC CCI)',
    category: 'sentiment',
    tool: 'edgefinder',
    frequency: 'monthly',
    country: 'EU',
    uiGroup: 'Sentiment',
    dataSource: 'forex_factory',
    sourceSeriesId: null,
  },
  {
    code: 'EU_CPI_YOY',
    name: 'EU CPI YoY (HICP Headline)',
    category: 'global',
    tool: 'edgefinder',
    frequency: 'monthly',
    country: 'EU',
    uiGroup: 'Inflation',
    dataSource: 'forex_factory',
    sourceSeriesId: null,
    description: 'HICP headline final (~mid-month). NOT flash, NOT Core.',
  },
  {
    code: 'EU_PPI_MOM',
    name: 'EU PPI MoM (Headline)',
    category: 'global',
    tool: 'edgefinder',
    frequency: 'monthly',
    country: 'EU',
    uiGroup: 'Inflation',
    dataSource: 'forex_factory',
    sourceSeriesId: null,
    description: 'Headline, NOT ex-energy.',
  },
  {
    code: 'EU_UNEMP',
    name: 'EU Unemployment Rate',
    category: 'global',
    tool: 'edgefinder',
    frequency: 'monthly',
    country: 'EU',
    uiGroup: 'Jobs',
    dataSource: 'forex_factory',
    sourceSeriesId: null,
  },

  // UK (7)
  {
    code: 'UK_GDP_MOM',
    name: 'UK GDP Growth Rate MoM',
    category: 'global',
    tool: 'edgefinder',
    frequency: 'monthly',
    country: 'UK',
    uiGroup: 'Growth',
    dataSource: 'forex_factory',
    sourceSeriesId: null,
    description: 'MONTHLY GDP — UK only. Not QoQ.',
  },
  {
    code: 'UK_MFG_PMI',
    name: 'UK S&P/CIPS Manufacturing PMI',
    category: 'global',
    tool: 'edgefinder',
    frequency: 'monthly',
    country: 'UK',
    uiGroup: 'Growth',
    dataSource: 'forex_factory',
    sourceSeriesId: null,
    description: 'Flash→final.',
  },
  {
    code: 'UK_SVC_PMI',
    name: 'UK S&P/CIPS Services PMI',
    category: 'global',
    tool: 'edgefinder',
    frequency: 'monthly',
    country: 'UK',
    uiGroup: 'Growth',
    dataSource: 'forex_factory',
    sourceSeriesId: null,
    description: 'Flash→final.',
  },
  {
    code: 'UK_RETAIL_MOM',
    name: 'UK Retail Sales MoM',
    category: 'global',
    tool: 'edgefinder',
    frequency: 'monthly',
    country: 'UK',
    uiGroup: 'Growth',
    dataSource: 'forex_factory',
    sourceSeriesId: null,
    description: 'Incl. fuel.',
  },
  {
    code: 'UK_GFK',
    name: 'UK Consumer Confidence (GfK)',
    category: 'sentiment',
    tool: 'edgefinder',
    frequency: 'monthly',
    country: 'UK',
    uiGroup: 'Sentiment',
    dataSource: 'forex_factory',
    sourceSeriesId: null,
  },
  {
    code: 'UK_CPI_YOY',
    name: 'UK CPI YoY',
    category: 'global',
    tool: 'edgefinder',
    frequency: 'monthly',
    country: 'UK',
    uiGroup: 'Inflation',
    dataSource: 'forex_factory',
    sourceSeriesId: null,
    description: 'CPI (~3.0), NOT CPIH (~3.2). Headline, not Core.',
  },
  {
    code: 'UK_PPI_MOM',
    name: 'UK PPI Output MoM',
    category: 'global',
    tool: 'edgefinder',
    frequency: 'monthly',
    country: 'UK',
    uiGroup: 'Inflation',
    dataSource: 'forex_factory',
    sourceSeriesId: null,
    description: 'OUTPUT PPI, NOT Input.',
  },
  {
    code: 'UK_UNEMP',
    name: 'UK Unemployment Rate',
    category: 'global',
    tool: 'edgefinder',
    frequency: 'monthly',
    country: 'UK',
    uiGroup: 'Jobs',
    dataSource: 'forex_factory',
    sourceSeriesId: null,
    description: '3-month ILO rate.',
  },

  // JP (9)
  {
    code: 'JP_GDP_QOQ',
    name: 'JP GDP Growth Rate QoQ',
    category: 'global',
    tool: 'edgefinder',
    frequency: 'quarterly',
    country: 'JP',
    uiGroup: 'Growth',
    dataSource: 'forex_factory',
    sourceSeriesId: null,
    description: 'Latest print. Heavy prelim→final revisions.',
  },
  {
    code: 'JP_MFG_PMI',
    name: 'JP Jibun Bank Manufacturing PMI',
    category: 'global',
    tool: 'edgefinder',
    frequency: 'monthly',
    country: 'JP',
    uiGroup: 'Growth',
    dataSource: 'forex_factory',
    sourceSeriesId: null,
    description: 'Flash→final.',
  },
  {
    code: 'JP_SVC_PMI',
    name: 'JP Jibun Bank Services PMI',
    category: 'global',
    tool: 'edgefinder',
    frequency: 'monthly',
    country: 'JP',
    uiGroup: 'Growth',
    dataSource: 'forex_factory',
    sourceSeriesId: null,
    description: 'WARNING: EdgeFinder source feed was frozen (Jul 2024). Enter fresh from source; verify date is current.',
  },
  {
    code: 'JP_RETAIL_YOY',
    name: 'JP Retail Sales YoY',
    category: 'global',
    tool: 'edgefinder',
    frequency: 'monthly',
    country: 'JP',
    uiGroup: 'Growth',
    dataSource: 'forex_factory',
    sourceSeriesId: null,
    description: 'YoY, NOT MoM.',
  },
  {
    code: 'JP_CONSCONF',
    name: 'JP Consumer Confidence (Cabinet Office)',
    category: 'sentiment',
    tool: 'edgefinder',
    frequency: 'monthly',
    country: 'JP',
    uiGroup: 'Sentiment',
    dataSource: 'forex_factory',
    sourceSeriesId: null,
  },
  {
    code: 'JP_CPI_YOY',
    name: 'JP CPI YoY (National)',
    category: 'global',
    tool: 'edgefinder',
    frequency: 'monthly',
    country: 'JP',
    uiGroup: 'Inflation',
    dataSource: 'forex_factory',
    sourceSeriesId: null,
    description: 'National all-items headline. NOT Core, NOT Tokyo.',
  },
  {
    code: 'JP_PPI_YOY',
    name: 'JP PPI YoY (CGPI)',
    category: 'global',
    tool: 'edgefinder',
    frequency: 'monthly',
    country: 'JP',
    uiGroup: 'Inflation',
    dataSource: 'forex_factory',
    sourceSeriesId: null,
    description: 'Corporate Goods Price Index.',
  },
  {
    code: 'JP_HSHLD_SPEND',
    name: 'JP Household Spending YoY',
    category: 'global',
    tool: 'edgefinder',
    frequency: 'monthly',
    country: 'JP',
    uiGroup: 'Inflation',
    dataSource: 'forex_factory',
    sourceSeriesId: null,
  },
  {
    code: 'JP_UNEMP',
    name: 'JP Unemployment Rate',
    category: 'global',
    tool: 'edgefinder',
    frequency: 'monthly',
    country: 'JP',
    uiGroup: 'Jobs',
    dataSource: 'forex_factory',
    sourceSeriesId: null,
  },

  // Rate decisions (4)
  {
    code: 'US_FED_RATE',
    name: 'US Fed Funds Rate Decision',
    category: 'global',
    tool: 'edgefinder',
    frequency: 'event_driven',
    country: 'US',
    uiGroup: 'Rates',
    dataSource: 'forex_factory',
    sourceSeriesId: null,
  },
  {
    code: 'EU_ECB_RATE',
    name: 'ECB Main Refinancing Rate Decision',
    category: 'global',
    tool: 'edgefinder',
    frequency: 'event_driven',
    country: 'EU',
    uiGroup: 'Rates',
    dataSource: 'forex_factory',
    sourceSeriesId: null,
  },
  {
    code: 'UK_BOE_RATE',
    name: 'BoE Bank Rate Decision',
    category: 'global',
    tool: 'edgefinder',
    frequency: 'event_driven',
    country: 'UK',
    uiGroup: 'Rates',
    dataSource: 'forex_factory',
    sourceSeriesId: null,
  },
  {
    code: 'JP_BOJ_RATE',
    name: 'BoJ Policy Rate Decision',
    category: 'global',
    tool: 'edgefinder',
    frequency: 'event_driven',
    country: 'JP',
    uiGroup: 'Rates',
    dataSource: 'forex_factory',
    sourceSeriesId: null,
  },
  // COT indicators — scored via cot_two_component rule.
  // country uses the currency/asset code (USD/EUR/GBP/JPY/XAU) rather than the
  // country code convention used elsewhere, per Step B spec clarification.
  {
    code: 'USD_COT',
    name: 'USD Commitment of Traders Score',
    category: 'flow',
    tool: 'edgefinder',
    frequency: 'weekly',
    country: 'USD',
    uiGroup: 'COT',
    dataSource: 'cftc',
    sourceSeriesId: null,
  },
  {
    code: 'EUR_COT',
    name: 'EUR Commitment of Traders Score',
    category: 'flow',
    tool: 'edgefinder',
    frequency: 'weekly',
    country: 'EUR',
    uiGroup: 'COT',
    dataSource: 'cftc',
    sourceSeriesId: null,
  },
  {
    code: 'GBP_COT',
    name: 'GBP Commitment of Traders Score',
    category: 'flow',
    tool: 'edgefinder',
    frequency: 'weekly',
    country: 'GBP',
    uiGroup: 'COT',
    dataSource: 'cftc',
    sourceSeriesId: null,
  },
  {
    code: 'JPY_COT',
    name: 'JPY Commitment of Traders Score',
    category: 'flow',
    tool: 'edgefinder',
    frequency: 'weekly',
    country: 'JPY',
    uiGroup: 'COT',
    dataSource: 'cftc',
    sourceSeriesId: null,
  },
  {
    code: 'XAUUSD_COT',
    name: 'Gold Commitment of Traders Score',
    category: 'flow',
    tool: 'edgefinder',
    frequency: 'weekly',
    country: 'XAU',
    uiGroup: 'COT',
    dataSource: 'cftc',
    sourceSeriesId: null,
  },

  // ---------------------------------------------------------------
  // Phase 1 — JP additions (2).
  // ---------------------------------------------------------------
  {
    code: 'JP_CASH_EARNINGS_YOY',
    name: 'JP Labor Cash Earnings YoY',
    category: 'global',
    tool: 'edgefinder',
    frequency: 'monthly',
    country: 'JP',
    uiGroup: 'Jobs',
    dataSource: 'forex_factory',
    sourceSeriesId: null,
    description:
      'Wage growth. Scored NORMAL, deliberately NOT cpi_rate_cycle: a wage miss must be able to score -1. The cycle rule floors a miss at 0 under HIKING, which would make this a permanent JPY-bull row.',
  },
  {
    code: 'JP_TOKYO_CPI_YOY',
    name: 'JP Tokyo Core CPI YoY',
    category: 'global',
    tool: 'edgefinder',
    frequency: 'monthly',
    country: 'JP',
    uiGroup: 'Inflation',
    dataSource: 'forex_factory',
    sourceSeriesId: null,
    description:
      'Leading indicator for national CPI. Reuses the SAME JPY CurrencyCycleStance row as JP_CPI_YOY — no second stance record, no second gate, so both CPI rows flip together when the declared cycle flips.',
  },

  // ---------------------------------------------------------------
  // Phase 1 — AU (10) + CN proxy (1).
  // CN_CAIXIN_PMI_MFG is deliberately country='CN', not 'AU'. It is an
  // AUD-side proxy for Chinese industrial demand; AUD resolves as ['AU','CN']
  // in Phase 2 (COUNTRY_BY_ASSET already accepts an array).
  // ---------------------------------------------------------------
  {
    code: 'AU_GDP_QOQ',
    name: 'AU GDP Growth Rate QoQ',
    category: 'global',
    tool: 'edgefinder',
    frequency: 'quarterly',
    country: 'AU',
    uiGroup: 'Growth',
    dataSource: 'forex_factory',
    sourceSeriesId: null,
  },
  {
    code: 'AU_PMI_MFG',
    name: 'AU Judo Bank Manufacturing PMI',
    category: 'global',
    tool: 'edgefinder',
    frequency: 'monthly',
    country: 'AU',
    uiGroup: 'Growth',
    dataSource: 'forex_factory',
    sourceSeriesId: null,
    description: 'Judo Bank / S&P Global. Flash→final.',
  },
  {
    code: 'AU_PMI_SVC',
    name: 'AU Judo Bank Services PMI',
    category: 'global',
    tool: 'edgefinder',
    frequency: 'monthly',
    country: 'AU',
    uiGroup: 'Growth',
    dataSource: 'forex_factory',
    sourceSeriesId: null,
    description: 'Judo Bank / S&P Global.',
  },
  {
    code: 'AU_MHSI_MOM',
    name: 'Household Spending MoM',
    category: 'global',
    tool: 'edgefinder',
    frequency: 'monthly',
    country: 'AU',
    uiGroup: 'Growth',
    dataSource: 'forex_factory',
    sourceSeriesId: null,
    // Phase 7: reverses Phase 6's retirement of AU_RETAIL_MOM. ABS ceased
    // publishing Retail Trade 31 July 2025, and Phase 6 retired that series on
    // the assumption of accumulated history that would score indefinitely
    // against a frozen value. There was none — this indicator was seeded in
    // Phase 1 and never populated (zero DataPoint rows, confirmed before this
    // rename). With no history to conflate, the ABS's designated successor —
    // the Monthly Household Spending Indicator (household spending including
    // services, built from transaction data, not retail business turnover —
    // a different measure, but with nothing on record it's a rename rather
    // than a migration) — takes the same code slot's place under a new code.
    // isActive restored to true; the AUD cell on the RETAIL pair-template row
    // is restored below (see PAIR_TEMPLATE_CURRENCIES and
    // seedPairTemplateRowCurrencies()). First print due 4 Aug 2026 — this
    // indicator shows insufficient_data until then, correctly.
    isActive: true,
    description:
      'ABS Monthly Household Spending Indicator. Replaces AU_RETAIL_MOM (discontinued, zero history) from Phase 7 — same RETAIL template row, same AUD scoring slot, different underlying series.',
  },
  {
    code: 'AU_CONSCONF',
    name: 'AU Westpac Consumer Confidence',
    category: 'sentiment',
    tool: 'edgefinder',
    frequency: 'monthly',
    country: 'AU',
    uiGroup: 'Sentiment',
    dataSource: 'forex_factory',
    sourceSeriesId: null,
    description: 'Westpac-Melbourne Institute. Scores fully, as for every other currency.',
  },
  {
    code: 'AU_CPI_YOY',
    name: 'AU CPI YoY',
    category: 'global',
    tool: 'edgefinder',
    frequency: 'monthly',
    country: 'AU',
    uiGroup: 'Inflation',
    dataSource: 'forex_factory',
    sourceSeriesId: null,
    description: 'Monthly CPI indicator series only from late 2025; quarterly series precedes it.',
  },
  {
    code: 'AU_PPI_YOY',
    name: 'AU PPI YoY',
    category: 'global',
    tool: 'edgefinder',
    frequency: 'quarterly',
    country: 'AU',
    uiGroup: 'Inflation',
    dataSource: 'forex_factory',
    sourceSeriesId: null,
    description:
      'QUARTERLY against monthly counterparts. Scores anyway (JP Services PMI precedent) but must surface in the staleness display.',
  },
  {
    code: 'AU_UNEMPLOYMENT',
    name: 'AU Unemployment Rate',
    category: 'global',
    tool: 'edgefinder',
    frequency: 'monthly',
    country: 'AU',
    uiGroup: 'Jobs',
    dataSource: 'forex_factory',
    sourceSeriesId: null,
  },
  {
    code: 'AU_EMPLOYMENT_CHANGE',
    name: 'AU Employment Change',
    category: 'global',
    tool: 'edgefinder',
    frequency: 'monthly',
    country: 'AU',
    uiGroup: 'Jobs',
    dataSource: 'forex_factory',
    sourceSeriesId: null,
    description:
      'ABS Labour Force. Deliberately NOT mapped head-to-head against US NFP: both series are noisy (ABS sample rotation, NFP revisions) and pairing them manufactures +/-2 swings from statistical dirt.',
  },
  {
    code: 'CN_CAIXIN_PMI_MFG',
    // Phase 6: renamed from "China Caixin Manufacturing PMI". Same S&P Global
    // survey, same methodology, published under a new name from the August
    // 2025 release onward. Label-only change — code, asset_indicator_map row,
    // scoring rule and every historical DataPoint/Score row are untouched.
    name: 'RatingDog China Manufacturing PMI',
    category: 'global',
    tool: 'edgefinder',
    frequency: 'monthly',
    country: 'CN',
    uiGroup: 'Growth',
    dataSource: 'forex_factory',
    sourceSeriesId: null,
    description:
      'country=CN by design. AUD-side proxy for Chinese industrial demand; AUD resolves as ["AU","CN"].',
  },
  {
    code: 'AU_RBA_RATE',
    name: 'RBA Cash Rate Decision',
    category: 'global',
    tool: 'edgefinder',
    frequency: 'event_driven',
    country: 'AU',
    uiGroup: 'Rates',
    dataSource: 'forex_factory',
    sourceSeriesId: null,
    description: '8 meetings/yr. Sticky: carries between meetings like the other rate decisions.',
  },
  {
    code: 'AUD_COT',
    name: 'AUD Commitment of Traders Score',
    category: 'flow',
    tool: 'edgefinder',
    frequency: 'weekly',
    country: 'AUD',
    uiGroup: 'COT',
    dataSource: 'cftc',
    sourceSeriesId: null,
  },

  // ---------------------------------------------------------------
  // Phase 4 — index COT indicators. Contract codes have sat on the SPY,
  // NAS100 and US30 asset rows since Phase 1 with nothing behind them
  // (asset_indicator_map needs an indicator to point at, exactly as AUD_COT
  // was created for that reason). Same shape as the five original COT
  // indicators.
  //
  // `country` is VarChar(3) in the schema (see indicators.country) — AUD_COT
  // fits its full code (3 chars) but XAUUSD_COT does not, so that precedent
  // already uses a short 3-letter form ('XAU') rather than the full asset
  // code. NAS100 (6 chars) and US30 (4 chars) don't fit either, so they get
  // the same treatment with standard ticker abbreviations: NDX (Nasdaq-100)
  // and DJI (Dow Jones Industrial Average). SPY's own code already fits.
  // This is cosmetic only — asset_indicator_map, not `country`, drives
  // scoring membership since Phase 2.
  // ---------------------------------------------------------------
  {
    code: 'SPY_COT',
    name: 'SPY Commitment of Traders Score',
    category: 'flow',
    tool: 'edgefinder',
    frequency: 'weekly',
    country: 'SPY',
    uiGroup: 'COT',
    dataSource: 'cftc',
    sourceSeriesId: null,
  },
  {
    code: 'NAS100_COT',
    name: 'NAS100 Commitment of Traders Score',
    category: 'flow',
    tool: 'edgefinder',
    frequency: 'weekly',
    country: 'NDX',
    uiGroup: 'COT',
    dataSource: 'cftc',
    sourceSeriesId: null,
  },
  {
    code: 'US30_COT',
    name: 'US30 Commitment of Traders Score',
    category: 'flow',
    tool: 'edgefinder',
    frequency: 'weekly',
    country: 'DJI',
    uiGroup: 'COT',
    dataSource: 'cftc',
    sourceSeriesId: null,
  },
];

type ScoringRuleSeed = {
  ruleType: ScoringRuleType;
  ruleDefinition: Record<string, unknown>;
};

function ruleForIndicator(code: string): ScoringRuleSeed {
  const invertedCodes = new Set([
    'US_UNEMP',
    'EU_UNEMP',
    'UK_UNEMP',
    'JP_UNEMP',
    'US_JOBLESS_CLAIMS',
    // Phase 1: AU unemployment behaves like every other unemployment rate.
    'AU_UNEMPLOYMENT',
  ]);
  const cpiRateCycle: Record<string, string> = {
    US_CPI_YOY: 'USD',
    EU_CPI_YOY: 'EUR',
    UK_CPI_YOY: 'GBP',
    JP_CPI_YOY: 'JPY',
    // Phase 1. Tokyo CPI intentionally shares the JPY stance row with
    // JP_CPI_YOY — one gate, so both flip together.
    JP_TOKYO_CPI_YOY: 'JPY',
    AU_CPI_YOY: 'AUD',
  };
  const rateDecisionCodes = new Set([
    'US_FED_RATE',
    'EU_ECB_RATE',
    'UK_BOE_RATE',
    'JP_BOJ_RATE',
    'AU_RBA_RATE',
  ]);
  const cotAssetByIndicator: Record<string, string> = {
    USD_COT: 'USD',
    EUR_COT: 'EUR',
    GBP_COT: 'GBP',
    JPY_COT: 'JPY',
    XAUUSD_COT: 'XAUUSD',
    AUD_COT: 'AUD',
    // Phase 4.
    SPY_COT: 'SPY',
    NAS100_COT: 'NAS100',
    US30_COT: 'US30',
  };
  // NOTE: JP_CASH_EARNINGS_YOY and AU_EMPLOYMENT_CHANGE are absent from every
  // set above on purpose — they fall through to `normal` below. Wage growth
  // must be able to score -1 on a miss.

  if (code in cotAssetByIndicator) {
    return {
      ruleType: 'cot_two_component',
      ruleDefinition: { type: 'cot_two_component', asset_code: cotAssetByIndicator[code] },
    };
  }
  if (invertedCodes.has(code)) {
    return {
      ruleType: 'inverted',
      ruleDefinition: { type: 'inverted', forecast_tolerance_pct: 0.05 },
    };
  }
  if (code in cpiRateCycle) {
    return {
      ruleType: 'cpi_rate_cycle',
      ruleDefinition: { type: 'cpi_rate_cycle', currency_code: cpiRateCycle[code] },
    };
  }
  if (code === 'US_02Y_SMA') {
    return { ruleType: 'us02y_sma', ruleDefinition: { type: 'us02y_sma', flat_band_bp: 1 } };
  }
  if (rateDecisionCodes.has(code)) {
    return { ruleType: 'rate_decision', ruleDefinition: { type: 'rate_decision' } };
  }
  return { ruleType: 'normal', ruleDefinition: { type: 'normal', forecast_tolerance_pct: 0.05 } };
}

type PairTemplateSeed = {
  rowOrder: number;
  rowCode: string;
  displayName: string;
  uiGroup: string;
  treatment: string;
  usIndicatorCode: string | null;
  eurIndicatorCode: string | null;
  gbpIndicatorCode: string | null;
  jpyIndicatorCode: string | null;
  // Phase 1 shipped the four new rows isActive=false so the then-authoritative
  // legacy loader could not see them and live pair scores stayed identical.
  // Phase 2 activated them AFTER the loader cutover passed its regression gate
  // with zero differences, so all 19 rows are now active. Retained as an
  // optional field so a row can still be parked without deleting it.
  isActive?: boolean;
};

const PAIR_TEMPLATE_ROWS: PairTemplateSeed[] = [
  {
    rowOrder: 1,
    rowCode: 'GDP',
    displayName: 'GDP',
    uiGroup: 'Growth',
    treatment: 'BILATERAL',
    usIndicatorCode: 'US_GDP_QOQ',
    eurIndicatorCode: 'EU_GDP_QOQ',
    gbpIndicatorCode: 'UK_GDP_MOM',
    jpyIndicatorCode: 'JP_GDP_QOQ',
  },
  {
    rowOrder: 2,
    rowCode: 'MFG_PMI',
    displayName: 'Manufacturing PMI',
    uiGroup: 'Growth',
    treatment: 'BILATERAL',
    usIndicatorCode: 'US_ISM_MFG',
    eurIndicatorCode: 'EU_MFG_PMI',
    gbpIndicatorCode: 'UK_MFG_PMI',
    jpyIndicatorCode: 'JP_MFG_PMI',
  },
  {
    rowOrder: 3,
    rowCode: 'SVC_PMI',
    displayName: 'Services PMI',
    uiGroup: 'Growth',
    treatment: 'BILATERAL',
    usIndicatorCode: 'US_ISM_SVC',
    eurIndicatorCode: 'EU_SVC_PMI',
    gbpIndicatorCode: 'UK_SVC_PMI',
    jpyIndicatorCode: 'JP_SVC_PMI',
  },
  {
    rowOrder: 4,
    rowCode: 'RETAIL',
    displayName: 'Retail Sales',
    uiGroup: 'Growth',
    treatment: 'BILATERAL',
    usIndicatorCode: 'US_RETAIL_MOM',
    eurIndicatorCode: 'EU_RETAIL_MOM',
    gbpIndicatorCode: 'UK_RETAIL_MOM',
    jpyIndicatorCode: 'JP_RETAIL_YOY',
  },
  {
    rowOrder: 5,
    rowCode: 'CONSCONF',
    displayName: 'Consumer Confidence',
    uiGroup: 'Sentiment',
    treatment: 'BILATERAL',
    usIndicatorCode: 'US_CB_CONSCONF',
    eurIndicatorCode: 'EU_CCI',
    gbpIndicatorCode: 'UK_GFK',
    jpyIndicatorCode: 'JP_CONSCONF',
  },
  {
    rowOrder: 6,
    rowCode: 'CPI',
    displayName: 'CPI',
    uiGroup: 'Inflation',
    treatment: 'BILATERAL',
    usIndicatorCode: 'US_CPI_YOY',
    eurIndicatorCode: 'EU_CPI_YOY',
    gbpIndicatorCode: 'UK_CPI_YOY',
    jpyIndicatorCode: 'JP_CPI_YOY',
  },
  {
    rowOrder: 7,
    rowCode: 'PPI',
    displayName: 'PPI',
    uiGroup: 'Inflation',
    treatment: 'BILATERAL',
    usIndicatorCode: 'US_PPI_MOM',
    eurIndicatorCode: 'EU_PPI_MOM',
    gbpIndicatorCode: 'UK_PPI_MOM',
    jpyIndicatorCode: 'JP_PPI_YOY',
  },
  {
    rowOrder: 8,
    rowCode: 'PCE',
    displayName: 'PCE',
    uiGroup: 'Inflation',
    treatment: 'USD_ONLY',
    usIndicatorCode: 'US_PCE_YOY',
    eurIndicatorCode: null,
    gbpIndicatorCode: null,
    jpyIndicatorCode: null,
  },
  {
    rowOrder: 9,
    rowCode: 'HSHLD_SPEND',
    displayName: 'Household Spending',
    uiGroup: 'Inflation',
    treatment: 'JPY_ONLY',
    usIndicatorCode: null,
    eurIndicatorCode: null,
    gbpIndicatorCode: null,
    jpyIndicatorCode: 'JP_HSHLD_SPEND',
  },
  {
    rowOrder: 10,
    rowCode: 'NFP_EMPL',
    displayName: 'Employment Change (NFP)',
    uiGroup: 'Jobs',
    treatment: 'USD_ONLY',
    usIndicatorCode: 'US_NFP',
    eurIndicatorCode: null,
    gbpIndicatorCode: null,
    jpyIndicatorCode: null,
  },
  {
    rowOrder: 11,
    rowCode: 'UNEMP',
    displayName: 'Unemployment Rate',
    uiGroup: 'Jobs',
    treatment: 'BILATERAL',
    usIndicatorCode: 'US_UNEMP',
    eurIndicatorCode: 'EU_UNEMP',
    gbpIndicatorCode: 'UK_UNEMP',
    jpyIndicatorCode: 'JP_UNEMP',
  },
  {
    rowOrder: 12,
    rowCode: 'JOBLESS',
    displayName: 'Weekly Jobless Claims',
    uiGroup: 'Jobs',
    treatment: 'USD_ONLY',
    usIndicatorCode: 'US_JOBLESS_CLAIMS',
    eurIndicatorCode: null,
    gbpIndicatorCode: null,
    jpyIndicatorCode: null,
  },
  {
    rowOrder: 13,
    rowCode: 'JOLTS',
    displayName: 'JOLTS Openings',
    uiGroup: 'Jobs',
    treatment: 'USD_ONLY',
    usIndicatorCode: 'US_JOLTS',
    eurIndicatorCode: null,
    gbpIndicatorCode: null,
    jpyIndicatorCode: null,
  },
  {
    rowOrder: 14,
    rowCode: 'ADP',
    displayName: 'ADP Employment',
    uiGroup: 'Jobs',
    treatment: 'USD_ONLY',
    usIndicatorCode: 'US_ADP',
    eurIndicatorCode: null,
    gbpIndicatorCode: null,
    jpyIndicatorCode: null,
  },
  {
    rowOrder: 15,
    rowCode: 'RATES',
    displayName: 'Interest Rates',
    uiGroup: 'Rates',
    treatment: 'RATES_BILATERAL',
    usIndicatorCode: 'US_FED_RATE',
    eurIndicatorCode: 'EU_ECB_RATE',
    gbpIndicatorCode: 'UK_BOE_RATE',
    jpyIndicatorCode: 'JP_BOJ_RATE',
  },

  // ---------------------------------------------------------------
  // Phase 1 — four new single-side rows. All four legacy currency columns are
  // left NULL and isActive=false, so the legacy loader ignores them entirely
  // and existing pair scores do not move. The mapping that matters is in
  // PAIR_TEMPLATE_CURRENCIES below.
  // ---------------------------------------------------------------
  {
    rowOrder: 16,
    rowCode: 'AU_EMPL',
    displayName: 'AU Employment Change',
    uiGroup: 'Jobs',
    treatment: 'AUD_ONLY',
    usIndicatorCode: null,
    eurIndicatorCode: null,
    gbpIndicatorCode: null,
    jpyIndicatorCode: null,
  },
  {
    rowOrder: 17,
    rowCode: 'CN_CAIXIN',
    displayName: 'China Caixin Mfg PMI',
    uiGroup: 'Growth',
    treatment: 'AUD_ONLY',
    usIndicatorCode: null,
    eurIndicatorCode: null,
    gbpIndicatorCode: null,
    jpyIndicatorCode: null,
  },
  {
    rowOrder: 18,
    rowCode: 'CASH_EARNINGS',
    displayName: 'Labor Cash Earnings',
    uiGroup: 'Jobs',
    treatment: 'JPY_ONLY',
    usIndicatorCode: null,
    eurIndicatorCode: null,
    gbpIndicatorCode: null,
    jpyIndicatorCode: null,
  },
  {
    rowOrder: 19,
    rowCode: 'TOKYO_CPI',
    displayName: 'Tokyo Core CPI',
    uiGroup: 'Inflation',
    treatment: 'JPY_ONLY',
    usIndicatorCode: null,
    eurIndicatorCode: null,
    gbpIndicatorCode: null,
    jpyIndicatorCode: null,
  },
];

// =========================================================
// Phase 1 — normalised pair template (pair_template_row_currencies).
// Currency is a ROW here, not a column. This is the structure Phase 2 reads.
// The USD/EUR/GBP/JPY entries below are identical to the values already
// backfilled from the legacy columns by the Phase 1 migration; re-declaring
// them makes this seed the single resync point for the whole template.
// =========================================================
type PairTemplateCurrencySeed = {
  rowCode: string;
  currencies: Record<string, string>;
};

const PAIR_TEMPLATE_CURRENCIES: PairTemplateCurrencySeed[] = [
  {
    rowCode: 'GDP',
    currencies: {
      USD: 'US_GDP_QOQ',
      EUR: 'EU_GDP_QOQ',
      GBP: 'UK_GDP_MOM',
      JPY: 'JP_GDP_QOQ',
      AUD: 'AU_GDP_QOQ',
    },
  },
  {
    rowCode: 'MFG_PMI',
    currencies: {
      USD: 'US_ISM_MFG',
      EUR: 'EU_MFG_PMI',
      GBP: 'UK_MFG_PMI',
      JPY: 'JP_MFG_PMI',
      AUD: 'AU_PMI_MFG',
    },
  },
  {
    rowCode: 'SVC_PMI',
    currencies: {
      USD: 'US_ISM_SVC',
      EUR: 'EU_SVC_PMI',
      GBP: 'UK_SVC_PMI',
      JPY: 'JP_SVC_PMI',
      AUD: 'AU_PMI_SVC',
    },
  },
  {
    // Phase 7: AUD restored, now pointing at AU_MHSI_MOM (renamed from the
    // retired, never-populated AU_RETAIL_MOM — see AU_MHSI_MOM's definition
    // above). The row's own displayName stays "Retail Sales" — USD/EUR/GBP/JPY
    // still measure literal retail sales; only AUD's cell in this bilateral
    // row points at a different underlying measure, same as it always did
    // conceptually (one cell per currency, not a single shared series).
    rowCode: 'RETAIL',
    currencies: {
      USD: 'US_RETAIL_MOM',
      EUR: 'EU_RETAIL_MOM',
      GBP: 'UK_RETAIL_MOM',
      JPY: 'JP_RETAIL_YOY',
      AUD: 'AU_MHSI_MOM',
    },
  },
  {
    rowCode: 'CONSCONF',
    currencies: {
      USD: 'US_CB_CONSCONF',
      EUR: 'EU_CCI',
      GBP: 'UK_GFK',
      JPY: 'JP_CONSCONF',
      AUD: 'AU_CONSCONF',
    },
  },
  {
    rowCode: 'CPI',
    currencies: {
      USD: 'US_CPI_YOY',
      EUR: 'EU_CPI_YOY',
      GBP: 'UK_CPI_YOY',
      JPY: 'JP_CPI_YOY',
      AUD: 'AU_CPI_YOY',
    },
  },
  {
    // PPI is NORMAL for every currency including EUR. The EUR-inversion lives
    // only in dead, unreferenced static config — it is not reintroduced here.
    rowCode: 'PPI',
    currencies: {
      USD: 'US_PPI_MOM',
      EUR: 'EU_PPI_MOM',
      GBP: 'UK_PPI_MOM',
      JPY: 'JP_PPI_YOY',
      AUD: 'AU_PPI_YOY',
    },
  },
  { rowCode: 'PCE', currencies: { USD: 'US_PCE_YOY' } },
  { rowCode: 'HSHLD_SPEND', currencies: { JPY: 'JP_HSHLD_SPEND' } },
  { rowCode: 'NFP_EMPL', currencies: { USD: 'US_NFP' } },
  {
    rowCode: 'UNEMP',
    currencies: {
      USD: 'US_UNEMP',
      EUR: 'EU_UNEMP',
      GBP: 'UK_UNEMP',
      JPY: 'JP_UNEMP',
      AUD: 'AU_UNEMPLOYMENT',
    },
  },
  { rowCode: 'JOBLESS', currencies: { USD: 'US_JOBLESS_CLAIMS' } },
  { rowCode: 'JOLTS', currencies: { USD: 'US_JOLTS' } },
  { rowCode: 'ADP', currencies: { USD: 'US_ADP' } },
  {
    rowCode: 'RATES',
    currencies: {
      USD: 'US_FED_RATE',
      EUR: 'EU_ECB_RATE',
      GBP: 'UK_BOE_RATE',
      JPY: 'JP_BOJ_RATE',
      AUD: 'AU_RBA_RATE',
    },
  },

  // Single-side rows. AU Employment Change is deliberately NOT mapped to NFP,
  // and Labor Cash Earnings is deliberately NOT mapped to US Average Hourly
  // Earnings (AHE is not in the template and the template is not being reopened).
  { rowCode: 'AU_EMPL', currencies: { AUD: 'AU_EMPLOYMENT_CHANGE' } },
  { rowCode: 'CN_CAIXIN', currencies: { AUD: 'CN_CAIXIN_PMI_MFG' } },
  { rowCode: 'CASH_EARNINGS', currencies: { JPY: 'JP_CASH_EARNINGS_YOY' } },
  { rowCode: 'TOKYO_CPI', currencies: { JPY: 'JP_TOKYO_CPI_YOY' } },
];

const CYCLE_STANCES = [
  { currencyCode: 'USD', stance: 'NEUTRAL', notes: 'Fed data-dependent stance' },
  { currencyCode: 'EUR', stance: 'CUTTING', notes: 'ECB cutting cycle through 2025-2026' },
  { currencyCode: 'GBP', stance: 'CUTTING', notes: 'BoE cutting cycle' },
  { currencyCode: 'JPY', stance: 'HIKING', notes: 'BoJ in slow hiking cycle' },
  // Phase 1. NEUTRAL is a PLACEHOLDER — no stance value was supplied for AUD.
  // It must be set via the admin panel before AUD scores are trusted.
  { currencyCode: 'AUD', stance: 'NEUTRAL', notes: 'PLACEHOLDER — set the real RBA stance via the admin panel before trusting AUD scores' },
];

// =========================================================
// Phase 1 — asset_indicator_map seed.
//
// Currencies + Gold are derived from the same country mapping the live
// resolver uses, so these rows are identical to the migration backfill.
// Indices carry an EXPLICIT per-indicator polarity because their signs are
// mixed and cannot be derived from a single flag.
// =========================================================
type CountryDerivedAssetMap = {
  assetCode: string;
  fundamentalCountries: string[];
  cotCountry: string;
  fundamentalPolarity: 1 | -1;
};

const COUNTRY_DERIVED_ASSET_MAPS: CountryDerivedAssetMap[] = [
  { assetCode: 'USD', fundamentalCountries: ['US'], cotCountry: 'USD', fundamentalPolarity: 1 },
  { assetCode: 'EUR', fundamentalCountries: ['EU'], cotCountry: 'EUR', fundamentalPolarity: 1 },
  { assetCode: 'GBP', fundamentalCountries: ['UK'], cotCountry: 'GBP', fundamentalPolarity: 1 },
  { assetCode: 'JPY', fundamentalCountries: ['JP'], cotCountry: 'JPY', fundamentalPolarity: 1 },
  // AUD resolves across two countries: its own, plus CN as an industrial-demand proxy.
  { assetCode: 'AUD', fundamentalCountries: ['AU', 'CN'], cotCountry: 'AUD', fundamentalPolarity: 1 },
  // Gold: strict inverse of USD on every non-COT indicator. COT is never flipped.
  { assetCode: 'XAUUSD', fundamentalCountries: ['US'], cotCountry: 'XAU', fundamentalPolarity: -1 },
];

// Equity-index polarity. Composition is `ruleLayerScore * polarity`.
//
// The two labour rows look wrong and are correct — verify the COMPOSED result,
// not the polarity in isolation. Both indicators are `inverted` at the rule
// layer, where the handler scores a BELOW-forecast print as BEAT = +1:
//   US_UNEMP         BEAT (lower unemployment) -> +1 * -1 = -1  bearish equities
//                    (tight labour market -> wage pressure -> Fed hawkishness)
//   US_JOBLESS_CLAIMS BEAT (fewer claims)      -> +1 * +1 = +1  bullish equities
// They genuinely point opposite ways for stocks.
const INDEX_INDICATOR_POLARITY: Record<string, 1 | -1> = {
  US_GDP_QOQ: 1,
  US_ISM_MFG: 1,
  US_ISM_SVC: 1,
  US_RETAIL_MOM: 1,
  US_CB_CONSCONF: 1,
  US_CPI_YOY: -1,
  US_PPI_MOM: -1,
  US_PCE_YOY: -1,
  US_02Y_SMA: -1,
  US_NFP: 1,
  US_UNEMP: -1,
  US_JOBLESS_CLAIMS: 1,
  US_ADP: 1,
  US_JOLTS: 1,
  US_FED_RATE: -1,
};

// All three indices are identical — the same map is rendered for each.
const INDEX_ASSET_CODES = ['SPY', 'NAS100', 'US30'];

async function seedAssets(): Promise<void> {
  for (const a of ASSETS) {
    const payload = {
      code: a.code,
      name: a.name,
      assetClass: a.assetClass,
      toolScope: a.toolScope,
      isActive: a.isActive,
      metadata: a.metadata,
    };
    await prisma.asset.upsert({
      where: { code: a.code },
      create: payload,
      update: {
        name: payload.name,
        assetClass: payload.assetClass,
        toolScope: payload.toolScope,
        isActive: payload.isActive,
        metadata: payload.metadata,
      },
    });
  }
  console.log(`✅ Seeded ${ASSETS.length} EdgeFinder assets`);
}

async function seedIndicators(): Promise<void> {
  for (const ind of INDICATORS) {
    const payload = {
      code: ind.code,
      name: ind.name,
      category: ind.category,
      tool: ind.tool,
      frequency: ind.frequency,
      country: ind.country,
      uiGroup: ind.uiGroup,
      dataSource: ind.dataSource,
      sourceSeriesId: ind.sourceSeriesId,
      description: ind.description ?? null,
      isActive: ind.isActive ?? true,
    };
    await prisma.indicator.upsert({
      where: { code: ind.code },
      create: payload,
      update: {
        name: payload.name,
        category: payload.category,
        tool: payload.tool,
        frequency: payload.frequency,
        country: payload.country,
        uiGroup: payload.uiGroup,
        dataSource: payload.dataSource,
        sourceSeriesId: payload.sourceSeriesId,
        description: payload.description,
        isActive: payload.isActive,
      },
    });
  }
  console.log(`✅ Seeded ${INDICATORS.length} EdgeFinder indicators`);
}

async function seedScoringRules(): Promise<void> {
  const effectiveFrom = new Date('2026-01-01');
  let count = 0;
  for (const ind of INDICATORS) {
    const indicatorRow = await prisma.indicator.findUnique({ where: { code: ind.code } });
    if (!indicatorRow) throw new Error(`Indicator ${ind.code} missing after upsert`);
    const rule = ruleForIndicator(ind.code);
    await prisma.scoringRule.upsert({
      where: { indicatorId_version: { indicatorId: indicatorRow.id, version: 1 } },
      create: {
        indicatorId: indicatorRow.id,
        version: 1,
        ruleType: rule.ruleType,
        ruleDefinition: rule.ruleDefinition,
        effectiveFrom,
        effectiveTo: null,
      },
      update: {
        ruleType: rule.ruleType,
        ruleDefinition: rule.ruleDefinition,
        effectiveFrom,
        effectiveTo: null,
      },
    });
    count++;
  }
  console.log(`✅ Seeded ${count} EdgeFinder scoring rules v1`);
}

async function seedPairTemplateRows(): Promise<void> {
  for (const row of PAIR_TEMPLATE_ROWS) {
    const { isActive, ...cols } = row;
    const payload = { ...cols, isActive: isActive ?? true };
    await prisma.pairTemplateRow.upsert({
      where: { rowCode: row.rowCode },
      create: payload,
      update: payload,
    });
  }
  console.log(`✅ Seeded ${PAIR_TEMPLATE_ROWS.length} pair template rows`);
}

/**
 * Phase 1: normalised pair template. Currency is a row, not a column.
 * Idempotent AND genuinely resyncing — the update clause rewrites indicatorCode.
 */
async function seedPairTemplateRowCurrencies(): Promise<void> {
  let count = 0;
  let pruned = 0;
  for (const entry of PAIR_TEMPLATE_CURRENCIES) {
    const templateRow = await prisma.pairTemplateRow.findUnique({
      where: { rowCode: entry.rowCode },
    });
    if (!templateRow) throw new Error(`Pair template row ${entry.rowCode} missing after upsert`);

    for (const [currencyCode, indicatorCode] of Object.entries(entry.currencies)) {
      // Fail loudly rather than seeding a dangling indicator code.
      const indicator = await prisma.indicator.findUnique({ where: { code: indicatorCode } });
      if (!indicator) {
        throw new Error(
          `Pair template ${entry.rowCode}/${currencyCode} references unknown indicator ${indicatorCode}`,
        );
      }

      await prisma.pairTemplateRowCurrency.upsert({
        where: {
          templateRowId_currencyCode: { templateRowId: templateRow.id, currencyCode },
        },
        create: { templateRowId: templateRow.id, currencyCode, indicatorCode },
        update: { indicatorCode },
      });
      count++;
    }

    // Phase 6: prune cells that no longer appear in this row's seed map — the
    // mechanism a currency's retirement from a bilateral row relies on. The
    // upsert loop above only ever adds/updates entries present in
    // `entry.currencies`; it never deletes one that has been removed from the
    // map. Without this, the pair loader would keep reading
    // pair_template_row_currencies' stale entry regardless of the referenced
    // indicator's isActive flag (confirmed Phase 6 A3). Scoped to rows present
    // in PAIR_TEMPLATE_CURRENCIES only — never touches a row this seed
    // doesn't own. (Phase 7 restored RETAIL's AUD cell — see AU_MHSI_MOM —
    // which exercises the normal upsert/create path here, not this prune
    // path; the prune path remains live for any future retirement.)
    const currentCells = await prisma.pairTemplateRowCurrency.findMany({
      where: { templateRowId: templateRow.id },
      select: { id: true, currencyCode: true },
    });
    const wanted = new Set(Object.keys(entry.currencies));
    const stale = currentCells.filter((c) => !wanted.has(c.currencyCode));
    if (stale.length > 0) {
      await prisma.pairTemplateRowCurrency.deleteMany({
        where: { id: { in: stale.map((c) => c.id) } },
      });
      pruned += stale.length;
      console.log(
        `  pruned ${stale.length} stale currency cell(s) from ${entry.rowCode}: ${stale.map((c) => c.currencyCode).join(', ')}`,
      );
    }
  }
  console.log(`✅ Seeded ${count} pair template row currencies (normalised)${pruned > 0 ? `, pruned ${pruned} stale` : ''}`);
}

/**
 * Phase 1: asset -> indicator membership + polarity.
 * Purely additive: upserts the desired rows, never deletes.
 */
async function seedAssetIndicatorMap(): Promise<void> {
  let count = 0;

  const upsert = async (
    assetCode: string,
    indicatorId: string,
    polarity: 1 | -1,
    isCot: boolean,
  ): Promise<void> => {
    const asset = await prisma.asset.findUnique({ where: { code: assetCode } });
    if (!asset) throw new Error(`Asset ${assetCode} missing after upsert`);
    await prisma.assetIndicatorMap.upsert({
      where: { assetId_indicatorId: { assetId: asset.id, indicatorId } },
      create: { assetId: asset.id, indicatorId, polarity, isCot },
      update: { polarity, isCot },
    });
    count++;
  };

  // --- Currencies + Gold: derived from country, exactly as the live resolver does.
  for (const m of COUNTRY_DERIVED_ASSET_MAPS) {
    const indicators = await prisma.indicator.findMany({
      where: {
        tool: 'edgefinder',
        isActive: true,
        country: { in: [...m.fundamentalCountries, m.cotCountry] },
      },
    });
    for (const ind of indicators) {
      const isCot = ind.uiGroup === 'COT' || ind.country === m.cotCountry;
      // COT is never sign-flipped, not even for Gold.
      const polarity: 1 | -1 = isCot ? 1 : m.fundamentalPolarity;
      await upsert(m.assetCode, ind.id, polarity, isCot);
    }
  }

  // --- Indices: explicit mixed polarity, plus a COT row.
  // Phase 4: each index gets its own `${assetCode}_COT` indicator (SPY_COT,
  // NAS100_COT, US30_COT), mirroring how every other asset's COT row is
  // wired. COT is never sign-flipped, matching every other asset.
  for (const assetCode of INDEX_ASSET_CODES) {
    for (const [indicatorCode, polarity] of Object.entries(INDEX_INDICATOR_POLARITY)) {
      const ind = await prisma.indicator.findUnique({ where: { code: indicatorCode } });
      if (!ind) throw new Error(`Index polarity references unknown indicator ${indicatorCode}`);
      await upsert(assetCode, ind.id, polarity, false);
    }
    const cotCode = `${assetCode}_COT`;
    const cotInd = await prisma.indicator.findUnique({ where: { code: cotCode } });
    if (!cotInd) throw new Error(`Index COT indicator missing: ${cotCode}`);
    await upsert(assetCode, cotInd.id, 1, true);
  }

  console.log(`✅ Seeded ${count} asset-indicator map rows`);
}

async function seedScorecardRatingRule(): Promise<void> {
  const tool: ToolName = 'edgefinder';
  const rules = {
    thresholds: [
      { min: 4, max: null, label: 'Very Support' },
      { min: 3, max: 3, label: 'Support' },
      { min: -2, max: 2, label: 'Neutral' },
      { min: -3, max: -3, label: 'Weak' },
      { min: null, max: -4, label: 'Very Weak' },
    ],
    trade_signal_threshold: 3,
    notes: 'Lucid Master Spec v1 Section 2.5 and 9.2',
  };
  await prisma.scorecardRatingRule.upsert({
    where: { tool_version: { tool, version: 1 } },
    create: {
      tool,
      version: 1,
      rules,
      effectiveFrom: new Date('2026-01-01'),
      effectiveTo: null,
    },
    update: {
      rules,
      effectiveFrom: new Date('2026-01-01'),
      effectiveTo: null,
    },
  });
  console.log('✅ Seeded EdgeFinder scorecard rating rules v1');
}

/**
 * Currency cycle stances are OPERATIONAL state, not reference data: they are
 * effective-dated and edited through the admin panel (PUT
 * /api/admin/cycle-stances/:currencyCode), which closes the open row by setting
 * effectiveTo and inserting a successor.
 *
 * Phase 1 changed this from upsert to CREATE-ONLY. The previous `update` clause
 * rewrote `stance` and forced `effectiveTo: null` on the 2026-01-01 row, so
 * re-running the seed against a live database silently reopened superseded rows
 * and left two open-ended (effectiveTo IS NULL) rows for the same currency —
 * corrupting the stance history the cpi_rate_cycle handler resolves against.
 * Seeding must never clobber an operator's declared cycle.
 */
async function seedCurrencyCycleStances(): Promise<void> {
  const effectiveFrom = new Date('2026-01-01');
  let created = 0;
  let preserved = 0;

  for (const s of CYCLE_STANCES) {
    const existing = await prisma.currencyCycleStance.findUnique({
      where: { currencyCode_effectiveFrom: { currencyCode: s.currencyCode, effectiveFrom } },
    });

    if (existing) {
      preserved++;
      continue;
    }

    await prisma.currencyCycleStance.create({
      data: {
        currencyCode: s.currencyCode,
        stance: s.stance,
        effectiveFrom,
        effectiveTo: null,
        notes: s.notes,
      },
    });
    created++;
  }

  console.log(
    `✅ Currency cycle stances: ${created} created, ${preserved} preserved (existing rows never overwritten)`,
  );
}

async function main(): Promise<void> {
  console.log('🌱 Starting EdgeFinder seed...');
  await seedAssets();
  await seedIndicators();
  await seedScoringRules();
  await seedPairTemplateRows();
  await seedPairTemplateRowCurrencies();
  await seedAssetIndicatorMap();
  await seedScorecardRatingRule();
  await seedCurrencyCycleStances();
  console.log('✅ EdgeFinder seed complete');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
