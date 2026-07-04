import { createClient } from '@supabase/supabase-js';
const s = createClient('https://crreoeautoqzcgtlwlsd.supabase.co', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNycmVvZWF1dG9xemNndGx3bHNkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODQ3NTU5MCwiZXhwIjoyMDk0MDUxNTkwfQ.stoFjzeIPLiE10GxLcC74ykxuuLPjc3TvriSvBsgio0', {auth:{persistSession:false}});

async function createTable() {
  const sql = `CREATE TABLE IF NOT EXISTS admin_users (
    id BIGSERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'admin',
    full_name TEXT,
    email TEXT,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    last_login TIMESTAMPTZ
  ); CREATE INDEX IF NOT EXISTS idx_admin_users_username ON admin_users(username);`;
  
  // Use the Supabase REST API to execute raw SQL
  const response = await fetch('https://crreoeautoqzcgtlwlsd.supabase.co/rest/v1/rpc/exec_sql', {
    method: 'POST',
    headers: {
      'apikey': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNycmVvZWF1dG9xemNndGx3bHNkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODQ3NTU5MCwiZXhwIjoyMDk0MDUxNTkwfQ.stoFjzeIPLiE10GxLcC74ykxuuLPjc3TvriSvBsgio0',
      'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNycmVvZWF1dG9xemNndGx3bHNkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODQ3NTU5MCwiZXhwIjoyMDk0MDUxNTkwfQ.stoFjzeIPLiE10GxLcC74ykxuuLPjc3TvriSvBsgio0',
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify({ sql })
  });
  
  const result = await response.text();
  console.log('Status:', response.status);
  console.log('Result:', result);
}

createTable().catch(console.error);