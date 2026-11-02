import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { colecciones as coleccionesDemo } from '../../../data/colecciones';
import { productosDemo } from '../../../data/productos-demo';

export const prerender = false;

type ContentType = 'product' | 'collection';
type Payload = {
  type?: ContentType;
  name?: string;
  summary?: string;
  status?: 'draft' | 'published';
  tagline?: string;
  introduction?: string;
  ideas?: string[];
  closing?: string;
  collection?: string;
  productType?: string;
  description?: string;
  price?: number | null;
  format?: string;
  pages?: number | null;
  coverText?: string;
  options?: string[];
  featured?: boolean;
  id?: number;
  imageKey?: string | null;
};

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function authorized(request: Request, env: Env) {
  const teamDomain = env.ACCESS_TEAM_DOMAIN?.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const audience = env.ACCESS_AUD;
  const assertion = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!teamDomain || !audience || !assertion) return false;

  try {
    let jwks = jwksCache.get(teamDomain);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
      jwksCache.set(teamDomain, jwks);
    }
    await jwtVerify(assertion, jwks, { issuer: `https://${teamDomain}`, audience });
    return true;
  } catch {
    return false;
  }
}

function slugify(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/g, '') || 'contenido';
}

function validate(payload: Payload): string | null {
  if (!['product', 'collection'].includes(payload.type ?? '')) return 'Tipo de contenido no válido.';
  if (!payload.name?.trim() || payload.name.trim().length > 90) return 'El nombre es obligatorio y no puede superar 90 caracteres.';
  if (!payload.summary?.trim() || payload.summary.trim().length > 180) return 'La descripción breve es obligatoria (máximo 180 caracteres).';
  if (!['draft', 'published'].includes(payload.status ?? '')) return 'Estado de publicación no válido.';
  if (payload.type === 'product' && (!payload.productType?.trim() || !payload.collection?.trim())) return 'Selecciona una colección y un tipo de producto.';
  if (payload.price != null && (!Number.isFinite(payload.price) || payload.price < 0)) return 'El precio debe ser un número positivo.';
  if (payload.pages != null && (!Number.isInteger(payload.pages) || payload.pages < 1)) return 'El número de páginas debe ser un entero positivo.';
  return null;
}

