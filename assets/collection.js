(function (root) {
  'use strict';
  const LIMIT = 3;
  const LOCAL_KEY = 'pokemon-collection-preview-v1';
  const PREFERENCES_KEY = 'pokemon-widget-preferences-v1';
  const DEFAULT_PREFERENCES = { mode: 'draw', pokemonKey: '', backgroundId: '', favoritePokemon: [], favoriteBackgrounds: [] };
  let backgroundCatalog = { byType: {}, bySlug: {}, items: {} }, backgroundTypes = { bySlug: {}, byDex: {} };
  function configureBackgrounds(catalog, types) { backgroundCatalog = catalog; backgroundTypes = types; }
  function backgroundFor(record) {
    if (record.backgroundId) return backgroundCatalog.items[record.backgroundId] || null;
    const slug = normalizeSlug(record.slug);
    const types = backgroundTypes.bySlug[slug] || backgroundTypes.byDex[record.dexId] || record.types || [];
    const id = backgroundCatalog.bySlug[slug] || types.map(type => backgroundCatalog.byType[type]).find(Boolean);
    return backgroundCatalog.items[id] || null;
  }
  function koreaDay(time = Date.now()) {
    return new Date(new Date(time).getTime() + 9 * 3600000).toISOString().slice(0, 10);
  }
  function normalizeSlug(slug) {
    return String(slug).replace(/^mr[.-]+mime$/i, 'mr-mime').replace(/farfetch['’]d/gi, 'farfetchd')
      .replace(/^nidoran♀$/i, 'nidoran-f').replace(/^nidoran♂$/i, 'nidoran-m');
  }
  const captureKey = record => normalizeSlug(record.slug) + ':' + Boolean(record.isShiny);
  function normalizeWorkerUrl(value) {
    let url;
    try { url = new URL(String(value || '').trim()); } catch { throw new Error('연결 설정에서 개인 Worker 주소를 입력해주세요.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('개인 Worker의 HTTPS 주소만 입력해주세요. 예: https://나의주소.workers.dev');
    }
    return url.origin;
  }
  function snapshot(records, day = koreaDay()) {
    const used = records.filter(record => koreaDay(record.capturedAt) === day).length;
    return { schemaVersion: 3, records, day, used, remaining: Math.max(0, LIMIT - used), pending: [], owned: [...new Set(records.map(captureKey))] };
  }
  class LocalStore {
    constructor(storage) { this.storage = storage; }
    read() {
      const raw = this.storage.getItem(LOCAL_KEY);
      if (!raw) return [];
      const records = JSON.parse(raw);
      if (!Array.isArray(records) || records.some(r => !r.id || !r.slug || !Number.isFinite(Date.parse(r.capturedAt)))) {
        throw new Error('미리보기 기록을 읽지 못했어요. 저장된 데이터를 확인해주세요.');
      }
      const legacyFavorites = new Set(JSON.parse(this.storage.getItem(PREFERENCES_KEY) || '{}').favoritePokemon || []);
      return records.filter(record => !record.isShiny).map(record => ({ ...record, isShiny: false,
        favorite: typeof record.favorite === 'boolean' ? record.favorite : legacyFavorites.has(captureKey(record)) }));
    }
    async getSnapshot() {
      const data = snapshot(this.read());
      data.preferences = { ...DEFAULT_PREFERENCES, ...JSON.parse(this.storage.getItem(PREFERENCES_KEY) || '{}') };
      data.preferences.favoritePokemon = [...new Set(data.records.filter(record => record.favorite).map(captureKey))];
      return data;
    }
    async savePreferences(preferences) {
      if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) throw new Error('화면 설정을 확인해주세요.');
      const records = this.read();
      const current = (await this.getSnapshot()).preferences;
      const next = { ...DEFAULT_PREFERENCES, ...current, ...preferences };
      if (preferences.favoriteChange) {
        const { pokemonKey, favorite } = preferences.favoriteChange;
        if (typeof favorite !== 'boolean' || !records.some(record => captureKey(record) === pokemonKey)) throw new Error('즐겨찾기 설정을 확인해주세요.');
        const favorites = new Set(current.favoritePokemon);
        favorite ? favorites.add(pokemonKey) : favorites.delete(pokemonKey);
        next.favoritePokemon = [...favorites];
      }
      delete next.favoriteChange;
      validatePreferences(next, records, current);
      next.favoritePokemon = [...new Set(next.favoritePokemon)].filter(key => records.some(record => captureKey(record) === key));
      next.favoriteBackgrounds = [...new Set(next.favoriteBackgrounds)].filter(id => records.some(record => backgroundFor(record)?.id === id));
      const previousRecords = this.storage.getItem(LOCAL_KEY);
      const previousPreferences = this.storage.getItem(PREFERENCES_KEY);
      try {
        this.storage.setItem(LOCAL_KEY, JSON.stringify(records.map(record => ({ ...record, favorite: next.favoritePokemon.includes(captureKey(record)) }))));
        this.storage.setItem(PREFERENCES_KEY, JSON.stringify(next));
      } catch (error) {
        try { this.storage.setItem(LOCAL_KEY, previousRecords || '[]'); this.storage.setItem(PREFERENCES_KEY, previousPreferences || '{}'); } catch {}
        throw error;
      }
      return { schemaVersion: 3, preferences: next };
    }
    async capture(record) {
      if (record.isShiny !== false) throw new Error('일반 포켓몬만 수집할 수 있어요.');
      const save = async () => {
        const records = this.read();
        if (records.some(r => r.id === record.id)) return this.getSnapshot();
        if (records.some(r => captureKey(r) === captureKey(record))) {
          throw Object.assign(new Error('이미 잡은 포켓몬이에요.'), { code: 'ALREADY_COLLECTED' });
        }
        if (!snapshot(records).remaining) throw Object.assign(new Error('오늘의 수집 기회를 모두 사용했어요.'), { code: 'DAILY_LIMIT' });
        const next = [...records, { ...record, favorite: false, slug: normalizeSlug(record.slug), capturedAt: new Date().toISOString() }];
        // 저장 실패 시에는 횟수를 차감하거나 성공을 표시하지 않습니다.
        this.storage.setItem(LOCAL_KEY, JSON.stringify(next));
        return this.getSnapshot();
      };
      return root.navigator?.locks ? root.navigator.locks.request(LOCAL_KEY, save) : save();
    }
  }
  class RemoteStore {
    constructor(workerUrl, legacyWorkerUrl) {
      // 이전 두 인자 호출도 주소만 사용합니다. 별도의 위젯 토큰은 사용하지 않습니다.
      workerUrl = legacyWorkerUrl || workerUrl;
      try { this.workerUrl = normalizeWorkerUrl(workerUrl); } catch (error) { this.configurationError = error; }
      this.pendingKey = crypto.subtle.digest('SHA-256', new TextEncoder().encode(this.workerUrl || '')).then(bytes =>
        'pokemon-pending-' + [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join(''));
    }
    async pending() {
      try { return JSON.parse(localStorage.getItem(await this.pendingKey) || 'null'); } catch { return null; }
    }
    async request(path, body) {
      if (this.configurationError) throw this.configurationError;
      let response;
      try {
        response = await fetch(this.workerUrl + path, {
          method: body ? 'POST' : 'GET', credentials: 'omit', cache: 'no-store',
          headers: body ? { 'Content-Type': 'application/json' } : {},
          body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(25000)
        });
      } catch { throw new Error('개인 Worker에 연결하지 못했어요. 주소와 Worker의 WIDGET_ORIGIN 설정을 확인해주세요.'); }
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw Object.assign(new Error(data.error || '노션 연결을 확인해주세요.'), { code: data.code });
      return data;
    }
    async getSnapshot(all = false) {
      const pending = await this.pending();
      const params = new URLSearchParams();
      if (all) params.set('records', '1');
      if (pending) params.set('requestId', pending.id);
      let data = await this.request('/api/collection?' + params);
      if (pending && data.requestStatus === 'saved') {
        try { localStorage.removeItem(await this.pendingKey); } catch {}
      } else if (pending && !data.pending.some(r => r.id === pending.id)) {
        data.pending.push(pending);
      }
      if (!all) return data;
      const records = [...data.records];
      let cursor = data.nextCursor;
      let pages = 1;
      while (cursor) {
        if (++pages > 100) throw new Error('기록이 많아 도감을 불러오지 못했어요. 노션에서 확인해주세요.');
        const next = await this.request('/api/collection?records=1&cursor=' + encodeURIComponent(cursor));
        records.push(...next.records);
        cursor = next.nextCursor;
      }
      return { ...data, records };
    }
    async capture(record) {
      try { localStorage.setItem(await this.pendingKey, JSON.stringify(record)); } catch {}
      try {
        const data = await this.request('/api/capture', record);
        try { localStorage.removeItem(await this.pendingKey); } catch {}
        return data;
      } catch (error) {
        if (['ALREADY_COLLECTED', 'DAILY_LIMIT'].includes(error.code)) {
          try { localStorage.removeItem(await this.pendingKey); } catch {}
        }
        throw error;
      }
    }
    async savePreferences(preferences) { return this.request('/api/preferences', preferences); }
  }
  function validatePreferences(preferences, records, current = DEFAULT_PREFERENCES) {
    if (!preferences || !['draw', 'sleep'].includes(preferences.mode) || typeof preferences.pokemonKey !== 'string' || typeof preferences.backgroundId !== 'string') throw new Error('화면 설정을 확인해주세요.');
    if (preferences.pokemonKey && !records.some(record => captureKey(record) === preferences.pokemonKey)) throw new Error('수집한 포켓몬만 선택할 수 있어요.');
    if (preferences.backgroundId && !records.some(record => backgroundFor(record)?.id === preferences.backgroundId)) throw new Error('수집한 배경만 선택할 수 있어요.');
    for (const [field, owned, label] of [
      ['favoritePokemon', new Set(records.map(captureKey)), '포켓몬'],
      ['favoriteBackgrounds', new Set(records.map(record => backgroundFor(record)?.id).filter(Boolean)), '배경']
    ]) {
      const values = preferences[field] === undefined ? [] : preferences[field];
      if (!Array.isArray(values) || values.length > 3000 || values.some(value => typeof value !== 'string' || !value || value.length > 160)) throw new Error('즐겨찾기 설정을 확인해주세요.');
      if (values.some(value => !owned.has(value) && !(current[field] || []).includes(value))) throw new Error('수집한 ' + label + '만 즐겨찾기에 추가할 수 있어요.');
    }
  }
  root.PokemonCollection = { LIMIT, DEFAULT_PREFERENCES, configureBackgrounds, backgroundFor, validatePreferences, koreaDay, normalizeSlug, captureKey, normalizeWorkerUrl, LocalStore, RemoteStore };
  if (typeof module !== 'undefined') module.exports = root.PokemonCollection;
})(globalThis);
