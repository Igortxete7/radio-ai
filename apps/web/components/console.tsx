'use client';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  AudioLines,
  Radio,
  ListMusic,
  Library,
  Mic2,
  CalendarClock,
  Rss,
  History,
  Activity,
  Settings2,
  RefreshCw,
  SkipForward,
  LogOut,
  Play,
  Trash2,
  Search,
  Check,
  Pencil,
  LoaderCircle,
} from 'lucide-react';
import { Button } from './button';
import { Confirm } from './confirm';
type Row = Record<string, unknown>;
const object = (v: unknown): Row =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : {};
const list = (v: unknown): Row[] =>
  Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as Row[]) : [];
const text = (v: unknown, fallback = '—') =>
  v === undefined || v === null || v === '' ? fallback : String(v);
const date = (v: unknown) => {
  if (!v) return '—';
  const d = new Date(String(v));
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleString('es-ES', {
        timeZone: 'Europe/Madrid',
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
};
const duration = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n)
    ? `${Math.floor(n / 60)}:${String(Math.round(n % 60)).padStart(2, '0')}`
    : '—';
};
const states: Record<string, string> = {
  PLANNED: 'Planificada',
  GENERATING_CONTEXT: 'Preparando contexto',
  GENERATING_SCRIPT: 'Redactando',
  GENERATING_AUDIO: 'Generando audio',
  READY: 'Preparada',
  ENQUEUED: 'En cola',
  PLAYED: 'Emitida',
  FAILED: 'Error',
  CANCELLED: 'Cancelada',
  EXPIRED: 'Caducada',
  PUSHING: 'Enviando',
  UNCERTAIN: 'Pendiente de confirmación',
  CANCEL_REQUESTED: 'Retirando',
  ABANDONED: 'Abandonada',
  PENDING: 'Pendiente',
  PLAYING: 'Sonando',
  COMPLETED: 'Completada',
  REMOVED: 'Retirada',
  live: 'En directo',
  degraded: 'Degradado',
  offline: 'Sin emisión',
  unknown: 'Sin confirmar',
};
const names: Record<string, string> = {
  track: 'Canción',
  jingle: 'Jingle',
  ai_break: 'DJ IA',
  fallback: 'Continuidad',
  hourly: 'Horaria',
  weather: 'Tiempo',
  news: 'Actualidad',
  ident: 'Identificación',
  'music-link': 'Enlace musical',
};
const sections = [
  ['live', 'En directo', Radio],
  ['queue', 'Cola', ListMusic],
  ['library', 'Biblioteca', Library],
  ['dj', 'DJ IA', Mic2],
  ['schedule', 'Programación', CalendarClock],
  ['sources', 'Fuentes', Rss],
  ['history', 'Historial', History],
  ['system', 'Sistema', Activity],
  ['settings', 'Configuración', Settings2],
] as const;
type View = (typeof sections)[number][0];
async function api(endpoint: string, method = 'GET', value?: unknown, signal?: AbortSignal) {
  const result = await fetch(`/api/${endpoint}`, {
    method,
    headers: value === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: value === undefined ? undefined : JSON.stringify(value),
    cache: 'no-store',
    signal,
  });
  const body = await result.json();
  if (!result.ok || body.error)
    throw new Error(body.error?.message ?? 'No se pudo contactar con el servidor.');
  return body.data as unknown;
}
function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty">{children}</div>;
}
function Status({ value }: { value: unknown }) {
  const v = String(value ?? 'offline');
  return (
    <span
      className={`status ${['live', 'READY', 'ENQUEUED', 'PLAYING', 'PLAYED', 'COMPLETED'].includes(v) ? 'status-good' : v === 'FAILED' || v === 'offline' ? 'status-bad' : 'status-neutral'}`}
    >
      {states[v] ?? v}
    </span>
  );
}
function Events({ items }: { items: Row[] }) {
  return items.length ? (
    <div className="timeline">
      {items.map((item, i) => (
        <div className="timeline-row" key={text(item.id, i.toString())}>
          <time>{date(item.startedAt ?? item.timestamp)}</time>
          <div>
            <strong>{text(item.title ?? item.event)}</strong>
            <span>{text(item.artist ?? item.type, '')}</span>
          </div>
          <Status value={item.status ?? item.level} />
        </div>
      ))}
    </div>
  ) : (
    <Empty>El historial aparecerá cuando Liquidsoap confirme la primera reproducción.</Empty>
  );
}

