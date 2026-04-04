// ═══════════════════════════════════════════════════════════════════
//  NOVA Music Backend — server.js
//  Fixed & complete. Run: node server.js
// ═══════════════════════════════════════════════════════════════════
import express from 'express';
import session from 'express-session';
import cors from 'cors';
import dotenv from 'dotenv';
import { google } from 'googleapis';
import NodeCache from 'node-cache';
import fetch from 'node-fetch';
import { v4 as uuidv4 } from 'uuid';

dotenv.config();

const app = express();
const cache = new NodeCache({ stdTTL: 300 }); // 5-min cache

const youtube = google.youtube('v3');

// ── In-memory store (replace with a DB like MongoDB/SQLite for production) ──
const users     = new Map(); // googleId → user object
const playlists = new Map(); // playlistId → playlist object
const liked     = new Map(); // googleId → Set of track objects
const shares    = new Map(); // shareId → playlistId

// ── CORS ─────────────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3001',
  process.env.FRONTEND_URL,
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error('CORS blocked'));
  },
  credentials: true,
}));

app.use(express.json());

// ── Session ───────────────────────────────────────────────────────────────────
app.use(session({
  secret: process.env.SESSION_SECRET || 'nova-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  },
}));

// ── Google OAuth2 client ──────────────────────────────────────────────────────
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI || 'https://nova-music-backend-production.up.railway.app/auth/google/callback'
);

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ═════════════════════════════════════════════════════════════════════════════
//  AUTH ROUTES
// ═════════════════════════════════════════════════════════════════════════════

// Initiate Google OAuth
app.get('/auth/google', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['openid', 'email', 'profile'],
    prompt: 'select_account',
  });
  res.redirect(url);
});

// Google OAuth callback
app.get('/auth/google/callback', async (req, res) => {
  const { code, error } = req.query;
  const FRONTEND = process.env.FRONTEND_URL || 'http://localhost:3000';

  if (error) return res.redirect(`${FRONTEND}?error=oauth_denied`);
  if (!code)  return res.redirect(`${FRONTEND}?error=no_code`);

  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Get Google profile
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data: profile } = await oauth2.userinfo.get();

    let user = users.get(profile.id);
    if (!user) {
      user = {
        id: profile.id,
        googleId: profile.id,
        name: profile.name,
        email: profile.email,
        picture: profile.picture,
        theme: 'dark',
        accent: 'cyan',
        createdAt: new Date().toISOString(),
      };
      users.set(profile.id, user);
      liked.set(profile.id, []);
    }

    req.session.userId = user.id;
    res.redirect(FRONTEND);
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}?error=auth_failed`);
  }
});

// Get current user
app.get('/auth/me', (req, res) => {
  if (!req.session?.userId) return res.json({ user: null });
  const user = users.get(req.session.userId);
  res.json({ user: user || null });
});

// Logout
app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

// ═════════════════════════════════════════════════════════════════════════════
//  YOUTUBE API ROUTES
// ═════════════════════════════════════════════════════════════════════════════
const YT_KEY = process.env.YOUTUBE_API_KEY;

if (!YT_KEY) {
  console.warn('⚠️  YOUTUBE_API_KEY not set! Search and trending will not work.');
}

// Search videos
app.get('/api/search', async (req, res) => {
  const { q, type = 'all', pageToken } = req.query;
  if (!q) return res.status(400).json({ error: 'Query required' });

  const cacheKey = `search:${q}:${type}:${pageToken || 'first'}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const params = {
      key: YT_KEY,
      q,
      part: 'snippet',
      type: 'video',
      maxResults: 20,
      videoEmbeddable: true,
      videoCategoryId: type === 'music' ? '10' : undefined,
      pageToken: pageToken || undefined,
      safeSearch: 'moderate',
    };

    const r = await youtube.search.list(params);
    const result = {
      items: (r.data.items || []).map(item => ({
        id: item.id.videoId,
        title: item.snippet.title,
        channel: item.snippet.channelTitle,
        thumbnail: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url,
        publishedAt: item.snippet.publishedAt,
      })),
      nextPageToken: r.data.nextPageToken || null,
    };

    cache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error('Search error:', err.message);
    res.status(500).json({ error: 'Search failed', detail: err.message });
  }
});

