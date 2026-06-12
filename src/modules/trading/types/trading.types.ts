import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// Allowed literal values. These mirror the frontend's string unions exactly so
// the API contract needs no translation layer. They are enforced with Zod at
// the route boundary and stored verbatim in VarChar columns.
// ─────────────────────────────────────────────────────────────────────────────

export const ACCOUNT_TYPES = ['personal', 'demo', 'prop_firm'] as const;
export const ACCOUNT_STATUSES = ['Active', 'Passed', 'Blown', 'Closed'] as const;
export const ACCOUNT_STAGES = ['Stage 1', 'Stage 2', 'Funded', 'Blown'] as const;
export const DIRECTIONS = ['Buy', 'Sell'] as const;
export const CONVICTIONS = ['Low', 'Medium', 'High'] as const;
export const EXIT_TYPES = ['TP', 'SL', 'Manual', 'Partial+TP', 'Partial+SL', 'BE'] as const;
export const CASH_FLOW_TYPES = ['deposit', 'withdrawal', 'payout'] as const;
export const PLANNED_STATUSES = ['Watching', 'Ready', 'Invalidated', 'Cancelled'] as const;
export const ENTITY_STATUSES = ['Active', 'Inactive'] as const;

const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD');

// Accepts ISO datetime (with or without timezone) or a plain YYYY-MM-DD.
const dateTimeLike = z
  .string()
  .min(1)
  .refine((s) => !Number.isNaN(new Date(s).getTime()), 'Invalid date');

// ─── Accounts ────────────────────────────────────────────────────────────────

export const createAccountSchema = z
  .object({
    account_type: z.enum(ACCOUNT_TYPES),
    account_name: z.string().trim().min(1).max(120),
    account_size: z.number().finite().nonnegative(),
    current_balance: z.number().finite().optional(),
    currency: z.string().trim().min(1).max(8).default('USD'),
    status: z.enum(ACCOUNT_STATUSES).default('Active'),
    starting_date: dateOnly,
    broker: z.string().trim().max(120).optional().nullable(),
    profit_goal_pct: z.number().finite().nonnegative().optional().nullable(),
    prop_firm: z.string().trim().max(120).optional().nullable(),
    stage: z.enum(ACCOUNT_STAGES).optional().nullable(),
    max_drawdown_pct: z.number().finite().nonnegative().optional().nullable(),
    profit_target_pct: z.number().finite().nonnegative().optional().nullable(),
  })
  .refine((d) => d.account_type !== 'prop_firm' || (d.prop_firm && d.prop_firm.trim().length > 0), {
    message: 'prop_firm is required for prop_firm accounts',
    path: ['prop_firm'],
  });

export const updateAccountSchema = z.object({
  account_type: z.enum(ACCOUNT_TYPES).optional(),
  account_name: z.string().trim().min(1).max(120).optional(),
  account_size: z.number().finite().nonnegative().optional(),
  current_balance: z.number().finite().optional(),
  currency: z.string().trim().min(1).max(8).optional(),
  status: z.enum(ACCOUNT_STATUSES).optional(),
  starting_date: dateOnly.optional(),
  broker: z.string().trim().max(120).optional().nullable(),
  profit_goal_pct: z.number().finite().nonnegative().optional().nullable(),
  prop_firm: z.string().trim().max(120).optional().nullable(),
  stage: z.enum(ACCOUNT_STAGES).optional().nullable(),
  max_drawdown_pct: z.number().finite().nonnegative().optional().nullable(),
  profit_target_pct: z.number().finite().nonnegative().optional().nullable(),
});

export const cashFlowSchema = z.object({
  type: z.enum(CASH_FLOW_TYPES),
  amount: z.number().finite().positive(),
  date: dateOnly,
  note: z.string().trim().max(1000).optional().nullable(),
});

// ─── Trades ──────────────────────────────────────────────────────────────────

export const createTradeSchema = z
  .object({
    account_id: z.string().min(1),
    model: z.string().trim().min(1).max(60),
    pair: z.string().trim().min(1).max(20),
    direction: z.enum(DIRECTIONS),
    entry_price: z.number().finite(),
    sl_price: z.number().finite(),
    first_tp_price: z.number().finite().optional().nullable(),
    main_tp_price: z.number().finite(),
    lot_size: z.number().finite().positive(),
    risk_pct: z.number().finite().nonnegative(),
    conviction: z.enum(CONVICTIONS),
    fundamental_score: z.number().int().min(1).max(10).optional().nullable(),
    psychology: z.string().trim().max(120).optional().nullable(),
    notes: z.string().trim().max(5000).optional().nullable(),
    screenshots: z.array(z.string()).max(20).optional(),
    date_opened: dateTimeLike.optional(),
    // Closing fields
    is_closed: z.boolean().default(false),
    partial_exit_price: z.number().finite().optional().nullable(),
    partial_exit_lot_pct: z.number().finite().min(0).max(100).optional().nullable(),
    main_exit_price: z.number().finite().optional().nullable(),
    date_closed: dateTimeLike.optional().nullable(),
    exit_type: z.enum(EXIT_TYPES).default('TP'),
  })
  .refine((d) => !d.is_closed || d.main_exit_price != null, {
    message: 'main_exit_price is required when a trade is closed',
    path: ['main_exit_price'],
  });

