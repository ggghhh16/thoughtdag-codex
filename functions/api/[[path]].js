// Read-only boundary for static/edge deployments of ThoughtDAG Codex.
// Edge runtimes cannot spawn the local Codex process, so generation fails
// explicitly instead of falling back to another provider.

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}

function isPrivateHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost'
    || host === '0.0.0.0'
    || host === '::1'
    || host.endsWith('.local')
    || /^127\./.test(host)
    || /^10\./.test(host)
    || /^192\.168\./.test(host)
    || /^169\.254\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    || /^f[cd][0-9a-f]{2}:/i.test(host)
    || /^fe[89ab][0-9a-f]:/i.test(host);
}

async function fetchWithSafeRedirects(value, signal, maxRedirects = 5) {
  let current = new URL(String(value));
  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    if (!/^https?:$/.test(current.protocol)) throw new Error('Only http(s) URLs are supported');
    if (current.username || current.password) throw new Error('Credentialed URLs are not supported');
    if (isPrivateHost(current.hostname)) throw new Error('Refusing to fetch private addresses');
    const response = await fetch(current.href, {
      signal,
      redirect: 'manual',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ThoughtDAG-Codex/0.1; link snapshot)' },
    });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get('location');
    if (!location) throw new Error(`Redirect HTTP ${response.status} did not include a location`);
    if (redirects === maxRedirects) throw new Error('Too many redirects');
    current = new URL(location, current);
  }
  throw new Error('Too many redirects');
}

async function handleFetchUrl(body) {
  try {
    const parsed = new URL(String(body?.url ?? ''));
    const response = await fetchWithSafeRedirects(parsed, AbortSignal.timeout(15_000));
    if (!response.ok) throw new Error(`Page responded HTTP ${response.status}`);

    const contentType = response.headers.get('content-type') ?? '';
    if (!/text\/html|text\/plain|application\/xhtml/i.test(contentType)) {
      throw new Error(`Unsupported content type: ${contentType}`);
    }

    const html = (await response.text()).slice(0, 800_000);
    const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<(nav|footer|header|aside)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/[ \t]+/g, ' ')
      .replace(/\s*\n\s*(\s*\n\s*)+/g, '\n\n')
      .trim()
      .slice(0, 15_000);

    return json({ title, text, html, fetchedAt: new Date().toISOString() });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Fetch failed' }, 400);
  }
}

const LOCAL_ONLY_MESSAGE =
  'Codex generation is local-only. Use ThoughtDAG Codex desktop, or run npm run server locally.';

export async function onRequest({ request, params }) {
  const path = `/${Array.isArray(params.path) ? params.path.join('/') : (params.path ?? '')}`;

  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });

  if (request.method === 'GET' && path === '/models') {
    return json({
      models: [],
      default: null,
      capabilities: {
        codexOnly: true,
        localOnly: true,
        webSearch: false,
        searchEngine: 'codex',
        scholarSearch: false,
        vision: false,
      },
      codex: {
        status: 'unavailable',
        model: 'default',
        message: LOCAL_ONLY_MESSAGE,
      },
    });
  }
  if (request.method === 'GET' && path === '/codex/status') {
    return json({ status: 'unavailable', model: 'default', message: LOCAL_ONLY_MESSAGE }, 501);
  }
  if (request.method === 'GET' && path === '/tools') return json({ mcpServers: [] });
  if (request.method !== 'POST') return json({ error: 'Not found' }, 404);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  if (path === '/fetch-url') return handleFetchUrl(body);
  if (path === '/pdf-extract') {
    return json({ error: 'PDF extraction is available in the local and desktop builds only.' }, 501);
  }
  if (['/stream', '/codex', '/probe-models', '/runtime-providers', '/runtime-key'].includes(path)) {
    return json({ error: LOCAL_ONLY_MESSAGE }, 501);
  }
  return json({ error: 'Not found' }, 404);
}