// Search by channel name
app.get('/api/search/channel', async (req, res) => {
  const { channelName } = req.query;
  if (!channelName) return res.status(400).json({ error: 'channelName required' });

  try {
    // First find the channel
    const chRes = await youtube.search.list({ key: YT_KEY, q: channelName, part: 'snippet', type: 'channel', maxResults: 1 });
    if (!chRes.data.items?.length) return res.json({ items: [] });

    const channelId = chRes.data.items[0].id.channelId;

    // Then get their videos
    const vRes = await youtube.search.list({ key: YT_KEY, channelId, part: 'snippet', type: 'video', maxResults: 20, order: 'viewCount' });
    const result = {
      items: (vRes.data.items || []).map(item => ({
        id: item.id.videoId,
        title: item.snippet.title,
        channel: item.snippet.channelTitle,
        thumbnail: item.snippet.thumbnails?.medium?.url,
      })),
    };
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Channel search failed' });
  }
});

// Trending / popular music
app.get('/api/trending', async (req, res) => {
  const cached = cache.get('trending');
  if (cached) return res.json(cached);

  try {
    const r = await youtube.videos.list({
      key: YT_KEY,
      part: 'snippet',
      chart: 'mostPopular',
      videoCategoryId: '10', // Music
      maxResults: 24,
      regionCode: 'US',
    });

    const result = {
      items: (r.data.items || []).map(v => ({
        id: v.id,
        title: v.snippet.title,
        channel: v.snippet.channelTitle,
        thumbnail: v.snippet.thumbnails?.medium?.url || v.snippet.thumbnails?.default?.url,
        publishedAt: v.snippet.publishedAt,
      })),
    };
    cache.set('trending', result, 600); // 10-min cache for trending
    res.json(result);
  } catch (err) {
    console.error('Trending error:', err.message);
    res.status(500).json({ error: 'Failed to fetch trending', items: [] });
  }
});

