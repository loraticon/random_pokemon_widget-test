import pokemonData from '../data/pokemon-final-with-forms.json' with { type: 'json' };
import typeData from '../data/pokemon-background-types.json' with { type: 'json' };
import backgroundCatalog from '../data/background-catalog.json' with { type: 'json' };

const VERSION = '2026-03-11';
const DB_TITLE = '포켓몬 수집 기록';
const remoteImages = 'https://raw.githubusercontent.com/loraticon/random_pokemon_widget-test/main/images';
export const koreaDay = (time = Date.now()) => new Date(new Date(time).getTime() + 32400000).toISOString().slice(0, 10);
export const normalizeSlug = slug => String(slug).replace(/^mr[.-]+mime$/i, 'mr-mime').replace(/farfetch['’]d/gi, 'farfetchd').replace(/^nidoran♀$/i, 'nidoran-f').replace(/^nidoran♂$/i, 'nidoran-m');
const captureKey = record => normalizeSlug(record.slug) + ':' + Boolean(record.isShiny);
const entries = new Map(pokemonData.map(entry => [normalizeSlug(entry.slug), entry]));
const defaultPreferences = { mode: 'draw', pokemonKey: '', backgroundId: '', favoritePokemon: [], favoriteBackgrounds: [] };
const collectionProperties = { '이름': { title: {} }, '폼 식별자': { rich_text: {} }, '배경 식별자': { rich_text: {} }, '즐겨찾기': { checkbox: {} } };
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
  constructor(message, status = 503, uncertain = false, code) { super(message); this.status = status; this.uncertain = uncertain; this.code = code; }
}
export function pageId(value) {
  const id = String(value || '').split('?')[0].match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})(?:$|\/)/i)?.[1];
  if (!id) throw new ServiceError('Cloudflare의 NOTION_PARENT_PAGE_ID에 노션 페이지 주소를 입력해주세요.', 400);
  return id;
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let allowedOrigin;
    try {
      const configured = new URL(env.WIDGET_ORIGIN);
      if (configured.protocol === 'https:' && !configured.username && !configured.password && !configured.search && !configured.hash && configured.pathname === '/') allowedOrigin = configured.origin;
    } catch {}
    const origin = request.headers.get('Origin');
    const respond = response => {
      const headers = new Headers(response.headers);
      headers.set('Vary', 'Origin');
      if (origin && origin === allowedOrigin) headers.set('Access-Control-Allow-Origin', origin);
      return new Response(response.body, { status: response.status, headers });
    };
    const reject = (message, status) => respond(json({ error: message }, status));
    if (!allowedOrigin) return reject('Worker의 WIDGET_ORIGIN에 제작자가 제공한 공용 화면 주소를 설정해주세요.', 503);
    if (origin && origin !== allowedOrigin) return reject('허용되지 않은 위젯 주소입니다.', 403);
    const methods = { '/api/setup': 'POST', '/api/collection': 'GET', '/api/capture': 'POST', '/api/preferences': 'POST' };
    if (!methods[url.pathname]) return reject('개인 Worker는 수집 API만 제공합니다.', 404);
    if (request.method === 'OPTIONS') {
      const askedMethod = request.headers.get('Access-Control-Request-Method');
      const askedHeaders = (request.headers.get('Access-Control-Request-Headers') || '').split(',').map(header => header.trim().toLowerCase()).filter(Boolean);
      if (!origin || askedMethod !== methods[url.pathname] || askedHeaders.some(header => !['authorization', 'content-type'].includes(header))) return reject('지원하지 않는 연결 요청입니다.', 403);
      return respond(new Response(null, { status: 204, headers: {
        'Access-Control-Allow-Methods': methods[url.pathname], 'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Max-Age': '86400'
      } }));
    }
    if (request.method !== methods[url.pathname]) return reject('지원하지 않는 요청 방식입니다.', 405);
    if (!env.WIDGET_KEY || env.WIDGET_KEY.length < 32 || !env.NOTION_TOKEN || !env.COLLECTION) {
      return reject('Cloudflare 연결 설정이 필요해요. 설치 안내를 확인해주세요.', 503);
    }
    // 임베드의 제3자 쿠키에 의존하지 않는 개인 위젯 키. 노션 토큰과는 별개입니다.
    const supplied = request.headers.get('Authorization')?.replace(/^Bearer /, '') || '';
    const digest = async text => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
    const [actual, expected] = await Promise.all([digest(supplied), digest(env.WIDGET_KEY)]);
    let difference = 0;
    for (let i = 0; i < actual.length; i++) difference |= actual[i] ^ expected[i];
    if (difference) return reject('위젯 연결 키를 확인해주세요.', 401);
    const stub = env.COLLECTION.get(env.COLLECTION.idFromName('personal-collection-v1'));
    return respond(await stub.fetch(request));
  }
};

