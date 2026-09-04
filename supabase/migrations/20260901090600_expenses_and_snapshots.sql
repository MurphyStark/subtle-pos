-- Expenses and periodic profit snapshots. Both are soft-delete only -- the audit trail
-- (PRD section 20) has to actually be true, so nothing here is ever hard-deleted.

create table expenses (
  id uuid primary key default gen_random_uuid(),
  category expense_category not null,
  location_id uuid references locations (id),
  description text,
  amount_cents bigint not null check (amount_cents > 0),
  currency text not null,
  exchange_rate_at_expense numeric(18, 8) not null default 1,
  expense_date date not null,
  -- Stock purchases are recorded via stock_receipts, which already flow into COGS through
  -- product_cost_history / average_unit_cost_cents. A 'stock_purchase' expense row exists
  -- only for cash-flow visibility (what went out the door) and MUST be excluded from
  -- operating-expense totals in the profitability reports -- enforce that exclusion in the
  -- reporting queries; the database can't fully guard against double-counting on its own.
  stock_receipt_id uuid references stock_receipts (id),
  created_by uuid references user_profiles (id),
  voided_at timestamptz,
  created_at timestamptz not null default now()
);

create trigger expenses_no_hard_delete
  before delete on expenses
  for each row execute function reject_mutation();

create table profit_snapshots (
  id uuid primary key default gen_random_uuid(),
  location_id uuid references locations (id), -- null = combined view across all locations
  period_start date not null,
  period_end date not null,
  gross_sales_cents bigint not null,
  discounts_cents bigint not null,
  returns_cents bigint not null,
  net_sales_cents bigint not null,
  cost_of_goods_sold_cents bigint not null,
  gross_profit_cents bigint not null,
  operating_expenses_cents bigint not null,
  -- Explicitly "Estimated": no depreciation, accruals, or tax adjustments (build prompt /
  -- PRD section 1.7). Label this in the UI too, don't rely on the column name alone.
  estimated_net_profit_cents bigint not null,
  currency text not null default 'USD',
  generated_at timestamptz not null default now(),
  voided_at timestamptz,
  created_at timestamptz not null default now()
);

create trigger profit_snapshots_no_hard_delete
  before delete on profit_snapshots
  for each row execute function reject_mutation();
