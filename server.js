import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import session from 'express-session';
import { OAuth2Client } from 'google-auth-library';
import { google } from 'googleapis';
import NodeCache from 'node-cache';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import fetch from 'node-fetch';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const cache = new NodeCache({ stdTTL: 3600 });
const DATA_FILE = path.join(__dirname, 'data.json');

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    const init = { users: {}, playlists: {}, sharedPlaylists: {} };
    fs.writeFileSync(DATA_FILE, JSON.stringify(init, null, 2));
    return init;
  }
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return { users: {}, playlists: {}, sharedPlaylists: {} }; }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';
const REDIRECT_URI = process.env.NODE_ENV === 'production'
  ? 'https://nova-music-backend-production.up.railway.app/auth/google/callback'
  : 'http://localhost:3001/auth/google/callback';
const FRONTEND_URL = process.env.NODE_ENV === 'production'
  ? 'https://nova-music-frontend.vercel.app'
  : 'http://localhost:3000';
const SESSION_SECRET = process.env.SESSION_SECRET || 'nova_secret_2024';

const oauth2Client = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT_URI);
const youtube = google.youtube({ version: 'v3', auth: YOUTUBE_API_KEY });

// ─── Piped API instances (fallback list for reliability) ──────────────────────
const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://piped-api.garudalinux.org',
  'https://api.piped.yt',
  'https://pipedapi.reallyaweso.me',
  'https://pipedapi.darkness.services',
];

// ─── Get audio stream URL from Piped API ──────────────────────────────────────
async function getAudioStream(videoId) {
  const cacheKey = `stream_${videoId}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  for (const instance of PIPED_INSTANCES) {
    try {
      const res = await fetch(`${instance}/streams/${videoId}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 8000,
      });
      if (!res.ok) continue;
      const data = await res.json();

      // Get best audio stream
      const audioStreams = data.audioStreams || [];
      const best = audioStreams
        .filter(s => s.mimeType?.includes('audio'))
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];

      if (best?.url) {
        const result = {
          url: best.url,
          mimeType: best.mimeType || 'audio/mp4',
          bitrate: best.bitrate,
          title: data.title,
          uploader: data.uploader,
          thumbnail: data.thumbnailUrl,
          duration: data.duration,
        };
        cache.set(cacheKey, result, 3600); // cache 1 hour
        return result;
      }
    } catch (e) {
      continue; // try next instance
    }
  }

  // Fallback: try ytdl-core
  try {
    const ytdl = await import('ytdl-core');
    const info = await ytdl.default.getInfo(`https://www.youtube.com/watch?v=${videoId}`);
    const format = ytdl.default.chooseFormat(info.formats, { quality: 'highestaudio', filter: 'audioonly' });
    if (format?.url) {
      const result = {
        url: format.url,
        mimeType: format.mimeType || 'audio/mp4',
        bitrate: format.audioBitrate,
        title: info.videoDetails.title,
        uploader: info.videoDetails.author?.name,
        thumbnail: info.videoDetails.thumbnails?.[0]?.url,
        duration: parseInt(info.videoDetails.lengthSeconds),
      };
      cache.set(cacheKey, result, 1800);
      return result;
    }
  } catch (e) {
    console.error('ytdl-core fallback failed:', e.message);
  }

  return null;
}

// ─── Middleware ────────────────────────────────────────────────────────────────
const allowedOrigins = [
  'http://localhost:3000',
  'https://nova-music-frontend.vercel.app'
];

app.use(cors({
  origin: function(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) callback(null, true);
    else callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Cookie'],
}));
app.options('*', cors());
app.use(express.json());
app.set('trust proxy', 1);
app.use(session({
  secret: SESSION_SECRET,
  resave: true,
  saveUninitialized: true,
  proxy: true,
  cookie: {
    secure: true,
    sameSite: 'none',
    maxAge: 30 * 24 * 60 * 60 * 1000,
    httpOnly: true
  }
}));

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ─── Auth Routes ──────────────────────────────────────────────────────────────
app.get('/auth/google', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['profile', 'email'],
    prompt: 'consent'
  });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    const { code } = req.query;
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    const ticket = await oauth2Client.verifyIdToken({
      idToken: tokens.id_token,
      audience: GOOGLE_CLIENT_ID
    });
    const payload = ticket.getPayload();
    const db = loadData();
    if (!db.users[payload.sub]) {
      db.users[payload.sub] = {
        id: payload.sub, name: payload.name,
        email: payload.email, picture: payload.picture,
        theme: 'dark', accent: 'cyan',
        createdAt: new Date().toISOString()
      };
      saveData(db);
    }
    req.session.user = { id: payload.sub, name: payload.name, email: payload.email, picture: payload.picture };
    req.session.save(() => res.redirect(`${FRONTEND_URL}/home`));
  } catch (err) {
    console.error('Auth error:', err);
    res.redirect(`${FRONTEND_URL}/?error=auth_failed`);
  }
});