export const updateTradeSchema = z.object({
  account_id: z.string().min(1).optional(),
  model: z.string().trim().min(1).max(60).optional(),
  pair: z.string().trim().min(1).max(20).optional(),
  direction: z.enum(DIRECTIONS).optional(),
  entry_price: z.number().finite().optional(),
  sl_price: z.number().finite().optional(),
  first_tp_price: z.number().finite().optional().nullable(),
  main_tp_price: z.number().finite().optional(),
  lot_size: z.number().finite().positive().optional(),
  risk_pct: z.number().finite().nonnegative().optional(),
  conviction: z.enum(CONVICTIONS).optional(),
  fundamental_score: z.number().int().min(1).max(10).optional().nullable(),
  psychology: z.string().trim().max(120).optional().nullable(),
  notes: z.string().trim().max(5000).optional().nullable(),
  screenshots: z.array(z.string()).max(20).optional(),
  date_opened: dateTimeLike.optional(),
  is_closed: z.boolean().optional(),
  partial_exit_price: z.number().finite().optional().nullable(),
  partial_exit_lot_pct: z.number().finite().min(0).max(100).optional().nullable(),
  main_exit_price: z.number().finite().optional().nullable(),
  date_closed: dateTimeLike.optional().nullable(),
  exit_type: z.enum(EXIT_TYPES).optional(),
});

// ─── Planned trades ──────────────────────────────────────────────────────────

export const createPlannedSchema = z.object({
  pair: z.string().trim().min(1).max(20),
  model: z.string().trim().min(1).max(60),
  direction: z.enum(DIRECTIONS),
  planned_entry: z.number().finite(),
  planned_sl: z.number().finite(),
  planned_first_tp: z.number().finite().optional().nullable(),
  planned_main_tp: z.number().finite(),
  planned_risk_pct: z.number().finite().nonnegative().default(1),
  conviction: z.enum(CONVICTIONS).default('Medium'),
  status: z.enum(PLANNED_STATUSES).default('Watching'),
  notes: z.string().trim().max(5000).optional().nullable(),
  screenshots: z.array(z.string()).max(20).optional(),
  current_market_price: z.number().finite().optional(),
  date_added: dateTimeLike.optional(),
});

export const updatePlannedSchema = z.object({
  pair: z.string().trim().min(1).max(20).optional(),
  model: z.string().trim().min(1).max(60).optional(),
  direction: z.enum(DIRECTIONS).optional(),
  planned_entry: z.number().finite().optional(),
  planned_sl: z.number().finite().optional(),
  planned_first_tp: z.number().finite().optional().nullable(),
  planned_main_tp: z.number().finite().optional(),
  planned_risk_pct: z.number().finite().nonnegative().optional(),
  conviction: z.enum(CONVICTIONS).optional(),
  status: z.enum(PLANNED_STATUSES).optional(),
  notes: z.string().trim().max(5000).optional().nullable(),
  screenshots: z.array(z.string()).max(20).optional(),
  current_market_price: z.number().finite().optional(),
  date_added: dateTimeLike.optional(),
});

// ─── Models ──────────────────────────────────────────────────────────────────

export const createModelSchema = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(200).default(''),
  rules: z.string().trim().max(10000).default(''),
  status: z.enum(ENTITY_STATUSES).default('Active'),
});

export const updateModelSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  description: z.string().trim().max(200).optional(),
  rules: z.string().trim().max(10000).optional(),
  status: z.enum(ENTITY_STATUSES).optional(),
});

// ─── Pairs ───────────────────────────────────────────────────────────────────

export const createPairSchema = z.object({
  symbol: z.string().trim().min(1).max(20),
  display_name: z.string().trim().min(1).max(40),
  flag_a: z.string().trim().max(16).default(''),
  flag_b: z.string().trim().max(16).default(''),
  pip_value: z.number().finite().positive(),
  status: z.enum(ENTITY_STATUSES).default('Active'),
});

export const updatePairSchema = z.object({
  symbol: z.string().trim().min(1).max(20).optional(),
  display_name: z.string().trim().min(1).max(40).optional(),
  flag_a: z.string().trim().max(16).optional(),
  flag_b: z.string().trim().max(16).optional(),
  pip_value: z.number().finite().positive().optional(),
  status: z.enum(ENTITY_STATUSES).optional(),
});

export type CreateAccountInput = z.infer<typeof createAccountSchema>;
export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;
export type CashFlowInput = z.infer<typeof cashFlowSchema>;
export type CreateTradeInput = z.infer<typeof createTradeSchema>;
export type UpdateTradeInput = z.infer<typeof updateTradeSchema>;
export type CreatePlannedInput = z.infer<typeof createPlannedSchema>;
export type UpdatePlannedInput = z.infer<typeof updatePlannedSchema>;
export type CreateModelInput = z.infer<typeof createModelSchema>;
export type UpdateModelInput = z.infer<typeof updateModelSchema>;
export type CreatePairInput = z.infer<typeof createPairSchema>;
export type UpdatePairInput = z.infer<typeof updatePairSchema>;