// Video details
app.get('/api/video/:videoId', async (req, res) => {
  const { videoId } = req.params;
  const cacheKey = `video:${videoId}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const r = await youtube.videos.list({
      key: YT_KEY,
      part: 'snippet,contentDetails,statistics',
      id: videoId,
    });

    const v = r.data.items?.[0];
    if (!v) return res.status(404).json({ error: 'Video not found' });

    const result = {
      id: v.id,
      title: v.snippet.title,
      channel: v.snippet.channelTitle,
      description: v.snippet.description,
      thumbnail: v.snippet.thumbnails?.maxres?.url || v.snippet.thumbnails?.high?.url,
      duration: v.contentDetails?.duration,
      viewCount: v.statistics?.viewCount,
      likeCount: v.statistics?.likeCount,
      publishedAt: v.snippet.publishedAt,
    };
    cache.set(cacheKey, result, 3600); // 1-hour cache for video details
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get video details' });
  }
});

// ── FIXED: Stream URL endpoint ────────────────────────────────────────────────
// Returns the best audio stream URL for a YouTube video.
// This uses a public invidious/piped instance — no API key needed for streaming.
// For production, you should self-host an invidious instance or use yt-dlp.
app.get('/api/stream/:videoId', async (req, res) => {
  const { videoId } = req.params;

  // Try multiple Invidious instances as fallbacks
  const INVIDIOUS_INSTANCES = [
    'https://invidious.nerdvpn.de',
    'https://inv.tux.pizza',
    'https://invidious.privacydev.net',
    'https://invidious.slipfox.xyz',
  ];

  for (const instance of INVIDIOUS_INSTANCES) {
    try {
      const r = await fetch(`${instance}/api/v1/videos/${videoId}`, {
        headers: { 'User-Agent': 'Nova-Music/1.0' },
        signal: AbortSignal.timeout(5000),
      });

      if (!r.ok) continue;
      const data = await r.json();

      // Find the best audio-only stream
      const audioFormats = (data.adaptiveFormats || []).filter(f =>
        f.type?.startsWith('audio/') && f.url
      );

      // Prefer webm/opus (smaller, better quality), fall back to m4a
      const best = audioFormats.find(f => f.type?.includes('opus'))
        || audioFormats.find(f => f.type?.includes('mp4'))
        || audioFormats[0];

      if (best?.url) {
        return res.json({ url: best.url, type: best.type });
      }
    } catch {}
  }

  // Final fallback: use proxy
  res.status(503).json({ error: 'Stream unavailable, use proxy' });
});

// ── Proxy stream (fallback when direct URL fails) ─────────────────────────────
// This proxies the audio through your server to avoid CORS issues
app.get('/api/proxy/:videoId', async (req, res) => {
  const { videoId } = req.params;

  const INVIDIOUS_INSTANCES = [
    'https://invidious.nerdvpn.de',
    'https://inv.tux.pizza',
    'https://invidious.privacydev.net',
  ];

  for (const instance of INVIDIOUS_INSTANCES) {
    try {
      const metaRes = await fetch(`${instance}/api/v1/videos/${videoId}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!metaRes.ok) continue;

      const data = await metaRes.json();
      const audioFormats = (data.adaptiveFormats || []).filter(f =>
        f.type?.startsWith('audio/') && f.url
      );
      const best = audioFormats.find(f => f.type?.includes('opus'))
        || audioFormats.find(f => f.type?.includes('mp4'))
        || audioFormats[0];

      if (!best?.url) continue;

      // Proxy the audio stream
      const audioRes = await fetch(best.url, {
        headers: {
          'Range': req.headers['range'] || 'bytes=0-',
          'User-Agent': 'Mozilla/5.0',
        },
        signal: AbortSignal.timeout(10000),
      });

      if (!audioRes.ok && audioRes.status !== 206) continue;

      res.status(audioRes.status);
      res.set({
        'Content-Type': best.type || 'audio/webm',
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      });

      if (audioRes.headers.get('content-range')) {
        res.set('Content-Range', audioRes.headers.get('content-range'));
      }
      if (audioRes.headers.get('content-length')) {
        res.set('Content-Length', audioRes.headers.get('content-length'));
      }

      audioRes.body.pipe(res);
      return;
    } catch (err) {
      console.error(`Proxy failed for ${instance}:`, err.message);
    }
  }

  res.status(503).json({ error: 'Could not proxy stream' });
});

// ═════════════════════════════════════════════════════════════════════════════
//  LIBRARY ROUTES (Liked songs)
// ═════════════════════════════════════════════════════════════════════════════

app.get('/api/liked', requireAuth, (req, res) => {
  const tracks = liked.get(req.session.userId) || [];
  res.json({ tracks });
});

app.post('/api/liked', requireAuth, (req, res) => {
  const { track } = req.body;
  if (!track?.id) return res.status(400).json({ error: 'Track required' });
  const tracks = liked.get(req.session.userId) || [];
  if (!tracks.find(t => t.id === track.id)) {
    tracks.push({ ...track, likedAt: new Date().toISOString() });
    liked.set(req.session.userId, tracks);
  }
  res.json({ success: true });
});

app.delete('/api/liked/:trackId', requireAuth, (req, res) => {
  const tracks = liked.get(req.session.userId) || [];
  liked.set(req.session.userId, tracks.filter(t => t.id !== req.params.trackId));
  res.json({ success: true });
});

// ═════════════════════════════════════════════════════════════════════════════
//  PLAYLIST ROUTES
// ═════════════════════════════════════════════════════════════════════════════

app.get('/api/playlists', requireAuth, (req, res) => {
  const userPlaylists = [...playlists.values()]
    .filter(p => p.ownerId === req.session.userId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ playlists: userPlaylists });
});

app.post('/api/playlists', requireAuth, (req, res) => {
  const { name, description = '' } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });

  const playlist = {
    id: uuidv4(),
    name: name.trim(),
    description,
    ownerId: req.session.userId,
    tracks: [],
    isPublic: false,
    coverColor: `hsl(${Math.random() * 360 | 0}, 60%, 40%)`,
    createdAt: new Date().toISOString(),
  };
  playlists.set(playlist.id, playlist);
  res.json({ playlist });
});

