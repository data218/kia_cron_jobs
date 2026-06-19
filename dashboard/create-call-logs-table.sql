CREATE TABLE IF NOT EXISTS call_logs (
  id BIGSERIAL PRIMARY KEY,
  policyno TEXT,
  vinno TEXT,
  customer_name TEXT,
  model TEXT,
  insurancecompany TEXT,
  grosspremium NUMERIC,
  policy_expiry_date TEXT,
  mobile_no TEXT,
  call_date TIMESTAMPTZ DEFAULT NOW(),
  call_outcome TEXT NOT NULL,
  remarks TEXT,
  follow_up_date DATE,
  agent_name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
