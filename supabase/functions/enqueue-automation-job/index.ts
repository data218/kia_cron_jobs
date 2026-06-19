import { createClient } from 'npm:@supabase/supabase-js@2';

const allowedServices = new Set(['kia', 'platinum', 'hmil']);

function istDate(value: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(value);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

Deno.serve(async request => {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const expectedSecret = Deno.env.get('AUTOMATION_ENQUEUE_SECRET');
  if (!expectedSecret ||
      request.headers.get('x-automation-secret') !== expectedSecret) {
    return new Response('Unauthorized', { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const service = String(body.service || '').toLowerCase();
  if (!allowedServices.has(service)) {
    return Response.json({ error: 'Invalid service' }, { status: 400 });
  }

  const scheduledFor = body.scheduled_for
    ? new Date(body.scheduled_for)
    : new Date();
  if (Number.isNaN(scheduledFor.getTime())) {
    return Response.json({ error: 'Invalid scheduled_for' }, { status: 400 });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } }
  );

  const { data: state, error: stateError } = await supabase
    .from('automation_service_state')
    .select('enabled')
    .eq('service', service)
    .maybeSingle();
  if (stateError) {
    return Response.json({ error: stateError.message }, { status: 500 });
  }
  if (!state?.enabled) {
    return Response.json({ ok: true, service, skipped: 'disabled' });
  }

  const idempotencyKey =
    `${service}:${istDate(scheduledFor)}:${body.mode || 'daily'}`;
  const { data, error } = await supabase.rpc('enqueue_automation_job', {
    p_service: service,
    p_mode: body.mode || 'daily',
    p_scheduled_for: scheduledFor.toISOString(),
    p_source: 'edge',
    p_idempotency_key: idempotencyKey
  });

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
  return Response.json({ ok: true, job: data });
});
