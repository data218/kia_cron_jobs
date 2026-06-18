import { withPostgresClient } from '../src/supabase/postgres.js';

await withPostgresClient(async client => {
  for (const table of ['hyundai_warranty_claim_list', 'hyundai_warranty_claim_ytp']) {
    console.log(`\n=== ${table} (MIS5216) ===`);
    const dateColumn = table === 'hyundai_warranty_claim_list' ? 'claim_date' : null;
    const byDealer = await client.query(
      `
        select upper(trim(source_dealer_code::text)) as dealer,
               count(*)::int as cnt
               ${dateColumn ? `, min(${dateColumn})::text as min_date, max(${dateColumn})::text as max_date` : ''}
        from public.${table}
        where lower(trim(source_login_id::text)) = 'mis5216'
        group by 1
        order by 1
      `
    );
    console.log(byDealer.rows.length ? byDealer.rows : 'NO ROWS');

    if (dateColumn) {
      const mayJune = await client.query(
        `
          select upper(trim(source_dealer_code::text)) as dealer,
                 count(*)::int as cnt
          from public.${table}
          where lower(trim(source_login_id::text)) = 'mis5216'
            and ${dateColumn} >= '2026-05-01'
            and ${dateColumn} <= current_date
          group by 1
          order by 1
        `
      );
      console.log('May 2026 - today:', mayJune.rows.length ? mayJune.rows : 'NO ROWS');
    }
  }

  console.log('\n=== All logins summary (claim_list) ===');
  const all = await client.query(`
    select lower(trim(source_login_id::text)) as login, count(*)::int as cnt
    from public.hyundai_warranty_claim_list
    group by 1 order by 2 desc
  `);
  console.log(all.rows);
});
