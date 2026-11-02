import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { createRemoteJWKSet, jwtVerify } from 'jose';

export const prerender = false;

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const FREE_LIMITS = { storageBytes: 10_000_000_000, classA: 1_000_000, classB: 10_000_000 };
const classAOperations = new Set([
  'listbuckets', 'putbucket', 'listobjects', 'putobject', 'copyobject', 'completemultipartupload',
  'createmultipartupload', 'lifecyclestoragetiertransition', 'listmultipartuploads', 'uploadpart',
  'uploadpartcopy', 'listparts', 'putbucketencryption', 'putbucketcors', 'putbucketlifecycleconfiguration',
]);
const classBOperations = new Set([
  'headbucket', 'headobject', 'getobject', 'usagesummary', 'getbucketencryption', 'getbucketlocation',
  'getbucketcors', 'getbucketlifecycleconfiguration',
]);
const freeOperations = new Set(['deleteobject', 'deleteobjects', 'deletebucket', 'abortmultipartupload']);

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function authorized(request: Request, bindings: Env) {
  const teamDomain = bindings.ACCESS_TEAM_DOMAIN?.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const assertion = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!teamDomain || !bindings.ACCESS_AUD || !assertion) return false;
  try {
    let jwks = jwksCache.get(teamDomain);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
      jwksCache.set(teamDomain, jwks);
    }
    await jwtVerify(assertion, jwks, { issuer: `https://${teamDomain}`, audience: bindings.ACCESS_AUD });
    return true;
  } catch { return false; }
}

type OperationGroup = { sum?: { requests?: number }; dimensions?: { actionType?: string; datetime?: string } };
type StorageGroup = { max?: { payloadSize?: number; metadataSize?: number }; dimensions?: { datetime?: string } };

export const GET: APIRoute = async ({ request }) => {
  const bindings = env as Env;
  if (!(await authorized(request, bindings))) return json({ error: 'Acceso no autorizado.' }, 401);
  if (!bindings.R2_ACCOUNT_ID || !bindings.R2_ANALYTICS_API_TOKEN) {
    return json({ configured: false, message: 'Falta configurar el token de lectura de analíticas de R2.' }, 200);
  }

  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const query = `query R2Usage($accountTag: String!, $startDate: Time!, $endDate: Time!) {
    viewer { accounts(filter: { accountTag: $accountTag }) {
      r2OperationsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $startDate, datetime_leq: $endDate }) {
        sum { requests } dimensions { actionType datetime }
      }
      r2StorageAdaptiveGroups(limit: 10000, filter: { datetime_geq: $startDate, datetime_leq: $endDate }) {
        max { payloadSize metadataSize } dimensions { datetime }
      }
    } }
  }`;

  try {
    const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bindings.R2_ANALYTICS_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { accountTag: bindings.R2_ACCOUNT_ID, startDate: monthStart.toISOString(), endDate: now.toISOString() } }),
    });
    const result = await response.json() as {
      errors?: Array<{ message?: string }>;
      data?: { viewer?: { accounts?: Array<{ r2OperationsAdaptiveGroups?: OperationGroup[]; r2StorageAdaptiveGroups?: StorageGroup[] }> } };
    };
    if (!response.ok || result.errors?.length) return json({ error: 'Cloudflare no ha podido devolver las analíticas de R2. Revisa los permisos del token.' }, 502);

    const account = result.data?.viewer?.accounts?.[0];
    if (!account) return json({ error: 'Cloudflare no devolvió datos de uso para esta cuenta.' }, 502);
    const operationsByDay = new Map<string, { classA: number; classB: number }>();
    const storageByDay = new Map<string, number>();
    let unclassified = 0;

    for (const group of account.r2OperationsAdaptiveGroups ?? []) {
      const date = group.dimensions?.datetime?.slice(0, 10);
      if (!date) continue;
      const action = (group.dimensions?.actionType ?? '').replace(/[^a-z]/gi, '').toLowerCase();
      const count = Math.max(0, Number(group.sum?.requests ?? 0));
      const totals = operationsByDay.get(date) ?? { classA: 0, classB: 0 };
      if (classAOperations.has(action)) totals.classA += count;
      else if (classBOperations.has(action)) totals.classB += count;
      else if (!freeOperations.has(action)) {
        // Count unknown billable operation types against both free allowances as a conservative warning.
        totals.classA += count;
        totals.classB += count;
        unclassified += count;
      }
      operationsByDay.set(date, totals);
    }

    for (const group of account.r2StorageAdaptiveGroups ?? []) {
      const date = group.dimensions?.datetime?.slice(0, 10);
      if (!date) continue;
      const bytes = Number(group.max?.payloadSize ?? 0) + Number(group.max?.metadataSize ?? 0);
      storageByDay.set(date, Math.max(storageByDay.get(date) ?? 0, bytes));
    }

    const points: Array<{ date: string; classAPercent: number; classBPercent: number; storagePercent: number }> = [];
    let totalA = 0;
    let totalB = 0;
    let currentStorageBytes = 0;
    const dayCount = now.getUTCDate();
    for (let day = 1; day <= dayCount; day++) {
      const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), day)).toISOString().slice(0, 10);
      const operations = operationsByDay.get(date);
      totalA += operations?.classA ?? 0;
      totalB += operations?.classB ?? 0;
      currentStorageBytes = storageByDay.get(date) ?? currentStorageBytes;
      points.push({
        date,
        classAPercent: Math.min(200, totalA / FREE_LIMITS.classA * 100),
        classBPercent: Math.min(200, totalB / FREE_LIMITS.classB * 100),
        storagePercent: Math.min(200, currentStorageBytes / FREE_LIMITS.storageBytes * 100),
      });
    }

    return json({
      configured: true,
      period: { start: monthStart.toISOString(), updatedAt: now.toISOString() },
      totals: { classA: totalA, classB: totalB, storageBytes: currentStorageBytes, unclassified },
      limits: FREE_LIMITS,
      points,
      source: 'Cloudflare R2 GraphQL Analytics',
    });
  } catch {
    return json({ error: 'No se pudo conectar con las analíticas de Cloudflare R2.' }, 502);
  }
};