app.get('/api/playlists/:id', requireAuth, (req, res) => {
  const pl = playlists.get(req.params.id);
  if (!pl || pl.ownerId !== req.session.userId)
    return res.status(404).json({ error: 'Not found' });
  res.json({ playlist: pl });
});

app.delete('/api/playlists/:id', requireAuth, (req, res) => {
  const pl = playlists.get(req.params.id);
  if (!pl || pl.ownerId !== req.session.userId)
    return res.status(404).json({ error: 'Not found' });
  playlists.delete(req.params.id);
  res.json({ success: true });
});

// Add track to playlist
app.post('/api/playlists/:id/tracks', requireAuth, (req, res) => {
  const pl = playlists.get(req.params.id);
  if (!pl || pl.ownerId !== req.session.userId)
    return res.status(404).json({ error: 'Not found' });

  const { track } = req.body;
  if (!track?.id) return res.status(400).json({ error: 'Track required' });

  // Avoid duplicates
  if (!pl.tracks.find(t => t.id === track.id)) {
    pl.tracks.push({ ...track, addedAt: new Date().toISOString() });
  }
  res.json({ success: true });
});

// Remove track from playlist
app.delete('/api/playlists/:id/tracks/:trackId', requireAuth, (req, res) => {
  const pl = playlists.get(req.params.id);
  if (!pl || pl.ownerId !== req.session.userId)
    return res.status(404).json({ error: 'Not found' });

  pl.tracks = pl.tracks.filter(t => t.id !== req.params.trackId);
  res.json({ success: true });
});

// Share playlist
app.post('/api/playlists/:id/share', requireAuth, (req, res) => {
  const pl = playlists.get(req.params.id);
  if (!pl || pl.ownerId !== req.session.userId)
    return res.status(404).json({ error: 'Not found' });

  pl.isPublic = true;
  // Find existing share or create new one
  let existingShareId = [...shares.entries()].find(([, pid]) => pid === pl.id)?.[0];
  if (!existingShareId) {
    existingShareId = uuidv4().slice(0, 8);
    shares.set(existingShareId, pl.id);
  }

  const FRONTEND = process.env.FRONTEND_URL || 'http://localhost:3000';
  res.json({ shareUrl: `${FRONTEND}/shared/${existingShareId}`, shareId: existingShareId });
});

// Get shared playlist (no auth required)
app.get('/api/shared/:shareId', (req, res) => {
  const playlistId = shares.get(req.params.shareId);
  if (!playlistId) return res.status(404).json({ error: 'Playlist not found' });
  const pl = playlists.get(playlistId);
  if (!pl?.isPublic) return res.status(404).json({ error: 'Playlist not found' });
  res.json({ playlist: pl });
});

// ═════════════════════════════════════════════════════════════════════════════
//  USER SETTINGS
// ═════════════════════════════════════════════════════════════════════════════

app.put('/api/user/settings', requireAuth, (req, res) => {
  const user = users.get(req.session.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { theme, accent } = req.body;
  if (theme) user.theme = theme;
  if (accent) user.accent = accent;
  res.json({ success: true });
});

// ═════════════════════════════════════════════════════════════════════════════
//  HEALTH CHECK
// ═════════════════════════════════════════════════════════════════════════════

app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🎵 NOVA Backend running on port ${PORT}`);
  console.log(`   GOOGLE_CLIENT_ID:     ${process.env.GOOGLE_CLIENT_ID ? '✅ set' : '❌ MISSING'}`);
  console.log(`   GOOGLE_CLIENT_SECRET: ${process.env.GOOGLE_CLIENT_SECRET ? '✅ set' : '❌ MISSING'}`);
  console.log(`   YOUTUBE_API_KEY:      ${process.env.YOUTUBE_API_KEY ? '✅ set' : '❌ MISSING'}`);
  console.log(`   SESSION_SECRET:       ${process.env.SESSION_SECRET ? '✅ set' : '⚠️  using default'}`);
  console.log(`   FRONTEND_URL:         ${process.env.FRONTEND_URL || 'http://localhost:3000 (default)'}`);
});

export default app;
