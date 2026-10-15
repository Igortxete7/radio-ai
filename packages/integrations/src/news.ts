import { createHash } from 'node:crypto';
import Parser from 'rss-parser';
import type { RadioConfig } from '@radio/config';
import { RadioError, type NewsCandidate, type NewsProvider, type NewsSource } from '@radio/shared';
import { fetchText, httpUrl } from './http.ts';

export type NewsSourceStatus = {
  name: string;
  url: string;
  ok: boolean;
  checkedAt: string;
  errorCode?: string;
  items: number;
};

export function stripHtml(input: string): string {
  const entities: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
  };
  let decoded = input;
  // Decode before removing tags so entity-encoded script/style markup cannot
  // survive as editorial content. Two passes also handle doubly escaped feeds.
  for (let pass = 0; pass < 2; pass++)
    decoded = decoded.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (whole: string, entity: string) => {
      if (!entity.startsWith('#')) return entities[entity.toLowerCase()] ?? whole;
      const value = entity.toLowerCase().startsWith('#x')
        ? parseInt(entity.slice(2), 16)
        : parseInt(entity.slice(1), 10);
      return Number.isInteger(value) &&
        value > 0 &&
        value <= 0x10ffff &&
        !(value >= 0xd800 && value <= 0xdfff)
        ? String.fromCodePoint(value)
        : ' ';
    });
  return decoded
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function canonicalNewsUrl(value: string, base?: string): string | undefined {
  try {
    const url = httpUrl(base ? new URL(value, base).href : value);
    url.hash = '';
    for (const key of [...url.searchParams.keys()])
      if (/^(utm_.+|fbclid|gclid|dclid|mc_cid|mc_eid|igshid)$/i.test(key))
        url.searchParams.delete(key);
    url.searchParams.sort();
    if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString();
  } catch {
    return undefined;
  }
}

export function newsFingerprint(url: string | undefined, title: string): string {
  const identity = url
    ? `url:${url}`
    : `title:${stripHtml(title)
        .normalize('NFKC')
        .toLocaleLowerCase('es')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()}`;
  return createHash('sha256').update(identity).digest('hex');
}

export class RssNewsProvider implements NewsProvider {
  public sourceStatuses: NewsSourceStatus[] = [];
  private readonly parser = new Parser();
  constructor(private readonly config: RadioConfig) {}

  private async source(source: NewsSource, now: Date): Promise<NewsCandidate[]> {
    const xml = await fetchText(httpUrl(source.url), this.config.fetchTimeoutMs, {
      attempts: 1,
      maxBytes: 3 * 1024 * 1024,
      followRedirects: true,
    });
    if (/<!DOCTYPE|<!ENTITY/i.test(xml))
      throw new RadioError('NEWS_XML', 'No se permiten declaraciones de entidades XML', 502);
    let feed: Awaited<ReturnType<Parser['parseString']>>;
    try {
      feed = await this.parser.parseString(xml);
    } catch {
      throw new RadioError('NEWS_XML', 'Feed RSS/Atom inválido', 502);
    }
    const earliest = now.valueOf() - this.config.newsMaxAgeHours * 3_600_000;
    const items: NewsCandidate[] = [];
    for (const item of feed.items.slice(0, 500)) {
      const title = stripHtml(item.title ?? '').slice(0, 500);
      const published = new Date(item.isoDate ?? item.pubDate ?? '');
      if (
        !title ||
        !Number.isFinite(published.valueOf()) ||
        published.valueOf() < earliest ||
        published.valueOf() > now.valueOf() + 5 * 60_000
      )
        continue;
      const canonical = item.link ? canonicalNewsUrl(item.link, source.url) : undefined;
      const fingerprint = newsFingerprint(canonical, title);
      const summary = stripHtml(item.content ?? item.summary ?? item.contentSnippet ?? '').slice(
        0,
        1000,
      );
      items.push({
        id: `news-${fingerprint.slice(0, 24)}`,
        source: source.name,
        title,
        url: canonical ?? source.url,
        publishedAt: published.toISOString(),
        summary: summary || undefined,
        fingerprint,
        priority: source.priority,
        category: source.category,
      });
    }
    return items;
  }

  async fetchCandidates(now: Date): Promise<NewsCandidate[]> {
    if (!Number.isFinite(now.valueOf()))
      throw new RadioError('NEWS_DATE', 'Fecha de noticias inválida', 400);
    const sources = this.config.newsSources.filter((source) => source.enabled !== false);
    const results = await Promise.allSettled(sources.map((source) => this.source(source, now)));
    this.sourceStatuses = results.map((result, index) => ({
      name: sources[index]!.name,
      url: sources[index]!.url,
      checkedAt: new Date().toISOString(),
      ok: result.status === 'fulfilled',
      items: result.status === 'fulfilled' ? result.value.length : 0,
      errorCode:
        result.status === 'rejected'
          ? result.reason instanceof RadioError
            ? result.reason.code
            : 'NEWS_UNAVAILABLE'
          : undefined,
    }));
    if (sources.length && results.every((result) => result.status === 'rejected'))
      throw new RadioError(
        'NEWS_UNAVAILABLE',
        'Ninguna fuente de noticias está disponible',
        502,
        true,
      );
    const ranked = results
      .flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
      .sort(
        (a, b) =>
          b.priority - a.priority ||
          Date.parse(b.publishedAt) - Date.parse(a.publishedAt) ||
          a.title.localeCompare(b.title, 'es'),
      );
    const seen = new Set<string>();
    return ranked
      .filter((item) => {
        if (seen.has(item.fingerprint)) return false;
        seen.add(item.fingerprint);
        return true;
      })
      .slice(0, 100);
  }
}
