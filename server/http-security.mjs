const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function requireLoopbackHost(host) {
  if (!LOOPBACK_HOSTS.has(host)) throw new Error('HOST must be localhost, 127.0.0.1 or ::1. This server has no remote-user authentication.');
  return host;
}

export function createLocalRequestGuard({ port, extraOrigins = '' }) {
  const hosts = ['localhost', '127.0.0.1', '[::1]'];
  const authorities = new Set(hosts.map(host => `${host}:${port}`));
  const allowedOrigins = new Set(hosts.flatMap(host => [port, 5173, 4173].map(p => `http://${host}:${p}`)));
  for (const value of extraOrigins.split(',').map(value => value.trim()).filter(Boolean)) {
    const url = new URL(value);
    if (!LOOPBACK_HOSTS.has(url.hostname) || !/^https?:$/.test(url.protocol) || url.origin !== value) {
      throw new Error('THOUGHTDAG_ALLOWED_ORIGINS must contain exact loopback origins.');
    }
    allowedOrigins.add(value);
  }
  return (req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Frame-Options', 'DENY');
    if (!authorities.has(req.get('host'))) return res.status(403).json({ error: 'Untrusted request host.' });
    const origin = req.get('origin');
    if (origin && !allowedOrigins.has(origin)) return res.status(403).json({ error: 'Untrusted request origin.' });
    // Requests without Origin still carry Fetch Metadata in modern browsers.
    // CLI/Electron main-process calls have neither; local processes are trusted.
    if (!origin && ['cross-site', 'same-site'].includes(req.get('sec-fetch-site'))) {
      return res.status(403).json({ error: 'Cross-origin requests are not allowed.' });
    }
    if (!['GET', 'HEAD', 'OPTIONS', 'DELETE'].includes(req.method) && !req.is('application/json')) {
      return res.status(415).json({ error: 'Content-Type must be application/json.' });
    }
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    next();
  };
}
