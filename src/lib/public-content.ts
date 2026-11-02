import { env } from 'cloudflare:workers';
import { colecciones as coleccionesDemo } from '../data/colecciones';
import { productosDemo } from '../data/productos-demo';

export interface PublicCollection {
  slug: string;
  nombre: string;
  resumen: string;
  etiqueta: string;
  introduccion: string;
  ideas: string[];
  cierre: string;
  imageUrl: string | null;
  isDemo: boolean;
}

export interface PublicProduct {
  slug: string;
  coleccion: string;
  destacado: boolean;
  nombre: string;
  tipo: string;
  resumen: string;
  descripcion: string;
  precio: number | null;
  portada: string;
  formato: string;
  paginas: string;
  opciones: string[];
  textoPortada: string;
  imageUrl: string | null;
  isDemo: boolean;
}

const demoCollections: PublicCollection[] = coleccionesDemo.map((item) => ({
  ...item,
  isDemo: true,
  imageUrl: null,
}));

const demoProducts: PublicProduct[] = productosDemo.map((item) => ({
  slug: item.slug,
  coleccion: item.coleccion,
  destacado: item.destacado,
  nombre: item.nombre,
  tipo: item.tipo,
  resumen: item.resumen,
  descripcion: '',
  precio: item.precioDemo,
  portada: item.portada,
  formato: item.formatoDemo,
  paginas: item.paginasDemo,
  opciones: item.opcionesDemo,
  textoPortada: item.textoPortada,
  isDemo: true,
  imageUrl: null,
}));

function parseStringArray(value: string | null | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(value ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export async function getPublicCollections(): Promise<PublicCollection[]> {
  try {
    const result = await (env as Env).DB.prepare(
      `SELECT c.slug, c.title AS nombre, c.summary AS resumen, c.image_key AS imageKey, col.tagline AS etiqueta,
        col.introduction AS introduccion, col.ideas_json AS ideasJson, col.closing AS cierre
       FROM content c JOIN collections col ON col.content_id = c.id
       WHERE c.content_type = 'collection' AND c.status = 'published'
       ORDER BY c.published_at DESC, c.title`
    ).all<{ slug: string; nombre: string; resumen: string; imageKey: string | null; etiqueta: string | null; introduccion: string; ideasJson: string; cierre: string }>();

    const fromDatabase: PublicCollection[] = result.results.map((item) => ({
      slug: item.slug,
      nombre: item.nombre,
      resumen: item.resumen,
      etiqueta: item.etiqueta || item.nombre,
      introduccion: item.introduccion,
      ideas: parseStringArray(item.ideasJson),
      cierre: item.cierre,
      imageUrl: item.imageKey ? `/media/${item.imageKey}` : null,
      isDemo: false,
    }));
    const demoSlugs = new Set(demoCollections.map((item) => item.slug));
    return [...demoCollections, ...fromDatabase.filter((item) => !demoSlugs.has(item.slug))];
  } catch (error) {
    console.error('Could not read public collections from D1', error);
    return demoCollections;
  }
}

export async function getPublicProducts(): Promise<PublicProduct[]> {
  try {
    const result = await (env as Env).DB.prepare(
      `SELECT c.slug, c.title AS nombre, c.summary AS resumen, c.image_key AS imageKey,
        p.product_type AS tipo, p.description AS descripcion, p.price_cents AS priceCents,
        p.book_format AS formato, p.page_count AS paginas, p.cover_text AS coverText,
        p.options_json AS optionsJson, p.featured AS destacado, collection.slug AS collectionSlug
       FROM content c JOIN products p ON p.content_id = c.id
       JOIN content collection ON collection.id = p.collection_id
       WHERE c.content_type = 'product' AND c.status = 'published'
         AND collection.content_type = 'collection' AND collection.status = 'published'
       ORDER BY p.featured DESC, c.published_at DESC, c.title`
    ).all<{
      slug: string; nombre: string; resumen: string; imageKey: string | null; tipo: string; descripcion: string;
      priceCents: number | null; formato: string; paginas: number | null; coverText: string;
      optionsJson: string; destacado: number; collectionSlug: string;
    }>();

    const fromDatabase: PublicProduct[] = result.results.map((item, index) => ({
      slug: item.slug,
      coleccion: item.collectionSlug,
      destacado: Boolean(item.destacado),
      nombre: item.nombre,
      tipo: item.tipo,
      resumen: item.resumen,
      descripcion: item.descripcion,
      precio: item.priceCents == null ? null : item.priceCents / 100,
      portada: ['terracota', 'olivo', 'malva', 'arena', 'salvia', 'azul'][index % 6],
      formato: item.formato,
      paginas: item.paginas == null ? '' : `${item.paginas} páginas`,
      opciones: parseStringArray(item.optionsJson),
      textoPortada: item.coverText || item.nombre,
      imageUrl: item.imageKey ? `/media/${item.imageKey}` : null,
      isDemo: false,
    }));
    const demoSlugs = new Set(demoProducts.map((item) => item.slug));
    return [...demoProducts, ...fromDatabase.filter((item) => !demoSlugs.has(item.slug))];
  } catch (error) {
    console.error('Could not read public products from D1', error);
    return demoProducts;
  }
}
