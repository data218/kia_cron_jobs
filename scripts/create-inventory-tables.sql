-- ============================================================
-- INVENTORY TABLES FOR AM-Dashboard-New
-- Project: crreoeautoqzcgtlwlsd
-- Run this in Supabase SQL Editor
-- ============================================================

-- 1. ITEMS MASTER LIST
CREATE TABLE IF NOT EXISTS public.items_rows (
  id            BIGSERIAL PRIMARY KEY,
  item_code     TEXT NOT NULL,
  item_name     TEXT NOT NULL,
  category      TEXT,
  unit          TEXT DEFAULT 'PCS',
  opening_stock NUMERIC DEFAULT 0,
  min_stock     NUMERIC DEFAULT 0,
  max_stock     NUMERIC DEFAULT 0,
  is_active     BOOLEAN DEFAULT true,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_items_rows_code ON public.items_rows(item_code);

-- 2. SIX-MONTH CONSUMPTION DATA
CREATE TABLE IF NOT EXISTS public.consumption_rows (
  id                 BIGSERIAL PRIMARY KEY,
  item_code          TEXT NOT NULL,
  item_name          TEXT,
  unit               TEXT DEFAULT 'PCS',
  month_1_qty        NUMERIC DEFAULT 0,
  month_2_qty        NUMERIC DEFAULT 0,
  month_3_qty        NUMERIC DEFAULT 0,
  month_4_qty        NUMERIC DEFAULT 0,
  month_5_qty        NUMERIC DEFAULT 0,
  month_6_qty        NUMERIC DEFAULT 0,
  total_consumption  NUMERIC GENERATED ALWAYS AS (month_1_qty + month_2_qty + month_3_qty + month_4_qty + month_5_qty + month_6_qty) STORED,
  period_label       TEXT NOT NULL,
  uploaded_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_consumption_rows_code ON public.consumption_rows(item_code);
CREATE INDEX IF NOT EXISTS idx_consumption_rows_period ON public.consumption_rows(period_label);

-- 3. IN/OUT TRANSACTIONS
CREATE TABLE IF NOT EXISTS public.transaction_rows (
  id                BIGSERIAL PRIMARY KEY,
  item_code         TEXT NOT NULL,
  item_name         TEXT,
  transaction_type  TEXT NOT NULL CHECK (transaction_type IN ('IN', 'OUT')),
  quantity          NUMERIC NOT NULL DEFAULT 0,
  transaction_date  DATE DEFAULT CURRENT_DATE,
  reference_no      TEXT,
  unit              TEXT DEFAULT 'PCS',
  remarks           TEXT,
  created_by        TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transaction_rows_code ON public.transaction_rows(item_code);
CREATE INDEX IF NOT EXISTS idx_transaction_rows_type ON public.transaction_rows(transaction_type);
CREATE INDEX IF NOT EXISTS idx_transaction_rows_date ON public.transaction_rows(transaction_date);

-- Row-level security (optional, enable if needed)
ALTER TABLE public.items_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.consumption_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transaction_rows ENABLE ROW LEVEL SECURITY;

GRANT ALL ON public.items_rows TO authenticated, service_role;
GRANT ALL ON public.consumption_rows TO authenticated, service_role;
GRANT ALL ON public.transaction_rows TO authenticated, service_role;