export function Console() {
  const requestVersion = useRef(0);
  const currentRequest = useRef<AbortController | null>(null);
  const latestLoad = useRef<(() => Promise<void>) | null>(null);
  const [session, setSession] = useState<'loading' | 'anonymous' | 'ready'>('loading');
  const [configured, setConfigured] = useState(true);
  const [token, setToken] = useState('');
  const [view, setView] = useState<View>('live');
  const [data, setData] = useState<Row>({});
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [edit, setEdit] = useState<Row | null>(null);
  const [preview, setPreview] = useState<Row | null>(null);
  const [ttsText, setTtsText] = useState(
    'Hola, estás escuchando Radio AI. Esta voz está generada por inteligencia artificial.',
  );
  const [sample, setSample] = useState('');
  const [settings, setSettings] = useState<Row>({});
  const [sourcesJson, setSourcesJson] = useState('[]');
  const [confirm, setConfirm] = useState<{
    title: string;
    description: string;
    run: () => void;
  } | null>(null);
  useEffect(() => {
    const initial = new URLSearchParams(window.location.search).get('view');
    if (sections.some((x) => x[0] === initial)) setView(initial as View);
    api('session')
      .then((v) => {
        const s = object(v);
        setConfigured(s.configured === true);
        setSession(s.authenticated ? 'ready' : 'anonymous');
      })
      .catch(() => {
        setSession('anonymous');
        setNotice({ error: true, text: 'No se pudo comprobar la sesión. Recarga la página.' });
      });
  }, []);
  const load = useCallback(async () => {
    if (session !== 'ready') return;
    const version = ++requestVersion.current;
    currentRequest.current?.abort();
    const controller = new AbortController();
    currentRequest.current = controller;
    setLoading(true);
    try {
      const endpoints =
        view === 'live'
          ? ['health', 'now-playing', 'queue']
          : view === 'queue'
            ? ['queue']
            : view === 'library'
              ? [
                  `tracks?search=${encodeURIComponent(search)}&page=${page}${filter === 'all' ? '' : `&enabled=${filter === 'enabled'}`}`,
                ]
              : view === 'dj'
                ? ['settings', 'ai-breaks']
                : view === 'schedule'
                  ? ['settings', 'ai-breaks']
                  : view === 'sources'
                    ? ['sources/status', 'settings']
                    : view === 'history'
                      ? ['history']
                      : view === 'system'
                        ? ['system', 'health']
                        : ['settings'];
      const results = await Promise.allSettled(
        endpoints.map(
          async (endpoint) =>
            [
              endpoint.split('?')[0],
              await api(endpoint, 'GET', undefined, controller.signal),
            ] as const,
        ),
      );
      if (version !== requestVersion.current || controller.signal.aborted) return;
      const successful = results.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : [],
      );
      setData(Object.fromEntries(successful));
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') {
        setNotice({
          error: true,
          text:
            failed.reason instanceof Error
              ? failed.reason.message
              : 'No se pudieron cargar algunos datos. Actualiza el panel.',
        });
      }
      const s = successful.find((v) => v[0] === 'settings');
      if (s) {
        const values = object(s[1]);
        setSettings(values);
        setSourcesJson(JSON.stringify(values.newsSources ?? [], null, 2));
      }
    } catch (error) {
      if (version !== requestVersion.current || controller.signal.aborted) return;
      setNotice({
        error: true,
        text: error instanceof Error ? error.message : 'Error al cargar el panel.',
      });
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }, [session, view, search, filter, page]);
  useEffect(() => {
    latestLoad.current = load;
  }, [load]);
  useEffect(() => {
    const timer = setTimeout(
      () => {
        void load();
      },
      search ? 300 : 0,
    );
    return () => {
      clearTimeout(timer);
      requestVersion.current++;
      currentRequest.current?.abort();
    };
  }, [load, search]);
  useEffect(() => {
    if (session !== 'ready' || !['live', 'queue', 'system', 'history'].includes(view)) return;
    const timer = setInterval(() => {
      void load();
    }, 10000);
    return () => clearInterval(timer);
  }, [load, session, view]);
  async function action(label: string, endpoint: string, method = 'POST', value?: unknown) {
    setBusy(label);
    setNotice(null);
    try {
      const result = await api(endpoint, method, value);
      const row = object(result);
      if (row.status === 'FAILED')
        throw new Error(`La intervención ha fallado: ${text(row.errorCode)}. La música continúa.`);
      setNotice({ error: false, text: `${label}: operación completada.` });
      await latestLoad.current?.();
      return result;
    } catch (error) {
      setNotice({
        error: true,
        text: error instanceof Error ? error.message : 'No se pudo completar la operación.',
      });
      return null;
    } finally {
      setBusy('');
    }
  }
  async function login(event: FormEvent) {
    event.preventDefault();
    setBusy('Acceder');
    try {
      await api('login', 'POST', { token });
      setToken('');
      setNotice(null);
      setSession('ready');
    } catch (error) {
      setNotice({
        error: true,
        text: error instanceof Error ? error.message : 'No se pudo acceder.',
      });
    } finally {
      setBusy('');
    }
  }
  const switchView = (v: View) => {
    requestVersion.current++;
    currentRequest.current?.abort();
    setLoading(false);
    setView(v);
    setData({});
    setNotice(null);
    setEdit(null);
    window.history.replaceState(null, '', `/?view=${v}`);
  };
  const saveSettings = async (event: FormEvent) => {
    event.preventDefault();
    const allowed =
      view === 'dj'
        ? ['persona', 'textModel', 'ttsModel', 'ttsVoice', 'djTargetSeconds']
        : view === 'schedule'
          ? [
              'djHourlyEnabled',
              'trackRepeatHours',
              'artistRepeatMinutes',
              'jingleMinTracks',
              'jingleMaxTracks',
            ]
          : view === 'sources'
            ? ['weatherEnabled', 'newsEnabled']
            : ['stationName'];
    const patch = Object.fromEntries(
      allowed.map((k) => [k, settings[k]]).filter((v) => v[1] !== undefined),
    );
    if (view === 'sources') {
      try {
        patch.newsSources = JSON.parse(sourcesJson);
      } catch {
        setNotice({ error: true, text: 'La lista de fuentes no es JSON válido.' });
        return;
      }
    }
    await action('Guardar configuración', 'settings', 'PATCH', patch);
  };
  const input = (key: string, label: string, type = 'text') => (
    <label key={key}>
      {label}
      <input
        type={type}
        value={text(settings[key], '')}
        onChange={(e) =>
          setSettings({
            ...settings,
            [key]: type === 'number' ? Number(e.target.value) : e.target.value,
          })
        }
      />
    </label>
  );
  const toggle = (key: string, label: string) => (
    <label className="checkbox" key={key}>
      <input
        type="checkbox"
        checked={settings[key] === true}
        onChange={(e) => setSettings({ ...settings, [key]: e.target.checked })}
      />
      {label}
    </label>
  );
  if (session === 'loading')
    return (
      <main className="login">
        <LoaderCircle className="spin" />
        <p>Comprobando sesión…</p>
      </main>
    );
  if (session === 'anonymous')
    return (
      <main className="login">
        <form className="login-form" onSubmit={login}>
          <AudioLines size={36} />
          <h1>Radio AI</h1>
          <p>Control de emisión</p>
          {configured ? (
            <>
              <label>
                Token de administración
                <input
                  type="password"
                  autoComplete="current-password"
                  required
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                />
              </label>
              <p className="muted">El token está en ADMIN_TOKEN del archivo .env local.</p>
              <Button disabled={!!busy}>{busy || 'Acceder al panel'}</Button>
            </>
          ) : (
            <div className="notice notice-error">
              Falta ADMIN_TOKEN. Ejecuta <code>npm run env:init</code> y reinicia el servidor.
            </div>
          )}
          {notice && (
            <p className="notice notice-error" role="alert">
              {notice.text}
            </p>
          )}
          <small>La voz del DJ está generada por inteligencia artificial.</small>
        </form>
      </main>
    );
  const health = object(data.health),
    now = object(data['now-playing']),
    current = object(now.current),
    next = object(now.next),
    tracks = object(data.tracks),
    system = object(data.system),
    sources = object(data['sources/status']);
  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="Radio AI inicio">
          <AudioLines size={27} />
          <span>Radio AI</span>
        </a>
        <nav aria-label="Secciones de administración">
          {sections.map(([id, label, Icon]) => (
            <button
              key={id}
              className={view === id ? 'nav-item active' : 'nav-item'}
              onClick={() => switchView(id)}
              aria-current={view === id ? 'page' : undefined}
            >
              <Icon size={18} />
              {label}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span>Emisión automatizada</span>
          <small>Europe/Madrid</small>
          <button
            onClick={async () => {
              await api('logout', 'POST');
              setSession('anonymous');
            }}
          >
            <LogOut size={16} />
            Cerrar sesión
          </button>
        </div>
      </aside>
      <main className="main">
        <header className="page-header">
          <div>
            <h1>{sections.find((x) => x[0] === view)?.[1]}</h1>
            <p>
              {view === 'live'
                ? 'Tu emisora, de un vistazo.'
                : view === 'library'
                  ? 'El catálogo que mantiene la radio en antena.'
                  : view === 'dj'
                    ? 'Una voz propia, con fuentes verificables.'
                    : view === 'queue'
                      ? 'Próximas canciones e intervenciones.'
                      : view === 'sources'
                        ? 'Información reciente para cada intervención.'
                        : view === 'system'
                          ? 'Estado real y señales para actuar.'
                          : view === 'history'
                            ? 'Registro confirmado de lo que ha sonado.'
                            : view === 'schedule'
                              ? 'Reglas musicales e intervenciones horarias.'
                              : 'Preferencias de la emisora.'}
            </p>
          </div>
          <Button variant="secondary" onClick={() => void load()} disabled={loading || !!busy}>
            <RefreshCw size={16} className={loading ? 'spin' : ''} />
            {loading ? 'Actualizando' : 'Actualizar'}
          </Button>
        </header>
        {notice && (
          <div
            role={notice.error ? 'alert' : 'status'}
            className={`notice ${notice.error ? 'notice-error' : 'notice-success'}`}
          >
            {notice.text}
            <button aria-label="Cerrar mensaje" onClick={() => setNotice(null)}>
              ×
            </button>
          </div>
        )}
        {busy && (
          <div className="working" role="status">
            <LoaderCircle size={16} className="spin" />
            {busy}…
          </div>
        )}
        {view === 'live' && (
          <>
            <section className="on-air">
              <div className="player-top">
                <Status value={health.status ?? 'unknown'} />
                <span>MP3 · 128 kbps · estéreo</span>
              </div>
              <div className="now-playing">
                <div className="record-mark">
                  <Radio size={42} />
                </div>
                <div>
                  <span className="muted">Ahora suena</span>
                  <h2>{text(current.title, 'Esperando señal de Liquidsoap')}</h2>
                  <p>{text(current.artist, 'Añade música y arranca los servicios de radio.')}</p>
                  <small>
                    {current.startedAt
                      ? `Desde ${date(current.startedAt)} · ${current.confidence === 'stale' ? 'Último estado conocido' : 'Confirmado por el motor de audio'}`
                      : 'Todavía no hay un evento de reproducción confirmado.'}
                  </small>
                </div>
              </div>
              <audio
                controls
                preload="none"
                src={text(health.streamUrl, 'http://localhost:8000/radio.mp3')}
                aria-label="Escuchar la emisión"
              />
              <div className="player-bottom">
                <p>La voz del DJ está generada por inteligencia artificial.</p>
                <Button
                  variant="secondary"
                  disabled={!!busy}
                  onClick={() =>
                    setConfirm({
                      title: '¿Saltar el audio actual?',
                      description:
                        'Los oyentes pasarán al siguiente elemento. Esta acción afecta a la emisión en directo.',
                      run: () => void action('Saltar audio', 'queue/skip'),
                    })
                  }
                >
                  <SkipForward size={16} />
                  Saltar
                </Button>
              </div>
            </section>
            <div className="live-columns">
              <section>
                <h2>En programación</h2>
                <dl className="definition">
                  <div>
                    <dt>Siguiente</dt>
                    <dd>
                      {text(next.title, 'Sin elemento confirmado')}
                      <small>{text(next.artist, '')}</small>
                    </dd>
                  </div>
                  <div>
                    <dt>Último DJ</dt>
                    <dd>
                      {date(object(now.lastBreak).scheduledFor)}
                      {!!object(now.lastBreak).status && (
                        <Status value={object(now.lastBreak).status} />
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Próxima intervención</dt>
                    <dd>{date(object(now.nextBreak).scheduledFor)}</dd>
                  </div>
                  <div>
                    <dt>Cola preparada</dt>
                    <dd>
                      {Array.isArray(data.queue)
                        ? `${data.queue.length} elementos`
                        : 'Sin confirmar'}
                    </dd>
                  </div>
                </dl>
                <div className="actions wrap">
                  <Button
                    disabled={!!busy}
                    onClick={() => void action('Generar DJ', 'ai-breaks/generate', 'POST', {})}
                  >
                    <Mic2 size={16} />
                    Generar DJ
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={!!busy}
                    onClick={() => void action('Escanear biblioteca', 'library/scan')}
                  >
                    <RefreshCw size={16} />
                    Escanear
                  </Button>
                </div>
              </section>
              <section>
                <h2>Salud de componentes</h2>
                <div className="health-list">
                  {Object.entries(object(health.checks)).map(([name, value]) => {
                    const v = object(value);
                    return (
                      <div key={name}>
                        <span>
                          <i className={v.ok ? 'dot good' : 'dot bad'} />
                          {(
                            {
                              database: 'Base de datos',
                              library: 'Biblioteca',
                              liquidsoap: 'Liquidsoap',
                              icecast: 'Icecast',
                              worker: 'Worker',
                              openai: 'OpenAI',
                              weather: 'Meteorología',
                              news: 'Noticias',
                            } as Record<string, string>
                          )[name] ?? name}
                        </span>
                        <small>{text(v.detail, v.ok ? 'Disponible' : 'Revisar')}</small>
                      </div>
                    );
                  })}
                </div>
              </section>
            </div>
            <section className="section">
              <h2>Últimos eventos</h2>
              <Events items={list(now.events).slice(0, 10)} />
            </section>
          </>
        )}
        {view === 'queue' && (
          <section>
            {list(data.queue).length ? (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Contenido</th>
                      <th>Tipo</th>
                      <th>Prioridad</th>
                      <th>Estado</th>
                      <th>Programado</th>
                      <th>Acción</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list(data.queue).map((row) => (
                      <tr key={text(row.id)}>
                        <td>
                          <strong>{text(row.title)}</strong>
                          <small>{text(row.artist, '')}</small>
                        </td>
                        <td>{names[text(row.type)] ?? text(row.type)}</td>
                        <td>{text(row.priority)}</td>
                        <td>
                          <Status value={row.state} />
                        </td>
                        <td>{date(row.scheduledFor)}</td>
                        <td>
                          <Button
                            variant="ghost"
                            disabled={!!busy}
                            onClick={() =>
                              setConfirm({
                                title: '¿Retirar este elemento?',
                                description: `Se retirará «${text(row.title)}» de la cola.`,
                                run: () =>
                                  void action('Retirar de cola', `queue/${row.id}`, 'DELETE'),
                              })
                            }
                          >
                            <Trash2 size={16} />
                            Retirar
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty>
                La cola está vacía. Arranca el worker o añade una canción desde Biblioteca.
              </Empty>
            )}
          </section>
        )}
        {view === 'library' && (
          <>
            <div className="toolbar">
              <label className="search">
                <Search size={17} />
                <input
                  aria-label="Buscar canciones"
                  placeholder="Buscar título o artista"
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPage(1);
                  }}
                />
              </label>
              <select
                aria-label="Filtrar biblioteca"
                value={filter}
                onChange={(e) => {
                  setFilter(e.target.value);
                  setPage(1);
                }}
              >
                <option value="all">Todas las pistas</option>
                <option value="enabled">Habilitadas</option>
                <option value="disabled">Deshabilitadas</option>
              </select>
              <Button
                disabled={!!busy}
                onClick={() => void action('Escanear biblioteca', 'library/scan')}
              >
                <RefreshCw size={16} />
                Reescanear
              </Button>
            </div>
            {list(tracks.items).length ? (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Canción / artista</th>
                      <th>Duración</th>
                      <th>Última emisión</th>
                      <th>Usos</th>
                      <th>Estado</th>
                      <th>Acciones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list(tracks.items).map((row) => (
                      <tr key={text(row.id)}>
                        <td>
                          <strong>{text(row.title)}</strong>
                          <small>{text(row.artist)}</small>
                        </td>
                        <td>{duration(row.durationSec)}</td>
                        <td>{date(row.lastPlayedAt)}</td>
                        <td>{text(row.playCount, '0')}</td>
                        <td>
                          {row.missing ? (
                            <span className="status status-bad">Archivo ausente</span>
                          ) : (
                            <button
                              className="toggle"
                              disabled={!!busy}
                              onClick={() =>
                                void action('Cambiar estado', `tracks/${row.id}`, 'PATCH', {
                                  enabled: !row.enabled,
                                })
                              }
                            >
                              {row.enabled ? 'Habilitada' : 'Deshabilitada'}
                            </button>
                          )}
                        </td>
                        <td>
                          <div className="actions">
                            <Button
                              variant="ghost"
                              disabled={!!busy}
                              aria-label={`Editar ${text(row.title)}`}
                              onClick={() => setEdit({ ...row })}
                            >
                              <Pencil size={16} />
                            </Button>
                            <Button
                              variant="ghost"
                              disabled={!!busy || !row.enabled || !!row.missing}
                              aria-label={`Encolar ${text(row.title)}`}
                              onClick={() =>
                                void action('Encolar canción', 'queue/push', 'POST', { id: row.id })
                              }
                            >
                              <Play size={16} />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty>
                {search
                  ? 'No hay resultados para esta búsqueda.'
                  : 'Añade audios a storage/music y ejecuta Reescanear.'}
              </Empty>
            )}
            <div className="pagination">
              <span>
                {text(tracks.total, '0')} pistas · página {page}
              </span>
              <div className="actions">
                <Button
                  variant="secondary"
                  disabled={page <= 1 || loading}
                  onClick={() => setPage(page - 1)}
                >
                  Anterior
                </Button>
                <Button
                  variant="secondary"
                  disabled={
                    page * Number(tracks.pageSize ?? 30) >= Number(tracks.total ?? 0) || loading
                  }
                  onClick={() => setPage(page + 1)}
                >
                  Siguiente
                </Button>
              </div>
            </div>
            {edit && (
              <form
                className="form-panel"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const result = await action('Guardar pista', `tracks/${edit.id}`, 'PATCH', {
                    title: edit.title,
                    artist: edit.artist,
                    album: edit.album ?? '',
                    genre: edit.genre ?? '',
                  });
                  if (result) setEdit(null);
                }}
              >
                <h2>Editar metadatos</h2>
                <div className="form-grid">
                  {[
                    ['title', 'Título'],
                    ['artist', 'Artista'],
                    ['album', 'Álbum'],
                    ['genre', 'Género'],
                  ].map(([key, label]) => (
                    <label key={key}>
                      {label}
                      <input
                        required={key === 'title' || key === 'artist'}
                        value={text(edit[key], '')}
                        onChange={(e) => setEdit({ ...edit, [key]: e.target.value })}
                      />
                    </label>
                  ))}
                </div>
                <div className="actions">
                  <Button disabled={!!busy}>
                    <Check size={16} />
                    Guardar
                  </Button>
                  <Button type="button" variant="secondary" onClick={() => setEdit(null)}>
                    Cancelar
                  </Button>
                </div>
              </form>
            )}
          </>
        )}
        {view === 'dj' && (
          <>
            <div className="live-columns">
              <form onSubmit={saveSettings}>
                <h2>Personalidad y voz</h2>
                <label>
                  Personalidad del DJ
                  <textarea
                    rows={5}
                    value={text(settings.persona, '')}
                    onChange={(e) => setSettings({ ...settings, persona: e.target.value })}
                  />
                </label>
                <div className="form-grid">
                  {input('textModel', 'Modelo de texto')}
                  {input('ttsModel', 'Modelo de voz')}
                  {input('ttsVoice', 'Voz')}
                  {input('djTargetSeconds', 'Duración objetivo (s)', 'number')}
                </div>
                <Button disabled={!!busy}>Guardar personalidad</Button>
              </form>
              <section>
                <h2>Probar antes de emitir</h2>
                <p className="muted">
                  El guion de prueba usa el contexto reciente. La muestra de voz se genera sin
                  incorporarse a la emisión.
                </p>
                <Button
                  disabled={!!busy}
                  onClick={async () => {
                    const value = await action('Preparar guion', 'ai-breaks/preview', 'POST', {});
                    if (value) setPreview(object(value));
                  }}
                >
                  <Mic2 size={16} />
                  Previsualizar guion
                </Button>
                <label className="section">
                  Texto para probar la voz
                  <textarea rows={4} value={ttsText} onChange={(e) => setTtsText(e.target.value)} />
                </label>
                <Button
                  variant="secondary"
                  disabled={!!busy || !ttsText.trim()}
                  onClick={async () => {
                    const result = await action(
                      'Generar muestra de voz',
                      'ai-breaks/test-tts',
                      'POST',
                      { text: ttsText },
                    );
                    const p = object(result).audioPath;
                    if (p) setSample(`/api/generated-audio?file=${encodeURIComponent(String(p))}`);
                  }}
                >
                  Generar muestra TTS
                </Button>
                {sample && (
                  <audio className="section" controls src={sample} aria-label="Muestra del DJ IA" />
                )}
              </section>
            </div>
            {preview && (
              <section className="script-preview section">
                <h2>Guion validado</h2>
                <p>{text(object(preview.script).fullText)}</p>
                <small>
                  Duración estimada: {text(object(preview.script).estimatedSeconds)} segundos
                </small>
                <h3>Fuentes del contexto</h3>
                {list(object(preview.context).news).map((row) => (
                  <p key={text(row.id)}>
                    <a href={text(row.url)} target="_blank" rel="noreferrer">
                      {text(row.source)} · {text(row.title)}
                    </a>
                  </p>
                ))}
              </section>
            )}
            <section className="section">
              <h2>Intervenciones recientes</h2>
              <BreakList items={list(data['ai-breaks'])} />
            </section>
          </>
        )}
        {view === 'schedule' && (
          <>
            <form onSubmit={saveSettings} className="settings-form">
              <h2>Automatización horaria</h2>
              {toggle('djHourlyEnabled', 'Preparar una intervención cada hora')}
              <p className="muted">
                El worker prepara la locución cinco minutos antes y la encola un minuto antes. Se
                emite al siguiente límite de pista. Los cambios de hora mantienen una identidad UTC
                única.
              </p>
              <h2 className="section">Rotación musical</h2>
              <div className="form-grid">
                {input('trackRepeatHours', 'No repetir canción (horas)', 'number')}
                {input('artistRepeatMinutes', 'No repetir artista (minutos)', 'number')}
                {input('jingleMinTracks', 'Jingle: mínimo de canciones', 'number')}
                {input('jingleMaxTracks', 'Jingle: máximo de canciones', 'number')}
              </div>
              <Button disabled={!!busy}>Guardar programación</Button>
            </form>
            <section className="section">
              <h2>Intervenciones programadas</h2>
              <BreakList items={list(data['ai-breaks'])} />
            </section>
          </>
        )}
        {view === 'sources' && (
          <>
            <div className="live-columns">
              <section>
                <h2>Meteorología</h2>
                <DataRows value={object(sources.weather)} />
                <h2 className="section">Noticias</h2>
                <DataRows value={object(sources.news)} />
                <Button
                  className="section"
                  variant="secondary"
                  disabled={!!busy}
                  onClick={() => void action('Refrescar fuentes', 'sources/refresh')}
                >
                  <RefreshCw size={16} />
                  Refrescar fuentes
                </Button>
              </section>
              <form onSubmit={saveSettings}>
                <h2>Fuentes editoriales</h2>
                {toggle('weatherEnabled', 'Incluir meteorología')}
                {toggle('newsEnabled', 'Incluir titulares')}
                <label>
                  Feeds RSS / Atom
                  <textarea
                    className="code-input"
                    rows={12}
                    value={sourcesJson}
                    onChange={(e) => setSourcesJson(e.target.value)}
                  />
                </label>
                <p className="muted">
                  Cada fuente incluye name, url HTTPS, category, priority y enabled. Desactiva una
                  fuente con enabled: false.
                </p>
                <Button disabled={!!busy}>Guardar fuentes</Button>
              </form>
            </div>
            {list(object(sources.news).sourceStatuses).length > 0 && (
              <section className="section">
                <h2>Estado de cada fuente</h2>
                <div className="health-list">
                  {list(object(sources.news).sourceStatuses).map((row) => (
                    <div key={text(row.name)}>
                      <span>{text(row.name)}</span>
                      <small>
                        {row.ok
                          ? `${text(row.items, '0')} titulares · ${date(row.checkedAt)}`
                          : `Error: ${text(row.errorCode)}`}
                      </small>
                    </div>
                  ))}
                </div>
              </section>
            )}
            {list(sources.newsHeadlines).length > 0 && (
              <section className="section">
                <h2>Titulares disponibles</h2>
                {list(sources.newsHeadlines).map((row) => (
                  <div className="news-row" key={text(row.id)}>
                    <a href={text(row.url)} target="_blank" rel="noreferrer">
                      {text(row.title)}
                    </a>
                    <small>
                      {text(row.source)} · {date(row.publishedAt)}
                    </small>
                  </div>
                ))}
              </section>
            )}
          </>
        )}
        {view === 'history' && <Events items={list(data.history)} />}
        {view === 'system' && (
          <>
            <div className="live-columns">
              <section>
                <h2>Entorno y servicios</h2>
                <dl className="definition">
                  <div>
                    <dt>Node.js</dt>
                    <dd>{text(system.nodeVersion)}</dd>
                  </div>
                  <div>
                    <dt>Liquidsoap</dt>
                    <dd>{text(object(system.versions).liquidsoap, 'Sin verificar')}</dd>
                  </div>
                  <div>
                    <dt>Icecast</dt>
                    <dd>{text(object(system.versions).icecast, 'Sin verificar')}</dd>
                  </div>
                  <div>
                    <dt>FFmpeg</dt>
                    <dd>{text(object(system.versions).ffmpeg, 'Sin verificar')}</dd>
                  </div>
                  <div>
                    <dt>Uptime del panel</dt>
                    <dd>{duration(system.uptimeSeconds)}</dd>
                  </div>
                  <div>
                    <dt>Último heartbeat</dt>
                    <dd>{date(object(system.heartbeat).at)}</dd>
                  </div>
                  <div>
                    <dt>Zona editorial</dt>
                    <dd>{text(system.timezone)}</dd>
                  </div>
                  <div>
                    <dt>Audio generado</dt>
                    <dd>
                      {(Number(object(system.generated).bytes ?? 0) / 1048576).toFixed(1)} MB ·{' '}
                      {text(object(system.generated).files, '0')} archivos
                    </dd>
                  </div>
                </dl>
                <DataRows value={object(system.disk)} />
              </section>
              <section>
                <h2>Credenciales</h2>
                <div className="health-list">
                  {Object.entries(object(system.configured)).map(([key, value]) => (
                    <div key={key}>
                      <span>{key}</span>
                      <span>{value ? 'Configurada' : 'Falta configurar'}</span>
                    </div>
                  ))}
                </div>
                <p className="muted section">
                  Las claves y contraseñas se gestionan en .env o EnvironmentFile. El panel nunca
                  muestra sus valores.
                </p>
                <h2>Componentes</h2>
                <div className="health-list">
                  {Object.entries(object(health.checks)).map(([key, v]) => (
                    <div key={key}>
                      <span>{key}</span>
                      <small>
                        {object(v).ok ? 'Disponible' : text(object(v).detail, 'No disponible')}
                      </small>
                    </div>
                  ))}
                </div>
              </section>
            </div>
            <section className="section">
              <h2>Últimos errores</h2>
              <Events items={list(system.errors)} />
            </section>
          </>
        )}
        {view === 'settings' && (
          <form onSubmit={saveSettings} className="settings-form">
            <h2>Identidad de emisora</h2>
            {input('stationName', 'Nombre de la emisora')}
            <p className="muted">
              Se aplica a nuevas intervenciones. Los ajustes del motor de audio, ubicación, puertos
              y secretos se gestionan en .env; después reinicia el servicio afectado.
            </p>
            <Button disabled={!!busy}>Guardar configuración</Button>
            <section className="section">
              <h2>Valores operativos</h2>
              <DataRows
                value={Object.fromEntries(
                  Object.entries(settings).filter(
                    ([k, v]) =>
                      !['persona', 'newsSources', 'stationName'].includes(k) &&
                      typeof v !== 'object',
                  ),
                )}
              />
            </section>
          </form>
        )}
        <footer className="footer">
          Radio AI · Control local de emisión <span>Los fallos de IA no detienen la música.</span>
        </footer>
      </main>
      {confirm && (
        <Confirm
          title={confirm.title}
          description={confirm.description}
          onClose={() => setConfirm(null)}
          onConfirm={confirm.run}
        />
      )}
    </div>
  );
}
function BreakList({ items }: { items: Row[] }) {
  return items.length ? (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Programada</th>
            <th>Tipo</th>
            <th>Estado</th>
            <th>Duración</th>
            <th>Incidencia</th>
          </tr>
        </thead>
        <tbody>
          {items.map((row) => (
            <tr key={text(row.id)}>
              <td>{date(row.scheduledFor)}</td>
              <td>{names[text(row.kind)] ?? text(row.kind)}</td>
              <td>
                <Status value={row.status} />
              </td>
              <td>{duration(row.durationSec)}</td>
              <td>{text(row.errorCode)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <Empty>Aún no se ha preparado ninguna intervención.</Empty>
  );
}
function DataRows({ value }: { value: Row }) {
  return (
    <dl className="definition">
      {Object.entries(value)
        .filter(([k, v]) => typeof v !== 'object' && !['audioPath', 'path'].includes(k))
        .map(([key, v]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>{typeof v === 'boolean' ? (v ? 'Sí' : 'No') : text(v)}</dd>
          </div>
        ))}
    </dl>
  );
}
