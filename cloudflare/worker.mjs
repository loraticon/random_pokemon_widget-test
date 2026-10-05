import pokemonData from '../data/pokemon-final-with-forms.json' with { type: 'json' };
import typeData from '../data/pokemon-background-types.json' with { type: 'json' };
import backgroundCatalog from '../data/background-catalog.json' with { type: 'json' };

const VERSION = '2026-03-11';
const DEFAULT_ORIGIN = 'https://pokemon.loraticon.com';
const SETTINGS_SLUG = '__widget_settings_v1__';
const SETTINGS_CAPTION = 'pokemon-widget-preferences-v1';
const remoteImages = 'https://raw.githubusercontent.com/loraticon/random_pokemon_widget-ver1/main/images';
export const koreaDay = (time = Date.now()) => new Date(new Date(time).getTime() + 32400000).toISOString().slice(0, 10);
export const normalizeSlug = slug => String(slug).replace(/^mr[.-]+mime$/i, 'mr-mime').replace(/farfetch['’]d/gi, 'farfetchd').replace(/^nidoran♀$/i, 'nidoran-f').replace(/^nidoran♂$/i, 'nidoran-m');
const captureKey = record => normalizeSlug(record.slug) + ':false';
const entries = new Map(pokemonData.map(entry => [normalizeSlug(entry.slug), entry]));
const defaultPreferences = { mode: 'draw', pokemonKey: '', backgroundId: '', favoritePokemon: [], favoriteBackgrounds: [] };
const properties = { '이름': { title: {} }, '폼 식별자': { rich_text: {} }, '배경 식별자': { rich_text: {} }, '즐겨찾기': { checkbox: {} } };
export function backgroundFor(record) {
  if (record.backgroundId) return backgroundCatalog.items[record.backgroundId] || null;
  const slug = normalizeSlug(record.slug);
  const types = typeData.bySlug[slug] || typeData.byDex[record.dexId] || [];
  const id = backgroundCatalog.bySlug[slug] || types.map(type => backgroundCatalog.byType[type]).find(Boolean);
  return backgroundCatalog.items[id] || null;
}
const richText = content => [{ type: 'text', text: { content: String(content) } }];
const plain = property => (property?.title || property?.rich_text || []).map(part => part.plain_text || part.text?.content || '').join('');
const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
class ServiceError extends Error {
  constructor(message, status = 503, uncertain = false, code) { super(message); Object.assign(this, { status, uncertain, code }); }
}
export function pageId(value) {
  const input = String(value || '').trim();
  if (/^[0-9a-f]{32}$/i.test(input)) return input.toLowerCase();
  if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input)) return input.replaceAll('-', '').toLowerCase();
  let url;
  try { url = new URL(input); } catch {}
  if (!url || url.protocol !== 'https:' || url.username || url.password || !(url.hostname === 'app.notion.com' || /(^|\.)(notion\.so|notion\.site)$/.test(url.hostname))) {
    throw new ServiceError('복제한 노션 수집 DB의 HTTPS 주소를 입력해주세요.', 400);
  }
  const id = decodeURIComponent(url.pathname).match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{32})\/?$/i)?.[1];
  if (!id) throw new ServiceError('복제한 원본 노션 DB 주소를 확인해주세요.', 400);
  return id.replaceAll('-', '').toLowerCase();
}
// 같은 실행 인스턴스에 들어온 요청만 직렬화합니다. 여러 기기의 동시 요청에 대한 전역 잠금은 아닙니다.
const queues = new Map();
async function serial(databaseId, task) {
  const previous = queues.get(databaseId) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  queues.set(databaseId, current);
  await previous;
  try { return await task(); }
  finally { release(); if (queues.get(databaseId) === current) queues.delete(databaseId); }
}
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    let allowedOrigin;
    try {
      const configured = new URL(env.WIDGET_ORIGIN || DEFAULT_ORIGIN);
      if (configured.protocol === 'https:' && !configured.username && !configured.password && !configured.search && !configured.hash && configured.pathname === '/') allowedOrigin = configured.origin;
    } catch {}
    const respond = response => {
      const headers = new Headers(response.headers); headers.set('Vary', 'Origin');
      if (origin && origin === allowedOrigin) headers.set('Access-Control-Allow-Origin', origin);
      return new Response(response.body, { status: response.status, headers });
    };
    const reject = (message, status) => respond(json({ error: message }, status));
    if (!allowedOrigin) return reject('Worker의 WIDGET_ORIGIN 설정을 확인해주세요.', 503);
    if (origin && origin !== allowedOrigin) return reject('허용되지 않은 위젯 주소입니다.', 403);
    const url = new URL(request.url);
    const methods = { '/api/setup': 'POST', '/api/collection': 'GET', '/api/capture': 'POST', '/api/preferences': 'POST' };
    if (!methods[url.pathname]) return reject('개인 Worker는 수집 API만 제공합니다.', 404);
    if (request.method === 'OPTIONS') {
      const asked = (request.headers.get('Access-Control-Request-Headers') || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
      if (!origin || request.headers.get('Access-Control-Request-Method') !== methods[url.pathname] || asked.some(x => x !== 'content-type')) return reject('지원하지 않는 연결 요청입니다.', 403);
      return respond(new Response(null, { status: 204, headers: { 'Access-Control-Allow-Methods': methods[url.pathname], 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' } }));
    }
    if (request.method !== methods[url.pathname]) return reject('지원하지 않는 요청 방식입니다.', 405);
    if (!env.NOTION_TOKEN) return reject('개인 Worker의 Secret에 NOTION_TOKEN을 등록하고 배포해주세요.', 503);
    try {
      let body = {};
      if (request.method === 'POST') {
        const text = await request.text();
        if (new TextEncoder().encode(text).length > 65536) throw new ServiceError('저장 요청이 너무 커요.', 413);
        try { body = JSON.parse(text); } catch { throw new ServiceError('연결 요청 형식을 확인해주세요.', 400); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ServiceError('연결 요청 형식을 확인해주세요.', 400);
      }
      const databaseId = pageId(body.databaseId || url.searchParams.get('db'));
      const collection = new NotionCollection(env, databaseId, allowedOrigin);
      const result = await serial(databaseId, async () => {
        if (url.pathname === '/api/setup') {
          const config = await collection.database(true);
          await collection.settings(true);
          return { databaseId, databaseUrl: config.url, dailyLimit: collection.limit };
        }
        if (url.pathname === '/api/capture') return collection.capture(body);
        if (url.pathname === '/api/preferences') return collection.savePreferences(body);
        return collection.getSnapshot(url.searchParams.get('records') === '1');
      });
      return respond(json(result));
    } catch (error) {
      return respond(json({ error: error instanceof ServiceError ? error.message : '노션 연결을 처리하지 못했어요. 잠시 후 다시 확인해주세요.', ...(error.code ? { code: error.code } : {}) }, error.status || 503));
    }
  }
};

export class NotionCollection {
  constructor(env, databaseId, origin = DEFAULT_ORIGIN) {
    this.env = env; this.databaseId = pageId(databaseId); this.origin = origin;
    const limit = Number(env.DAILY_LIMIT ?? 3);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ServiceError('DAILY_LIMIT은 1~100 사이의 정수로 설정해주세요.', 400);
    this.limit = limit;
  }
  async notion(path, body, method = body ? 'POST' : 'GET') {
    let response;
    try {
      response = await fetch('https://api.notion.com/v1/' + path, { method,
        headers: { Authorization: 'Bearer ' + this.env.NOTION_TOKEN, 'Notion-Version': VERSION, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(18000) });
    } catch { throw new ServiceError('노션 응답이 지연되고 있어요. 잠시 후 저장 상태를 확인해주세요.', 503, true); }
    if (!response.ok) {
      const message = response.status === 401 ? '노션 연결 토큰을 확인해주세요.'
        : [403, 404].includes(response.status) ? '복제한 원본 DB 주소와 노션의 연결 추가 권한을 확인해주세요.'
        : response.status === 429 ? '노션 요청이 잠시 많아졌어요. 조금 뒤 다시 확인해주세요.'
        : '노션 기록을 처리하지 못했어요. DB 속성과 연결 설정을 확인해주세요.';
      throw new ServiceError(message, response.status === 429 ? 429 : 503, response.status >= 500 || response.status === 408);
    }
    try { return await response.json(); } catch { throw new ServiceError('노션 응답을 읽지 못했어요. 저장 상태를 확인해주세요.', 503, true); }
  }
  async database(prepare = false) {
    if (!this.config) {
      const database = await this.notion('databases/' + this.databaseId);
      if (database.data_sources?.length !== 1) throw new ServiceError('데이터 소스가 하나인 원본 수집 DB를 연결해주세요.', 400);
      this.config = { source: database.data_sources[0].id, url: database.url || 'https://www.notion.so/' + this.databaseId };
    }
    if (prepare) {
      const source = await this.notion('data_sources/' + this.config.source);
      for (const [name, definition] of Object.entries(properties)) {
        if (source.properties?.[name] && !(Object.keys(definition)[0] in source.properties[name])) throw new ServiceError(`노션의 '${name}' 속성 유형을 확인해주세요.`, 400);
      }
      const missing = Object.fromEntries(Object.entries(properties).filter(([name]) => !source.properties?.[name]));
      if (Object.keys(missing).length) await this.notion('data_sources/' + this.config.source, { properties: missing }, 'PATCH');
    }
    return this.config;
  }
  async query(filter) {
    const config = await this.database(); const pages = []; let cursor;
    for (let count = 0; count < 100; count++) {
      const data = await this.notion(`data_sources/${config.source}/query`, { page_size: 100, ...(filter ? { filter } : {}), ...(cursor ? { start_cursor: cursor } : {}) });
      pages.push(...data.results.filter(page => !page.archived && !page.in_trash));
      if (!data.has_more) return pages;
      cursor = data.next_cursor;
      if (!cursor) break;
    }
    throw new ServiceError('노션 기록을 모두 읽지 못했어요. 다시 확인해주세요.');
  }
  async settings(create = false) {
    if (this.settingsRecord) return this.settingsRecord;
    const pages = await this.query({ property: '폼 식별자', rich_text: { equals: SETTINGS_SLUG } });
    let page = pages.sort((a, b) => String(a.created_time).localeCompare(String(b.created_time)) || a.id.localeCompare(b.id))[0];
    if (!page && create) {
      page = await this.notion('pages', { parent: { type: 'data_source_id', data_source_id: (await this.database()).source },
        properties: { '이름': { title: richText('위젯 설정') }, '폼 식별자': { rich_text: richText(SETTINGS_SLUG) } },
        children: [{ object: 'block', type: 'code', code: { language: 'json', caption: richText(SETTINGS_CAPTION), rich_text: this.settingsText(defaultPreferences) } }] });
    }
    if (!page) throw new ServiceError('연결 페이지에서 DB를 연결해 위젯 설정 페이지를 준비해주세요.', 400);
    let cursor; let block;
    for (let count = 0; count < 10; count++) {
      const data = await this.notion(`blocks/${page.id}/children?page_size=100${cursor ? '&start_cursor=' + encodeURIComponent(cursor) : ''}`);
      block = data.results.find(item => item.type === 'code' && plain({ rich_text: item.code.caption }) === SETTINGS_CAPTION);
      if (block || !data.has_more) break;
      cursor = data.next_cursor;
      if (!cursor) break;
    }
    if (!block) throw new ServiceError('노션의 위젯 설정 페이지에서 설정 블록을 찾지 못했어요.', 400);
    let preferences;
    try { preferences = JSON.parse(plain({ rich_text: block.code.rich_text })); }
    catch { throw new ServiceError('노션 위젯 설정 내용을 확인해주세요.', 400); }
    if (!preferences || !['draw', 'sleep'].includes(preferences.mode) || typeof preferences.pokemonKey !== 'string' || typeof preferences.backgroundId !== 'string' || !Array.isArray(preferences.favoriteBackgrounds)) throw new ServiceError('노션 위젯 설정 형식을 확인해주세요.', 400);
    return this.settingsRecord = { pageId: page.id, blockId: block.id, preferences: { ...defaultPreferences, ...preferences } };
  }
  settingsText(preferences) {
    const text = JSON.stringify({ mode: preferences.mode, pokemonKey: preferences.pokemonKey, backgroundId: preferences.backgroundId, favoriteBackgrounds: preferences.favoriteBackgrounds });
    return text.match(/[\s\S]{1,1800}/gu).map(part => richText(part)[0]);
  }
  toRecord(page) {
    const p = page.properties; const slug = normalizeSlug(plain(p['폼 식별자']));
    const entry = entries.get(slug);
    if (!entry) throw new ServiceError(`노션의 폼 식별자 '${slug}'를 확인해주세요.`, 400);
    const backgroundId = plain(p['배경 식별자']).trim();
    if (backgroundId && !backgroundCatalog.items[backgroundId]) throw new ServiceError(`노션의 배경 식별자 '${backgroundId}'를 확인해주세요.`, 400);
    const record = { id: page.id, pageId: page.id, slug, dexId: entry.dexId, name: plain(p['이름']) || entry.ko || entry.en, isShiny: false,
      favorite: Boolean(p['즐겨찾기']?.checkbox), backgroundId, capturedAt: page.created_time, imageSrc: `${remoteImages}/normal/${encodeURIComponent(slug)}.webp` };
    const background = backgroundFor(record);
    return { ...record, backgroundId: background?.id || '', backgroundName: background?.title || '', backgroundSrc: background ? new URL(background.path.slice(2), this.origin).href : '' };
  }
  async readRecords() {
    return (await this.query()).filter(page => plain(page.properties['폼 식별자']) !== SETTINGS_SLUG && !page.properties['색이 다름']?.checkbox).map(page => this.toRecord(page)).sort((a, b) => a.dexId - b.dexId);
  }
  preferences(records, stored) {
    const pokemon = new Set(records.map(captureKey)); const backgrounds = new Set(records.map(record => record.backgroundId).filter(Boolean));
    return { ...defaultPreferences, ...stored,
      pokemonKey: pokemon.has(stored.pokemonKey) ? stored.pokemonKey : '', backgroundId: backgrounds.has(stored.backgroundId) ? stored.backgroundId : '',
      favoritePokemon: [...new Set(records.filter(record => record.favorite).map(captureKey))], favoriteBackgrounds: [...new Set(stored.favoriteBackgrounds)].filter(id => backgrounds.has(id)) };
  }
  async getSnapshot(all = true) {
    const records = await this.readRecords(); const settings = await this.settings();
    const day = koreaDay(); const used = records.filter(record => koreaDay(record.capturedAt) === day).length;
    return { schemaVersion: 4, day, used, limit: this.limit, remaining: Math.max(0, this.limit - used), pending: [],
      owned: [...new Set(records.map(captureKey))], records: all ? records : [], nextCursor: null, preferences: this.preferences(records, settings.preferences) };
  }
  async capture(body) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.id || '') || body.isShiny !== false) throw new ServiceError('일반 포켓몬의 수집 요청을 확인해주세요.', 400);
    const slug = normalizeSlug(body.slug); const entry = entries.get(slug);
    if (!entry) throw new ServiceError('도감에 없는 포켓몬입니다.', 400);
    const before = await this.getSnapshot();
    if (before.owned.includes(captureKey(entry))) throw new ServiceError('이미 잡은 포켓몬이에요.', 409, false, 'ALREADY_COLLECTED');
    if (!before.remaining) throw new ServiceError('오늘의 수집 기회를 모두 사용했어요.', 409, false, 'DAILY_LIMIT');
    const background = backgroundFor(entry);
    try {
      await this.notion('pages', { parent: { type: 'data_source_id', data_source_id: (await this.database()).source }, properties: {
        '이름': { title: richText(entry.ko || entry.en) }, '폼 식별자': { rich_text: richText(slug) },
        '배경 식별자': { rich_text: richText(background?.id || '') }, '즐겨찾기': { checkbox: false }
      } });
    } catch (error) {
      if (!error.uncertain) throw error;
      // 응답을 놓친 경우 먼저 노션에 저장됐는지 조회합니다. 자동으로 POST를 재전송하지 않습니다.
      const after = await this.getSnapshot();
      if (after.owned.includes(captureKey(entry))) return after;
      throw error;
    }
    return this.getSnapshot();
  }
  async savePreferences(body) {
    const records = await this.readRecords(); const settings = await this.settings();
    const current = this.preferences(records, settings.preferences);
    if (body.favoriteChange) {
      const { pokemonKey, favorite } = body.favoriteChange;
      const matches = records.filter(record => captureKey(record) === pokemonKey);
      if (typeof favorite !== 'boolean' || !matches.length) throw new ServiceError('수집한 포켓몬만 즐겨찾기에 추가할 수 있어요.', 400);
      for (const record of matches) if (record.favorite !== favorite) await this.notion('pages/' + record.pageId, { properties: { '즐겨찾기': { checkbox: favorite } } }, 'PATCH');
      return { schemaVersion: 4, preferences: this.preferences(await this.readRecords(), settings.preferences) };
    }
    const next = { ...current, ...body };
    if (!['draw', 'sleep'].includes(next.mode) || typeof next.pokemonKey !== 'string' || typeof next.backgroundId !== 'string' || !Array.isArray(next.favoriteBackgrounds) || next.favoriteBackgrounds.length > 3000 || next.favoriteBackgrounds.some(id => typeof id !== 'string' || id.length > 160)) throw new ServiceError('화면 설정을 확인해주세요.', 400);
    if (next.pokemonKey && !records.some(record => captureKey(record) === next.pokemonKey)) throw new ServiceError('수집한 포켓몬만 선택할 수 있어요.', 400);
    const owned = new Set(records.map(record => record.backgroundId).filter(Boolean));
    if (next.backgroundId && !owned.has(next.backgroundId) || next.favoriteBackgrounds.some(id => !owned.has(id))) throw new ServiceError('수집한 배경만 선택할 수 있어요.', 400);
    next.favoriteBackgrounds = [...new Set(next.favoriteBackgrounds)];
    await this.notion('blocks/' + settings.blockId, { code: { rich_text: this.settingsText(next) } }, 'PATCH');
    settings.preferences = next;
    return { schemaVersion: 4, preferences: this.preferences(records, next) };
  }
}