export const GET: APIRoute = async ({ request, locals }) => {
  const bindings = env as Env;
  if (!(await authorized(request, bindings))) return json({ error: 'Acceso no autorizado. Configura Cloudflare Access para el panel.' }, 401);
  const rows = await bindings.DB.prepare(
    `SELECT c.id, c.slug, c.content_type AS type, c.title AS name, c.summary, c.status, c.image_key AS imageKey,
      c.created_at AS createdAt, p.product_type AS productType, p.price_cents AS priceCents,
      p.featured, p.description, p.book_format AS format, p.page_count AS pages,
      p.cover_text AS coverText, p.options_json AS optionsJson, co.slug AS collectionSlug,
      co.title AS collectionName, col.tagline, col.introduction, col.ideas_json AS ideasJson, col.closing
     FROM content c LEFT JOIN products p ON p.content_id = c.id
     LEFT JOIN content co ON co.id = p.collection_id
     LEFT JOIN collections col ON col.content_id = c.id
     WHERE c.content_type IN ('product', 'collection') ORDER BY c.created_at DESC`
  ).all();
  const dbCollections = await bindings.DB.prepare(
    `SELECT c.slug, c.title AS name FROM content c WHERE c.content_type = 'collection' ORDER BY c.title`
  ).all();
  const analytics = await bindings.DB.prepare(
    `SELECT event_date AS date, event_type AS type, event_count AS count
     FROM analytics_daily
     WHERE event_date >= date('now', 'start of month')
     ORDER BY event_date`
  ).all();
  return json({ items: rows.results, collections: dbCollections.results, analytics: analytics.results });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const bindings = env as Env;
  if (!(await authorized(request, bindings))) return json({ error: 'Acceso no autorizado. Configura Cloudflare Access para el panel.' }, 401);
  let payload: Payload;
  try { payload = await request.json() as Payload; }
  catch { return json({ error: 'El contenido de la petición no es válido.' }, 400); }
  const error = validate(payload);
  if (error) return json({ error }, 400);

  const type = payload.type!;
  const name = payload.name!.trim();
  const base = slugify(name);
  const reserved = new Set([
    ...coleccionesDemo.map((item) => item.slug.toLowerCase()),
    ...productosDemo.map((item) => item.slug.toLowerCase()),
  ]);

  for (let suffix = 1; suffix <= 100; suffix++) {
    const slug = suffix === 1 ? base : `${base}-${suffix}`;
    if (reserved.has(slug)) continue;
    const nowPublished = payload.status === 'published' ? new Date().toISOString() : null;
    const inserted = await bindings.DB.prepare(
      `INSERT INTO content (slug, content_type, title, summary, status, published_at, image_key)
       VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(slug) DO NOTHING RETURNING id`
    ).bind(slug, type, name, payload.summary!.trim(), payload.status, nowPublished, payload.imageKey || null).first<{ id: number }>();
    if (!inserted) continue;

    try {
      if (type === 'collection') {
        await bindings.DB.prepare(
          `INSERT INTO collections (content_id, tagline, introduction, ideas_json, closing) VALUES (?, ?, ?, ?, ?)`
        ).bind(inserted.id, payload.tagline?.trim() || null, payload.introduction?.trim() || '', JSON.stringify(payload.ideas ?? []), payload.closing?.trim() || '').run();
      } else {
        const collection = await bindings.DB.prepare(
          `SELECT c.id FROM content c JOIN collections co ON co.content_id = c.id WHERE c.slug = ? AND c.content_type = 'collection'`
        ).bind(payload.collection).first<{ id: number }>();
        if (!collection) {
          await bindings.DB.prepare('DELETE FROM content WHERE id = ?').bind(inserted.id).run();
          return json({ error: 'La colección seleccionada no existe todavía en el panel.' }, 400);
        }
        await bindings.DB.prepare(
          `INSERT INTO products (content_id, collection_id, product_type, description, price_cents, book_format, page_count, cover_text, options_json, featured)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(inserted.id, collection.id, payload.productType!.trim(), payload.description?.trim() || '', payload.price == null ? null : Math.round(payload.price * 100), payload.format?.trim() || '', payload.pages ?? null, payload.coverText?.trim() || '', JSON.stringify(payload.options ?? []), payload.featured ? 1 : 0).run();
      }
      return json({ ok: true, id: inserted.id, slug });
    } catch (cause) {
      await bindings.DB.prepare('DELETE FROM content WHERE id = ?').bind(inserted.id).run();
      console.error('D1 content insert failed', cause);
      return json({ error: 'No se ha podido guardar el contenido. Revisa los datos e inténtalo de nuevo.' }, 500);
    }
  }
  return json({ error: 'No se ha podido generar un slug disponible. Cambia el nombre e inténtalo de nuevo.' }, 409);
};

export const PUT: APIRoute = async ({ request }) => {
  const bindings = env as Env;
  if (!(await authorized(request, bindings))) return json({ error: 'Acceso no autorizado. Configura Cloudflare Access para el panel.' }, 401);
  let payload: Payload;
  try { payload = await request.json() as Payload; }
  catch { return json({ error: 'El contenido de la petición no es válido.' }, 400); }
  const error = validate(payload);
  if (error) return json({ error }, 400);
  if (!Number.isInteger(payload.id) || payload.id! < 1) return json({ error: 'El registro que quieres editar no es válido.' }, 400);
  const id = payload.id!;
  const type = payload.type!;
  const existing = await bindings.DB.prepare('SELECT id FROM content WHERE id = ? AND content_type = ?').bind(id, type).first();
  if (!existing) return json({ error: 'No se ha encontrado el contenido que quieres editar.' }, 404);

  const status = payload.status!;
  const collection = type === 'product'
    ? await bindings.DB.prepare(`SELECT c.id FROM content c JOIN collections co ON co.content_id = c.id WHERE c.slug = ? AND c.content_type = 'collection'`).bind(payload.collection).first<{ id: number }>()
    : null;
  if (type === 'product' && !collection) return json({ error: 'La colección seleccionada no existe todavía en el panel.' }, 400);

  const statements = [bindings.DB.prepare(
    `UPDATE content SET title = ?, summary = ?, status = ?, image_key = ?,
      published_at = CASE WHEN ? = 'published' THEN COALESCE(published_at, CURRENT_TIMESTAMP) ELSE NULL END,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).bind(payload.name!.trim(), payload.summary!.trim(), status, payload.imageKey || null, status, id)];
  if (type === 'collection') {
    statements.push(bindings.DB.prepare(
      `UPDATE collections SET tagline = ?, introduction = ?, ideas_json = ?, closing = ? WHERE content_id = ?`
    ).bind(payload.tagline?.trim() || null, payload.introduction?.trim() || '', JSON.stringify(payload.ideas ?? []), payload.closing?.trim() || '', id));
  } else {
    statements.push(bindings.DB.prepare(
      `UPDATE products SET collection_id = ?, product_type = ?, description = ?, price_cents = ?, book_format = ?, page_count = ?, cover_text = ?, options_json = ?, featured = ? WHERE content_id = ?`
    ).bind(collection!.id, payload.productType!.trim(), payload.description?.trim() || '', payload.price == null ? null : Math.round(payload.price * 100), payload.format?.trim() || '', payload.pages ?? null, payload.coverText?.trim() || '', JSON.stringify(payload.options ?? []), payload.featured ? 1 : 0, id));
  }
  await bindings.DB.batch(statements);
  const saved = await bindings.DB.prepare('SELECT slug FROM content WHERE id = ?').bind(id).first<{ slug: string }>();
  return json({ ok: true, id, slug: saved?.slug });
};

export const DELETE: APIRoute = async ({ request }) => {
  const bindings = env as Env;
  if (!(await authorized(request, bindings))) return json({ error: 'Acceso no autorizado.' }, 401);
  let payload: { id?: number };
  try { payload = await request.json() as { id?: number }; }
  catch { return json({ error: 'La petición no es válida.' }, 400); }
  if (!Number.isInteger(payload.id) || payload.id! < 1) return json({ error: 'El registro que quieres eliminar no es válido.' }, 400);
  const id = payload.id!;
  const item = await bindings.DB.prepare('SELECT id, content_type AS type, image_key AS imageKey FROM content WHERE id = ?').bind(id).first<{ id: number; type: string; imageKey: string | null }>();
  if (!item) return json({ error: 'No se ha encontrado el contenido.' }, 404);
  if (item.type === 'collection') {
    const linked = await bindings.DB.prepare('SELECT COUNT(*) AS total FROM products WHERE collection_id = ?').bind(id).first<{ total: number }>();
    if ((linked?.total ?? 0) > 0) return json({ error: 'No puedes eliminar esta colección mientras tenga productos asociados. Cambia primero esos productos a otra colección.' }, 409);
  }
  await bindings.DB.prepare('DELETE FROM content WHERE id = ?').bind(id).run();
  if (item.imageKey && (env as Env).MEDIA) {
    try { await (env as Env).MEDIA.delete(item.imageKey); } catch (cause) { console.error('Could not delete image from R2', cause); }
  }
  return json({ ok: true });
};