app.get('/auth/me', (req, res) => {
  if (!req.session.user) return res.json({ user: null });
  const db = loadData();
  const userData = db.users[req.session.user.id] || req.session.user;
  res.json({ user: userData });
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

// ─── NEW: Get direct audio stream URL ─────────────────────────────────────────
// This is the key endpoint for background play!
app.get('/api/stream/:videoId', async (req, res) => {
  const { videoId } = req.params;
  try {
    const stream = await getAudioStream(videoId);
    if (!stream) return res.status(404).json({ error: 'Stream not found' });
    res.json(stream);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── NEW: Proxy audio stream (fixes CORS issues on some devices) ──────────────
app.get('/api/proxy/:videoId', async (req, res) => {
  const { videoId } = req.params;
  try {
    const stream = await getAudioStream(videoId);
    if (!stream?.url) return res.status(404).json({ error: 'Not found' });

    const audioRes = await fetch(stream.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Range': req.headers.range || 'bytes=0-',
      }
    });

    res.setHeader('Content-Type', stream.mimeType || 'audio/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (audioRes.headers.get('content-length'))
      res.setHeader('Content-Length', audioRes.headers.get('content-length'));
    if (audioRes.headers.get('content-range'))
      res.setHeader('Content-Range', audioRes.headers.get('content-range'));

    res.status(audioRes.status);
    audioRes.body.pipe(res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── YouTube Search (keep existing) ───────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  const { q, type = 'video', pageToken } = req.query;
  if (!q) return res.json({ items: [], nextPageToken: null });

  const cacheKey = `search_${q}_${type}_${pageToken || ''}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const response = await youtube.search.list({
      part: 'snippet', q, type: 'video',
      maxResults: 20, order: 'relevance',
      pageToken: pageToken || undefined
    });
    const items = response.data.items.map(item => ({
      id: item.id.videoId,
      title: item.snippet.title,
      channel: item.snippet.channelTitle,
      channelId: item.snippet.channelId,
      thumbnail: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.default?.url,
      publishedAt: item.snippet.publishedAt,
      description: item.snippet.description
    }));
    const result = { items, nextPageToken: response.data.nextPageToken || null };
    cache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Search failed', message: err.message });
  }
});

app.get('/api/search/channel', async (req, res) => {
  const { channelName, pageToken } = req.query;
  if (!channelName) return res.json({ items: [] });
  try {
    const channelRes = await youtube.search.list({
      part: 'snippet', q: channelName, type: 'channel', maxResults: 1
    });
    if (!channelRes.data.items?.length) return res.json({ items: [] });
    const channelId = channelRes.data.items[0].id.channelId;
    const videosRes = await youtube.search.list({
      part: 'snippet', channelId, type: 'video', maxResults: 20,
      order: 'date', pageToken: pageToken || undefined
    });
    const items = videosRes.data.items.map(item => ({
      id: item.id.videoId, title: item.snippet.title,
      channel: item.snippet.channelTitle, channelId: item.snippet.channelId,
      thumbnail: item.snippet.thumbnails?.high?.url,
      publishedAt: item.snippet.publishedAt
    }));
    res.json({ items, nextPageToken: videosRes.data.nextPageToken || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/trending', async (req, res) => {
  const cacheKey = 'trending_music';
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);
  try {
    const response = await youtube.videos.list({
      part: 'snippet,statistics', chart: 'mostPopular',
      videoCategoryId: '10', maxResults: 24, regionCode: 'IN'
    });
    const items = response.data.items.map(item => ({
      id: item.id, title: item.snippet.title,
      channel: item.snippet.channelTitle, channelId: item.snippet.channelId,
      thumbnail: item.snippet.thumbnails?.high?.url,
      publishedAt: item.snippet.publishedAt, viewCount: item.statistics?.viewCount
    }));
    const result = { items };
    cache.set(cacheKey, result, 1800);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/video/:id', async (req, res) => {
  const { id } = req.params;
  const cacheKey = `video_${id}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);
  try {
    const response = await youtube.videos.list({
      part: 'snippet,statistics,contentDetails', id
    });
    if (!response.data.items?.length) return res.status(404).json({ error: 'Not found' });
    const item = response.data.items[0];
    const result = {
      id, title: item.snippet.title,
      channel: item.snippet.channelTitle, channelId: item.snippet.channelId,
      thumbnail: item.snippet.thumbnails?.maxres?.url || item.snippet.thumbnails?.high?.url,
      publishedAt: item.snippet.publishedAt,
      description: item.snippet.description,
      duration: item.contentDetails?.duration,
      viewCount: item.statistics?.viewCount,
      likeCount: item.statistics?.likeCount
    };
    cache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── User Settings ─────────────────────────────────────────────────────────────
app.put('/api/user/settings', requireAuth, (req, res) => {
  const { theme, accent } = req.body;
  const db = loadData();
  if (db.users[req.session.user.id]) {
    db.users[req.session.user.id] = { ...db.users[req.session.user.id], theme, accent };
    saveData(db);
  }
  res.json({ ok: true });
});

// ─── Playlist Routes ───────────────────────────────────────────────────────────
app.get('/api/playlists', requireAuth, (req, res) => {
  const db = loadData();
  const userId = req.session.user.id;
  const userPlaylists = Object.values(db.playlists).filter(p => p.userId === userId && !p.isSystem);
  res.json({ playlists: userPlaylists });
});

app.post('/api/playlists', requireAuth, (req, res) => {
  const { name, description, coverColor } = req.body;
  const db = loadData();
  const id = uuidv4();
  const playlist = {
    id, name, description: description || '',
    coverColor: coverColor || '#00d4ff',
    userId: req.session.user.id,
    tracks: [], createdAt: new Date().toISOString(),
    isPublic: false, shareId: uuidv4()
  };
  db.playlists[id] = playlist;
  saveData(db);
  res.json({ playlist });
});

app.get('/api/playlists/:id', (req, res) => {
  const db = loadData();
  const playlist = db.playlists[req.params.id];
  if (!playlist) return res.status(404).json({ error: 'Not found' });
  if (!playlist.isPublic && req.session.user?.id !== playlist.userId)
    return res.status(403).json({ error: 'Private playlist' });
  res.json({ playlist });
});

app.put('/api/playlists/:id', requireAuth, (req, res) => {
  const db = loadData();
  const playlist = db.playlists[req.params.id];
  if (!playlist || playlist.userId !== req.session.user.id)
    return res.status(403).json({ error: 'Forbidden' });
  db.playlists[req.params.id] = { ...playlist, ...req.body, userId: playlist.userId, id: playlist.id };
  saveData(db);
  res.json({ playlist: db.playlists[req.params.id] });
});

app.delete('/api/playlists/:id', requireAuth, (req, res) => {
  const db = loadData();
  const playlist = db.playlists[req.params.id];
  if (!playlist || playlist.userId !== req.session.user.id)
    return res.status(403).json({ error: 'Forbidden' });
  delete db.playlists[req.params.id];
  saveData(db);
  res.json({ ok: true });
});

app.post('/api/playlists/:id/tracks', requireAuth, (req, res) => {
  const { track } = req.body;
  const db = loadData();
  const playlist = db.playlists[req.params.id];
  if (!playlist || playlist.userId !== req.session.user.id)
    return res.status(403).json({ error: 'Forbidden' });
  if (!playlist.tracks.find(t => t.id === track.id)) {
    playlist.tracks.push({ ...track, addedAt: new Date().toISOString() });
    saveData(db);
  }
  res.json({ playlist });
});

app.delete('/api/playlists/:id/tracks/:trackId', requireAuth, (req, res) => {
  const db = loadData();
  const playlist = db.playlists[req.params.id];
  if (!playlist || playlist.userId !== req.session.user.id)
    return res.status(403).json({ error: 'Forbidden' });
  playlist.tracks = playlist.tracks.filter(t => t.id !== req.params.trackId);
  saveData(db);
  res.json({ playlist });
});

app.post('/api/playlists/:id/share', requireAuth, (req, res) => {
  const db = loadData();
  const playlist = db.playlists[req.params.id];
  if (!playlist || playlist.userId !== req.session.user.id)
    return res.status(403).json({ error: 'Forbidden' });
  playlist.isPublic = true;
  if (!playlist.shareId) playlist.shareId = uuidv4();
  saveData(db);
  res.json({ shareUrl: `${FRONTEND_URL}/shared/${playlist.shareId}`, shareId: playlist.shareId });
});

app.get('/api/shared/:shareId', (req, res) => {
  const db = loadData();
  const playlist = Object.values(db.playlists).find(p => p.shareId === req.params.shareId);
  if (!playlist) return res.status(404).json({ error: 'Not found' });
  res.json({ playlist });
});

app.get('/api/liked', requireAuth, (req, res) => {
  const db = loadData();
  const liked = db.playlists[`liked_${req.session.user.id}`];
  res.json({ tracks: liked?.tracks || [] });
});

app.post('/api/liked', requireAuth, (req, res) => {
  const { track } = req.body;
  const db = loadData();
  const key = `liked_${req.session.user.id}`;
  if (!db.playlists[key]) {
    db.playlists[key] = { id: key, name: 'Liked Songs', userId: req.session.user.id, tracks: [], isSystem: true };
  }
  if (!db.playlists[key].tracks.find(t => t.id === track.id)) {
    db.playlists[key].tracks.push({ ...track, addedAt: new Date().toISOString() });
    saveData(db);
  }
  res.json({ ok: true });
});

app.delete('/api/liked/:trackId', requireAuth, (req, res) => {
  const db = loadData();
  const key = `liked_${req.session.user.id}`;
  if (db.playlists[key]) {
    db.playlists[key].tracks = db.playlists[key].tracks.filter(t => t.id !== req.params.trackId);
    saveData(db);
  }
  res.json({ ok: true });
});

// ─── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🎵 NOVA Backend running on http://localhost:${PORT}`);
});
