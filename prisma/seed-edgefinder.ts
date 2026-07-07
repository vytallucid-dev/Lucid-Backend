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
    },
  },
  {
    code: 'EURUSD',
    name: 'EUR/USD',
    assetClass: 'forex_pair',
    toolScope: ['edgefinder'],
    isActive: true,
    metadata: { base: 'EUR', quote: 'USD', row_count: 14 },
  },
  {
    code: 'GBPUSD',
    name: 'GBP/USD',
    assetClass: 'forex_pair',
    toolScope: ['edgefinder'],
    isActive: true,
    metadata: { base: 'GBP', quote: 'USD', row_count: 14 },
  },
  {
    code: 'USDJPY',
    name: 'USD/JPY',
    assetClass: 'forex_pair',
    toolScope: ['edgefinder'],
    isActive: true,
    metadata: { base: 'USD', quote: 'JPY', row_count: 15 },
  },
  {
    code: 'EURJPY',
    name: 'EUR/JPY',
    assetClass: 'forex_pair',
    toolScope: ['edgefinder'],
    isActive: true,
    metadata: { base: 'EUR', quote: 'JPY', row_count: 15 },
  },
  {
    code: 'GBPJPY',
    name: 'GBP/JPY',
    assetClass: 'forex_pair',
    toolScope: ['edgefinder'],
    isActive: true,
    metadata: { base: 'GBP', quote: 'JPY', row_count: 15 },
  },
  {
    code: 'SPY',
    name: 'S&P 500 ETF',
    assetClass: 'index',
    toolScope: ['edgefinder'],
    isActive: false,
    metadata: { rate_row_source: 'FED_ONLY', deferred: true },
  },
  {
    code: 'NAS100',
    name: 'NASDAQ 100',
    assetClass: 'index',
    toolScope: ['edgefinder'],
    isActive: false,
    metadata: { rate_row_source: 'FED_ONLY', deferred: true },
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
  ]);
  const cpiRateCycle: Record<string, string> = {
    US_CPI_YOY: 'USD',
    EU_CPI_YOY: 'EUR',
    UK_CPI_YOY: 'GBP',
    JP_CPI_YOY: 'JPY',
  };
  const rateDecisionCodes = new Set(['US_FED_RATE', 'EU_ECB_RATE', 'UK_BOE_RATE', 'JP_BOJ_RATE']);
  const cotAssetByIndicator: Record<string, string> = {
    USD_COT: 'USD',
    EUR_COT: 'EUR',
    GBP_COT: 'GBP',
    JPY_COT: 'JPY',
    XAUUSD_COT: 'XAUUSD',
  };

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
];

const CYCLE_STANCES = [
  { currencyCode: 'USD', stance: 'NEUTRAL', notes: 'Fed data-dependent stance' },
  { currencyCode: 'EUR', stance: 'CUTTING', notes: 'ECB cutting cycle through 2025-2026' },
  { currencyCode: 'GBP', stance: 'CUTTING', notes: 'BoE cutting cycle' },
  { currencyCode: 'JPY', stance: 'HIKING', notes: 'BoJ in slow hiking cycle' },
];

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
    await prisma.pairTemplateRow.upsert({
      where: { rowCode: row.rowCode },
      create: { ...row, isActive: true },
      update: { ...row, isActive: true },
    });
  }
  console.log(`✅ Seeded ${PAIR_TEMPLATE_ROWS.length} pair template rows`);
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

async function seedCurrencyCycleStances(): Promise<void> {
  const effectiveFrom = new Date('2026-01-01');
  for (const s of CYCLE_STANCES) {
    await prisma.currencyCycleStance.upsert({
      where: { currencyCode_effectiveFrom: { currencyCode: s.currencyCode, effectiveFrom } },
      create: {
        currencyCode: s.currencyCode,
        stance: s.stance,
        effectiveFrom,
        effectiveTo: null,
        notes: s.notes,
      },
      update: {
        stance: s.stance,
        effectiveTo: null,
        notes: s.notes,
      },
    });
  }
  console.log(`✅ Seeded ${CYCLE_STANCES.length} currency cycle stances`);
}

async function main(): Promise<void> {
  console.log('🌱 Starting EdgeFinder seed...');
  await seedAssets();
  await seedIndicators();
  await seedScoringRules();
  await seedPairTemplateRows();
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
