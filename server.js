import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import session from 'express-session';
import { OAuth2Client } from 'google-auth-library';
import NodeCache from 'node-cache';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import CryptoJS from 'crypto-js';

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

// Helper for JioSaavn decryption
function decryptSaavnUrl(encryptedUrl) {
  try {
    const key = CryptoJS.enc.Utf8.parse('38346591');
    const dec = CryptoJS.DES.decrypt(
      { ciphertext: CryptoJS.enc.Base64.parse(encryptedUrl) },
      key,
      { mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.Pkcs7 }
    );
    return dec.toString(CryptoJS.enc.Utf8).replace('_96.mp4', '_320.mp4');
  } catch (err) {
    return null;
  }
}

// Build a proxied stream URL (avoids CORS blocking in browser)
const BACKEND_URL = process.env.NODE_ENV === 'production'
  ? 'https://nova-music-backend-production.up.railway.app'
  : 'http://localhost:3001';

function proxyStreamUrl(encryptedUrl, id) {
  if (!encryptedUrl) return null;
  // Store decrypted URL in a short-lived cache keyed by id so proxy can look it up
  const raw = decryptSaavnUrl(encryptedUrl);
  if (!raw) return null;
  cache.set(`stream_${id}`, raw, 3600);
  return `${BACKEND_URL}/api/stream/${id}`;
}

// ─── Audio Stream Proxy (solves CORS) ────────────────────────────────────────
app.get('/api/stream/:id', async (req, res) => {
  const { id } = req.params;
  let cdnUrl = cache.get(`stream_${id}`);

  // Re-fetch from Saavn if not cached
  if (!cdnUrl) {
    try {
      const detailRes = await fetch(`https://www.jiosaavn.com/api.php?__call=song.getDetails&pids=${id}&_format=json&_marker=0&ctx=web6dot0`);
      const detailData = await detailRes.json();
      const song = (detailData.songs || [])[0];
      if (!song) return res.status(404).send('Not found');
      cdnUrl = decryptSaavnUrl(song.encrypted_media_url);
      if (cdnUrl) cache.set(`stream_${id}`, cdnUrl, 3600);
    } catch { return res.status(500).send('Failed to resolve stream'); }
  }

  if (!cdnUrl) return res.status(404).send('Stream URL not available');

  try {
    // Support range requests for seeking
    const headers = { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.jiosaavn.com/' };
    if (req.headers.range) headers['Range'] = req.headers.range;

    const upstream = await fetch(cdnUrl, { headers });
    const status = req.headers.range ? 206 : 200;

    res.writeHead(status, {
      'Content-Type': upstream.headers.get('Content-Type') || 'audio/mp4',
      'Content-Length': upstream.headers.get('Content-Length') || '',
      'Content-Range': upstream.headers.get('Content-Range') || '',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    });

    const reader = upstream.body.getReader();
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) { res.end(); break; }
        if (!res.write(value)) await new Promise(r => res.once('drain', r));
      }
    };
    pump().catch(() => res.end());
    req.on('close', () => reader.cancel());
  } catch (err) {
    if (!res.headersSent) res.status(500).send('Stream proxy error');
  }
});


// ─── JioSaavn Search & Endpoints ───────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json({ items: [] });
  try {
    const searchRes = await fetch(`https://www.jiosaavn.com/api.php?__call=search.getResults&q=${encodeURIComponent(q)}&n=20&p=1&_format=json&_marker=0&ctx=web6dot0`);
    const searchData = await searchRes.json();
    if (!searchData.results || !searchData.results.length) return res.json({ items: [] });
    
    // Fetch precise song details needed for duration & streaming urls
    const pids = searchData.results.map(r => r.id).join(',');
    const detailRes = await fetch(`https://www.jiosaavn.com/api.php?__call=song.getDetails&pids=${pids}&_format=json&_marker=0&ctx=web6dot0`);
    const detailData = await detailRes.json();
    
    const items = [];
    const songs = detailData.songs || [];
    for (const song of songs) {
      if (!song || !song.encrypted_media_url) continue;
      const streamUrl = proxyStreamUrl(song.encrypted_media_url, song.id);
      items.push({
        id: song.id,
        title: song.song,
        channel: song.primary_artists || song.singers,
        channelId: song.primary_artists_id,
        thumbnail: song.image.replace('150x150', '500x500'),
        publishedAt: song.year,
        description: song.album,
        duration: parseInt(song.duration, 10),
        streamUrl
      });
    }
    
    res.json({ items, nextPageToken: null });
  } catch (err) {
    res.status(500).json({ error: 'Search failed', message: err.message });
  }
});

app.get('/api/search/channel', async (req, res) => {
  res.json({ items: [] }); // Compatibility stub
});

app.get('/api/trending', async (req, res) => {
  const cacheKey = 'trending_saavn';
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);
  try {
    // Fetch top Bollywood/Global chart directly
    const chartRes = await fetch('https://www.jiosaavn.com/api.php?__call=content.getBrowseModules&_format=json&_marker=0&ctx=web6dot0&api_version=4');
    const chartData = await chartRes.json();

    // Try to find trending songs list
    let songs = [];
    const topCharts = chartData?.trending?.songs || chartData?.charts;
    if (topCharts && topCharts.length > 0) {
      const chart = topCharts[0];
      const plId = chart.id || chart.listid;
      const plRes = await fetch(`https://www.jiosaavn.com/api.php?__call=playlist.getDetails&listid=${plId}&_format=json&_marker=0&ctx=web6dot0`);
      const plData = await plRes.json();
      songs = plData.songs || [];
    }

    // Fallback: top Bollywood hits by search
    if (!songs.length) {
      const srRes = await fetch('https://www.jiosaavn.com/api.php?__call=search.getResults&q=top%20bollywood%20hits%202024&n=20&p=1&_format=json&_marker=0&ctx=web6dot0');
      const srData = await srRes.json();
      const pids = (srData.results || []).map(r => r.id).join(',');
      if (pids) {
        const detRes = await fetch(`https://www.jiosaavn.com/api.php?__call=song.getDetails&pids=${pids}&_format=json&_marker=0&ctx=web6dot0`);
        const detData = await detRes.json();
        songs = detData.songs || [];
      }
    }

    const items = songs
      .filter(song => song && song.encrypted_media_url)
      .map(song => ({
        id: song.id,
        title: song.song || song.title,
        channel: song.primary_artists || song.singers || song.subtitle,
        thumbnail: (song.image || '').replace('150x150', '500x500'),
        duration: parseInt(song.duration || 0, 10) || 0,
        streamUrl: proxyStreamUrl(song.encrypted_media_url, song.id)
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
  try {
    const detailRes = await fetch(`https://www.jiosaavn.com/api.php?__call=song.getDetails&pids=${id}&_format=json&_marker=0&ctx=web6dot0`);
    const detailData = await detailRes.json();
    const song = (detailData.songs || [])[0];
    if (!song) return res.status(404).json({ error: 'Not found' });
    
    const result = {
      id: song.id, title: song.song,
      channel: song.primary_artists || song.singers,
      thumbnail: song.image.replace('150x150', '500x500'),
      description: song.album,
      duration: parseInt(song.duration, 10),
      streamUrl: proxyStreamUrl(song.encrypted_media_url, song.id)
    };
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

app.listen(PORT, async () => {
  console.log(`\n🎵 NOVA Premium Backend running on http://localhost:${PORT}`);
});
