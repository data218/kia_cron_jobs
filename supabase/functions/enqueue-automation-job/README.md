# Enqueue Automation Job

Deploy with JWT verification disabled because the function uses a dedicated
`x-automation-secret` shared only with Supabase Vault:

```powershell
supabase functions deploy enqueue-automation-job --no-verify-jwt
supabase secrets set AUTOMATION_ENQUEUE_SECRET="<strong-random-value>"
```

Create matching Vault values before applying the schedule migration:

```sql
select vault.create_secret('https://PROJECT.supabase.co', 'automation_project_url');
select vault.create_secret('same-strong-random-value', 'automation_enqueue_secret');
```