export class Collection {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.queue = Promise.resolve(); }
  async fetch(request) {
    // Notion 요청으로 await하는 동안 다른 포획이 끼어들지 않도록 직렬화합니다.
    const previous = this.queue;
    let release;
    this.queue = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      const url = new URL(request.url);
      if (url.pathname === '/api/setup' && request.method === 'POST') {
        const config = await this.ensureDatabase();
        return json({ databaseUrl: config.url });
      }
      if (url.pathname === '/api/collection' && request.method === 'GET') {
        await this.ensureDatabase();
        return json(await this.getSnapshot(url));
      }
      if (['/api/capture', '/api/preferences'].includes(url.pathname) && request.method === 'POST') {
        const text = await request.text();
        const limit = url.pathname === '/api/preferences' ? 65536 : 8192;
        if (new TextEncoder().encode(text).length > limit) throw new ServiceError('저장 요청이 너무 커요.', 413);
        let body;
        try { body = JSON.parse(text); } catch { throw new ServiceError('수집 요청을 읽지 못했어요.', 400); }
        return json(url.pathname === '/api/preferences' ? await this.savePreferences(body) : await this.capture(body));
      }
      return json({ error: '지원하지 않는 요청입니다.' }, 404);
    } catch (error) {
      return json({ error: error instanceof ServiceError ? error.message : '기록을 처리하지 못했어요. 잠시 후 다시 확인해주세요.', code: error.code }, error.status || 503);
    } finally { release(); }
  }
  async notion(path, body, method = body ? 'POST' : 'GET') {
    let response;
    try {
      response = await fetch('https://api.notion.com/v1/' + path, {
        method, headers: { Authorization: 'Bearer ' + this.env.NOTION_TOKEN, 'Notion-Version': VERSION, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(18000)
      });
    } catch { throw new ServiceError('노션 응답이 지연되고 있어요. 잠시 후 저장 상태를 확인해주세요.', 503, true); }
    if (!response.ok) {
      const message = response.status === 401 ? '노션 연결 토큰을 확인해주세요.'
        : [403, 404].includes(response.status) ? '노션 페이지에 연결 권한을 추가해주세요.'
        : response.status === 429 ? '노션 요청이 잠시 많아졌어요. 조금 뒤 다시 확인해주세요.'
        : '노션 기록을 처리하지 못했어요. DB 속성과 연결 설정을 확인해주세요.';
      throw new ServiceError(message, response.status === 429 ? 429 : 503, response.status >= 500 || response.status === 408);
    }
    try { return await response.json(); } catch { throw new ServiceError('노션 응답을 읽지 못했어요. 저장 상태를 확인해주세요.', 503, true); }
  }
  async saveDatabase(database, currentSchema = false) {
    const source = database.data_sources?.[0]?.id;
    if (!source) throw new ServiceError('노션 DB의 데이터 소스를 확인하지 못했어요.');
    const config = { id: database.id, source, url: database.url, ...(currentSchema ? { schemaVersion: 3 } : {}) };
    await this.ctx.storage.put('database', config);
    await this.ctx.storage.delete('database-pending');
    return this.upgradeDatabase(config);
  }
  async upgradeDatabase(config) {
    if (config.schemaVersion === 3) return config;
    const source = await this.notion('data_sources/' + config.source);
    for (const [name, definition] of Object.entries(collectionProperties)) {
      const property = source.properties?.[name];
      if (property && !(Object.keys(definition)[0] in property)) throw new ServiceError(`노션의 '${name}' 속성 유형을 확인해주세요.`, 400);
    }
    const missing = Object.fromEntries(Object.entries(collectionProperties).filter(([name]) => !source.properties?.[name]));
    if (missing['즐겨찾기']) {
      const previousFavorites = (await this.ctx.storage.get('preferences'))?.favoritePokemon || [];
      if (previousFavorites.length) await this.ctx.storage.put('notion-favorite-migration', previousFavorites.filter(key => key.endsWith(':false')));
    }
    if (Object.keys(missing).length) await this.notion('data_sources/' + config.source, { properties: missing }, 'PATCH');
    const previousFavorites = await this.ctx.storage.get('notion-favorite-migration');
    if (previousFavorites) {
      const favorites = new Set(previousFavorites);
      let cursor;
      for (let page = 0; page < 100; page++) {
        const data = await this.notion(`data_sources/${config.source}/query`, { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
        for (const record of data.results) {
          if (!record.archived && !record.in_trash && !record.properties['색이 다름']?.checkbox &&
            favorites.has(normalizeSlug(plain(record.properties['폼 식별자'])) + ':false') && !record.properties['즐겨찾기']?.checkbox) {
            await this.notion('pages/' + record.id, { properties: { '즐겨찾기': { checkbox: true } } }, 'PATCH');
          }
        }
        if (!data.has_more) break;
        cursor = data.next_cursor;
        if (!cursor || page === 99) throw new ServiceError('기존 즐겨찾기 이동을 마치지 못했어요. 다시 연결해주세요.');
      }
      await this.ctx.storage.delete('notion-favorite-migration');
    }
    const updated = { ...config, schemaVersion: 3 };
    await this.ctx.storage.put('database', updated);
    return updated;
  }
  async ensureDatabase() {
    const existing = await this.ctx.storage.get('database');
    if (existing) return this.upgradeDatabase(existing);
    const parent = pageId(this.env.NOTION_PARENT_PAGE_ID);
    // 배포를 다시 하거나 DB 생성 응답을 놓친 경우, 기존 DB부터 찾습니다.
    let cursor;
    for (let page = 0; page < 10; page++) {
      const blocks = await this.notion(`blocks/${parent}/children?page_size=100${cursor ? '&start_cursor=' + encodeURIComponent(cursor) : ''}`);
      const found = blocks.results.find(block => block.type === 'child_database' && block.child_database.title === DB_TITLE);
      if (found) return this.saveDatabase(await this.notion('databases/' + found.id));
      if (!blocks.has_more) break;
      cursor = blocks.next_cursor;
      if (page === 9) throw new ServiceError('노션 페이지에 블록이 많아요. 별도의 빈 페이지를 연결해주세요.');
    }
    if (await this.ctx.storage.get('database-pending')) {
      throw new ServiceError('DB 생성 응답을 확인 중이에요. 노션 페이지에 DB가 생성됐는지 확인한 뒤 다시 연결해주세요.');
    }
    await this.ctx.storage.put('database-pending', true);
    try {
      const db = await this.notion('databases', {
        parent: { type: 'page_id', page_id: parent }, title: richText(DB_TITLE), is_inline: true,
        initial_data_source: { properties: collectionProperties }
      });
      return await this.saveDatabase(db, true);
    } catch (error) {
      if (!error.uncertain) await this.ctx.storage.delete('database-pending');
      throw error;
    }
  }
  toRecord(page) {
    const p = page.properties;
    const slug = normalizeSlug(plain(p['폼 식별자']));
    const entry = entries.get(slug);
    if (!entry) throw new ServiceError(`노션의 폼 식별자 '${slug}'를 확인해주세요.`, 400);
    const backgroundId = plain(p['배경 식별자']).trim();
    if (backgroundId && !backgroundCatalog.items[backgroundId]) throw new ServiceError(`노션의 배경 식별자 '${backgroundId}'를 확인해주세요.`, 400);
    const record = {
      id: page.id, pageId: page.id, slug, dexId: entry.dexId, name: plain(p['이름']) || entry.ko || entry.en, isShiny: false,
      favorite: Boolean(p['즐겨찾기']?.checkbox), backgroundId,
      capturedAt: page.created_time, imageSrc: `${remoteImages}/normal/${encodeURIComponent(slug)}.webp`
    };
    const background = backgroundFor(record);
    return { ...record, backgroundId: background?.id || '', backgroundName: background?.title || '', backgroundSrc: background ? new URL(background.path.slice(2), this.env.WIDGET_ORIGIN).href : '' };
  }
  async readRecords() {
    const config = await this.ensureDatabase();
    const records = [];
    let cursor;
    for (let page = 0; page < 100; page++) {
      const data = await this.notion(`data_sources/${config.source}/query`, { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
      records.push(...data.results.filter(page => !page.archived && !page.in_trash && !page.properties['색이 다름']?.checkbox).map(page => this.toRecord(page)));
      if (!data.has_more) return records.sort((a, b) => a.dexId - b.dexId);
      cursor = data.next_cursor;
      if (!cursor) throw new ServiceError('노션 목록의 다음 페이지를 확인하지 못했어요.');
    }
    throw new ServiceError('수집 기록이 너무 많아요. 노션 목록을 확인해주세요.');
  }
  async listAll(prefix) {
    const items = new Map();
    let startAfter;
    do {
      const batch = await this.ctx.storage.list({ prefix, limit: 1000, ...(startAfter ? { startAfter } : {}) });
      for (const [key, value] of batch) items.set(key, value);
      if (batch.size < 1000) break;
      startAfter = [...batch.keys()].at(-1);
    } while (startAfter);
    return items;
  }
  async ensureOwnedIndex() {
    if (await this.ctx.storage.get('owned-index-ready')) return;
    // 업데이트 이전의 기록도 중복 포획을 막되 기존 기록은 그대로 보존합니다.
    const requests = await this.listAll('request:');
    const index = {};
    for (const request of requests.values()) {
      const key = 'owned:' + captureKey(request.record);
      if (!index[key] || request.status === 'saved') index[key] = request;
    }
    const pairs = Object.entries(index);
    for (let offset = 0; offset < pairs.length; offset += 128) {
      await this.ctx.storage.put(Object.fromEntries(pairs.slice(offset, offset + 128)));
    }
    await this.ctx.storage.put('owned-index-ready', true);
  }
  async getSnapshot(url = new URL('https://widget/api/collection')) {
    await this.ensureOwnedIndex();
    const day = koreaDay();
    const reservations = await this.ctx.storage.list({ prefix: 'day:' + day + ':' });
    const allPending = await this.ctx.storage.list({ prefix: 'pending:' });
    const pending = [...allPending.values()].map(item => item.record);
    const used = [...reservations.values()].filter(r => r.status === 'saved').length;
    const owned = await this.listAll('owned:');
    const records = await this.readRecords();
    const data = { schemaVersion: 3, day, used, remaining: Math.max(0, 3 - reservations.size), pending, records: [],
      owned: [...owned.values()].filter(item => item.status === 'saved').map(item => captureKey(item.record)),
      preferences: { ...defaultPreferences, ...await this.ctx.storage.get('preferences'),
        favoritePokemon: [...new Set(records.filter(record => record.favorite).map(captureKey))] } };
    data.owned = [...new Set([...data.owned.filter(key => key.endsWith(':false')), ...records.map(captureKey)])];
    const requestId = url.searchParams.get('requestId');
    if (requestId && /^[0-9a-f-]{36}$/i.test(requestId)) {
      data.requestStatus = (await this.ctx.storage.get('request:' + requestId))?.status || 'missing';
    }
    if (url.searchParams.get('records') === '1') {
      data.records = records;
      data.nextCursor = null;
    }
    return data;
  }
  async capture(body) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.id || '') || body.isShiny !== false) {
      throw new ServiceError('수집 요청을 확인해주세요.', 400);
    }
    const slug = normalizeSlug(body.slug);
    const entry = entries.get(slug);
    if (!entry) throw new ServiceError('도감에 없는 포켓몬입니다.', 400);
    const config = await this.ensureDatabase();
    await this.ensureOwnedIndex();
    let request = await this.ctx.storage.get('request:' + body.id);
    if (request && (normalizeSlug(request.record.slug) !== slug || request.record.isShiny !== body.isShiny)) {
      throw new ServiceError('기존 포획과 다른 요청입니다.', 409);
    }
    if (request?.status === 'saved') return this.getSnapshot();
    if (request) {
      // 일반 개체의 폼은 한 번만 수집하므로, 불분명한 POST는 폼으로 확인하고 재전송하지 않습니다.
      const pages = await this.notion(`data_sources/${config.source}/query`, {
        page_size: 100, filter: { property: '폼 식별자', rich_text: { equals: slug } }
      });
      if (!pages.results.some(page => !page.archived && !page.in_trash && !page.properties['색이 다름']?.checkbox)) throw new ServiceError('노션 저장 결과를 확인 중이에요. 잠시 후 다시 확인해주세요.', 409);
      await this.commit(request);
      return this.getSnapshot();
    }
    const ownedKey = 'owned:' + captureKey({ slug, isShiny: body.isShiny });
    if (await this.ctx.storage.get(ownedKey)) {
      throw new ServiceError('이미 잡은 포켓몬이에요.', 409, false, 'ALREADY_COLLECTED');
    }
    const day = koreaDay();
    const reservations = await this.ctx.storage.list({ prefix: 'day:' + day + ':' });
    if (reservations.size >= 3) throw new ServiceError('오늘의 수집 기회를 모두 사용했어요.', 409, false, 'DAILY_LIMIT');
    const existingPages = await this.notion(`data_sources/${config.source}/query`, {
      page_size: 100, filter: { property: '폼 식별자', rich_text: { equals: slug } }
    });
    const existingPage = existingPages.results.find(page => !page.archived && !page.in_trash && !page.properties['색이 다름']?.checkbox);
    if (existingPage) {
      await this.ctx.storage.put(ownedKey, { status: 'saved', record: this.toRecord(existingPage) });
      throw new ServiceError('이미 잡은 포켓몬이에요.', 409, false, 'ALREADY_COLLECTED');
    }
    const background = backgroundFor(entry);
    const record = {
      id: body.id, slug, dexId: entry.dexId, name: entry.ko || entry.en, isShiny: body.isShiny,
      capturedAt: new Date().toISOString(), types: typeData.bySlug[entry.slug] || typeData.byDex[entry.dexId] || [],
      imageSrc: `${remoteImages}/${body.isShiny ? 'shiny' : 'normal'}/${encodeURIComponent(slug)}.webp`,
      backgroundId: background?.id || '', backgroundName: background?.title || '',
      backgroundSrc: background ? new URL(background.path.slice(2), this.env.WIDGET_ORIGIN).href : ''
    };
    request = { day, status: 'pending', record };
    // 네트워크 요청 전에 영구 예약. 재시작/동시 요청에도 하루 한도를 지킵니다.
    await this.ctx.storage.put({ ['request:' + body.id]: request, ['day:' + day + ':' + body.id]: request, ['pending:' + body.id]: request, [ownedKey]: request });
    try {
      await this.notion('pages', {
        parent: { type: 'data_source_id', data_source_id: config.source },
        properties: {
          '이름': { title: richText(record.name) }, '폼 식별자': { rich_text: richText(slug) },
          '배경 식별자': { rich_text: richText(record.backgroundId) }, '즐겨찾기': { checkbox: false }
        }
      });
    } catch (error) {
      if (error instanceof ServiceError && !error.uncertain) {
        await this.ctx.storage.delete(['request:' + body.id, 'day:' + day + ':' + body.id, 'pending:' + body.id, ownedKey]);
      }
      throw error;
    }
    // 저장 후 목록 조회 실패는 이미 완료한 포획과 사용한 기회를 취소하지 않습니다.
    await this.commit(request);
    return this.getSnapshot();
  }
  async commit(request) {
    const complete = { ...request, status: 'saved' };
    await this.ctx.storage.put({ ['request:' + request.record.id]: complete, ['day:' + request.day + ':' + request.record.id]: complete, ['owned:' + captureKey(request.record)]: complete });
    await this.ctx.storage.delete('pending:' + request.record.id);
  }
  async savePreferences(body) {
    if (!body || !['draw', 'sleep'].includes(body.mode) || typeof body.pokemonKey !== 'string' || typeof body.backgroundId !== 'string' || body.pokemonKey.length > 160 || body.backgroundId.length > 160) throw new ServiceError('화면 설정을 확인해주세요.', 400);
    const records = await this.readRecords();
    const current = { ...defaultPreferences, ...await this.ctx.storage.get('preferences'),
      favoritePokemon: [...new Set(records.filter(record => record.favorite).map(captureKey))] };
    let favoritePokemon = body.favoritePokemon === undefined ? current.favoritePokemon : body.favoritePokemon;
    if (body.favoriteChange) {
      const { pokemonKey, favorite } = body.favoriteChange;
      if (typeof favorite !== 'boolean' || !records.some(record => captureKey(record) === pokemonKey)) throw new ServiceError('즐겨찾기 설정을 확인해주세요.', 400);
      const favorites = new Set(current.favoritePokemon);
      favorite ? favorites.add(pokemonKey) : favorites.delete(pokemonKey);
      favoritePokemon = [...favorites];
    }
    const favoriteBackgrounds = body.favoriteBackgrounds === undefined ? current.favoriteBackgrounds : body.favoriteBackgrounds;
    for (const values of [favoritePokemon, favoriteBackgrounds]) {
      if (!Array.isArray(values) || values.length > 3000 || values.some(value => typeof value !== 'string' || !value || value.length > 160)) throw new ServiceError('즐겨찾기 설정을 확인해주세요.', 400);
    }
    if (body.pokemonKey && !records.some(record => captureKey(record) === body.pokemonKey)) throw new ServiceError('수집한 포켓몬만 선택할 수 있어요.', 400);
    if (body.backgroundId && !records.some(record => record.backgroundId === body.backgroundId)) throw new ServiceError('수집한 배경만 선택할 수 있어요.', 400);
    const ownedPokemon = new Set(records.map(captureKey));
    const ownedBackgrounds = new Set(records.map(record => record.backgroundId).filter(Boolean));
    if (favoritePokemon.some(key => !ownedPokemon.has(key) && !current.favoritePokemon.includes(key))) throw new ServiceError('수집한 포켓몬만 즐겨찾기에 추가할 수 있어요.', 400);
    if (favoriteBackgrounds.some(id => !ownedBackgrounds.has(id) && !current.favoriteBackgrounds.includes(id))) throw new ServiceError('수집한 배경만 즐겨찾기에 추가할 수 있어요.', 400);
    const preferences = { mode: body.mode, pokemonKey: body.pokemonKey, backgroundId: body.backgroundId,
      favoritePokemon: [...new Set(favoritePokemon)].filter(key => ownedPokemon.has(key)),
      favoriteBackgrounds: [...new Set(favoriteBackgrounds)].filter(id => ownedBackgrounds.has(id)) };
    const favorites = new Set(preferences.favoritePokemon);
    for (const record of records) {
      const favorite = favorites.has(captureKey(record));
      if (favorite !== record.favorite) await this.notion('pages/' + record.pageId, { properties: { '즐겨찾기': { checkbox: favorite } } }, 'PATCH');
    }
    await this.ctx.storage.put('preferences', preferences);
    return { schemaVersion: 3, preferences };
  }
}
