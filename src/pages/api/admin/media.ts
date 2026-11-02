import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { createRemoteJWKSet, jwtVerify } from 'jose';

export const prerender = false;
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const allowedTypes = new Map([['image/jpeg', 'jpg'], ['image/png', 'png'], ['image/webp', 'webp']]);

async function authorized(request: Request, bindings: Env) {
  const teamDomain = bindings.ACCESS_TEAM_DOMAIN?.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!teamDomain || !bindings.ACCESS_AUD || !token) return false;
  try {
    let jwks = jwksCache.get(teamDomain);
    if (!jwks) { jwks = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`)); jwksCache.set(teamDomain, jwks); }
    await jwtVerify(token, jwks, { issuer: `https://${teamDomain}`, audience: bindings.ACCESS_AUD });
    return true;
  } catch { return false; }
}

export const POST: APIRoute = async ({ request }) => {
  const bindings = env as Env;
  if (!(await authorized(request, bindings))) return Response.json({ error: 'Acceso no autorizado.' }, { status: 401 });
  if (!bindings.MEDIA) return Response.json({ error: 'El almacenamiento de imágenes R2 todavía no está conectado.' }, { status: 503 });
  const form = await request.formData();
  const file = form.get('file');
  if (!(file instanceof File)) return Response.json({ error: 'Selecciona una imagen.' }, { status: 400 });
  const extension = allowedTypes.get(file.type);
  if (!extension) return Response.json({ error: 'Formato no válido. Usa JPG, PNG o WebP.' }, { status: 415 });
  if (file.size > 8 * 1024 * 1024) return Response.json({ error: 'La imagen no puede superar 8 MB.' }, { status: 413 });
  const key = `uploads/${crypto.randomUUID()}.${extension}`;
  await bindings.MEDIA.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type, cacheControl: 'public, max-age=31536000, immutable' },
    customMetadata: { originalName: file.name.slice(0, 120) },
  });
  return Response.json({ key, url: `/media/${key}` }, { headers: { 'Cache-Control': 'no-store' } });
};

export const DELETE: APIRoute = async ({ request }) => {
  const bindings = env as Env;
  if (!(await authorized(request, bindings))) return Response.json({ error: 'Acceso no autorizado.' }, { status: 401 });
  if (!bindings.MEDIA) return Response.json({ error: 'El almacenamiento de imágenes R2 todavía no está conectado.' }, { status: 503 });
  let payload: { key?: string };
  try { payload = await request.json() as { key?: string }; }
  catch { return Response.json({ error: 'La petición no es válida.' }, { status: 400 }); }
  if (!payload.key?.startsWith('uploads/')) return Response.json({ error: 'La imagen indicada no es válida.' }, { status: 400 });
  await bindings.MEDIA.delete(payload.key);
  return Response.json({ ok: true });
};
