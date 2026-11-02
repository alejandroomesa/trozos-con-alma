import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

export const prerender = false;

type AnalyticsEvent = {
  eventType?: 'page_view' | 'whatsapp_click';
  path?: string;
};

export const POST: APIRoute = async ({ request }) => {
  const origin = request.headers.get('Origin');
  if (!origin || origin !== new URL(request.url).origin) {
    return Response.json({ error: 'Origen no permitido.' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }

  let event: AnalyticsEvent;
  try {
    event = await request.json() as AnalyticsEvent;
  } catch {
    return Response.json({ error: 'Evento no válido.' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }

  const eventType = event.eventType;
  if (eventType !== 'page_view' && eventType !== 'whatsapp_click') {
    return Response.json({ error: 'Tipo de evento no válido.' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }
  if (eventType === 'page_view') {
    if (typeof event.path !== 'string' || !event.path.startsWith('/') || event.path.startsWith('/admin') || event.path.startsWith('/api/')) {
      return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
    }
  }

  const bindings = env as Env;
  const eventDate = new Date().toISOString().slice(0, 10);
  await bindings.DB.prepare(
    `INSERT INTO analytics_daily (event_date, event_type, event_count)
     VALUES (?, ?, 1)
     ON CONFLICT(event_date, event_type) DO UPDATE SET event_count = event_count + 1`
  ).bind(eventDate, eventType).run();

  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
};
