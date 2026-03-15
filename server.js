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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const cache = new NodeCache({ stdTTL: 3600 });
const DATA_FILE = path.join(__dirname, 'data.json');

// ─── In-memory DB (file-backed) ───────────────────────────────────────────────
function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    const init = { users: {}, playlists: {}, sharedPlaylists: {} };
    fs.writeFileSync(DATA_FILE, JSON.stringify(init, null, 2));
    return init;
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ─── Config ───────────────────────────────────────────────────────────────────
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'YOUR_GOOGLE_CLIENT_ID';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'YOUR_GOOGLE_CLIENT_SECRET';
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || 'YOUR_YOUTUBE_API_KEY';
const REDIRECT_URI = 'https://nova-music-backend-production.up.railway.app/auth/google/callback';
const SESSION_SECRET = process.env.SESSION_SECRET || 'nova-music-secret-2024';

const oauth2Client = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT_URI);
const youtube = google.youtube({ version: 'v3', auth: YOUTUBE_API_KEY });

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: ['http://localhost:3000', 'https://nova-music-frontend.vercel.app'], credentials: true }));
app.use(express.json());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: true, sameSite: 'none', maxAge: 30 * 24 * 60 * 60 * 1000 }
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
        id: payload.sub,
        name: payload.name,
        email: payload.email,
        picture: payload.picture,
        theme: 'dark',
        accent: 'cyan',
        createdAt: new Date().toISOString()
      };
      saveData(db);
    }
    req.session.user = { id: payload.sub, name: payload.name, email: payload.email, picture: payload.picture };
    res.redirect('https://nova-music-frontend.vercel.app/home');
  } catch (err) {
    console.error(err);
    res.redirect('https://nova-music-frontend.vercel.app/?error=auth_failed');
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

// ─── YouTube Search ────────────────────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  const { q, type = 'video', pageToken } = req.query;
  if (!q) return res.json({ items: [], nextPageToken: null });

  const cacheKey = `search_${q}_${type}_${pageToken || ''}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const params = {
      part: 'snippet',
      q,
      type: 'video',
      maxResults: 20,
      order: 'relevance',
      videoCategoryId: type === 'music' ? '10' : undefined,
      pageToken: pageToken || undefined
    };
    const response = await youtube.search.list(params);
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
    console.error('YouTube search error:', err.message);
    res.status(500).json({ error: 'Search failed', message: err.message });
  }
});

// Search by channel
app.get('/api/search/channel', async (req, res) => {
  const { channelName, pageToken } = req.query;
  if (!channelName) return res.json({ items: [] });

  try {
    // First find the channel
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
      id: item.id.videoId,
      title: item.snippet.title,
      channel: item.snippet.channelTitle,
      channelId: item.snippet.channelId,
      thumbnail: item.snippet.thumbnails?.high?.url,
      publishedAt: item.snippet.publishedAt,
      description: item.snippet.description
    }));
    res.json({ items, nextPageToken: videosRes.data.nextPageToken || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get trending / new releases
app.get('/api/trending', async (req, res) => {
  const cacheKey = 'trending_music';
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const response = await youtube.videos.list({
      part: 'snippet,statistics',
      chart: 'mostPopular',
      videoCategoryId: '10',
      maxResults: 24,
      regionCode: 'IN'
    });
    const items = response.data.items.map(item => ({
      id: item.id,
      title: item.snippet.title,
      channel: item.snippet.channelTitle,
      channelId: item.snippet.channelId,
      thumbnail: item.snippet.thumbnails?.high?.url,
      publishedAt: item.snippet.publishedAt,
      viewCount: item.statistics?.viewCount
    }));
    const result = { items };
    cache.set(cacheKey, result, 1800);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get video details
app.get('/api/video/:id', async (req, res) => {
  const { id } = req.params;
  const cacheKey = `video_${id}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const response = await youtube.videos.list({
      part: 'snippet,statistics,contentDetails',
      id
    });
    if (!response.data.items?.length) return res.status(404).json({ error: 'Not found' });
    const item = response.data.items[0];
    const result = {
      id,
      title: item.snippet.title,
      channel: item.snippet.channelTitle,
      channelId: item.snippet.channelId,
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
  const userPlaylists = Object.values(db.playlists).filter(p => p.userId === userId);
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
    tracks: [],
    createdAt: new Date().toISOString(),
    isPublic: false,
    shareId: uuidv4()
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

// Share playlist
app.post('/api/playlists/:id/share', requireAuth, (req, res) => {
  const db = loadData();
  const playlist = db.playlists[req.params.id];
  if (!playlist || playlist.userId !== req.session.user.id)
    return res.status(403).json({ error: 'Forbidden' });
  playlist.isPublic = true;
  if (!playlist.shareId) playlist.shareId = uuidv4();
  saveData(db);
  res.json({ shareUrl: `https://nova-music-frontend.vercel.app/shared/${playlist.shareId}`, shareId: playlist.shareId });
});

app.get('/api/shared/:shareId', (req, res) => {
  const db = loadData();
  const playlist = Object.values(db.playlists).find(p => p.shareId === req.params.shareId);
  if (!playlist) return res.status(404).json({ error: 'Not found' });
  res.json({ playlist });
});

// Liked songs
app.get('/api/liked', requireAuth, (req, res) => {
  const db = loadData();
  const userId = req.session.user.id;
  const liked = db.playlists[`liked_${userId}`];
  res.json({ tracks: liked?.tracks || [] });
});

app.post('/api/liked', requireAuth, (req, res) => {
  const { track } = req.body;
  const db = loadData();
  const userId = req.session.user.id;
  const key = `liked_${userId}`;
  if (!db.playlists[key]) {
    db.playlists[key] = { id: key, name: 'Liked Songs', userId, tracks: [], isSystem: true };
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

// ─── Download Route ────────────────────────────────────────────────────────────
// Requires: pip install yt-dlp  AND  ffmpeg installed on system PATH
app.get('/api/download', requireAuth, async (req, res) => {
  const { videoId, format = 'mp3', quality = '192' } = req.query;
  if (!videoId) return res.status(400).json({ error: 'videoId required' });

  try {
    const { execFile } = await import('child_process');
    const os = await import('os');
    const tmpDir = os.tmpdir();
    const outTemplate = path.join(tmpDir, `nova_${videoId}_%(title)s.%(ext)s`);
    const url = `https://www.youtube.com/watch?v=${videoId}`;

    let ytdlpArgs = [];

    if (format === 'mp4' || format === 'webm') {
      // Video download
      const heightMap = { '1080': 1080, '720': 720, '480': 480 };
      const height = heightMap[quality] || 720;
      ytdlpArgs = [
        url,
        '-f', `bestvideo[height<=${height}][ext=${format}]+bestaudio/best[height<=${height}]`,
        '--merge-output-format', format,
        '-o', outTemplate,
        '--no-playlist'
      ];
    } else {
      // Audio download
      const bitrateMap = { '320': '320K', '192': '192K', '128': '128K', 'best': '0', 'high': '256K', 'medium': '128K' };
      const bitrate = bitrateMap[quality] || '192K';
      const audioCodec = format === 'wav' ? 'wav' : format === 'ogg' ? 'vorbis' : 'mp3';
      ytdlpArgs = [
        url,
        '-x',
        '--audio-format', format === 'wav' ? 'wav' : format === 'ogg' ? 'vorbis' : 'mp3',
        '--audio-quality', bitrate,
        '-o', outTemplate,
        '--no-playlist'
      ];
    }

    // Run yt-dlp
    await new Promise((resolve, reject) => {
      execFile('yt-dlp', ytdlpArgs, { timeout: 120000 }, (err, stdout, stderr) => {
        if (err) reject(new Error(`yt-dlp failed: ${stderr || err.message}`));
        else resolve(stdout);
      });
    });

    // Find the downloaded file
    const files = fs.readdirSync(tmpDir).filter(f => f.startsWith(`nova_${videoId}_`));
    if (!files.length) return res.status(500).json({ error: 'File not found after download' });

    const filePath = path.join(tmpDir, files[0]);
    const filename = files[0].replace(`nova_${videoId}_`, '');

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', format === 'mp4' ? 'video/mp4' : format === 'wav' ? 'audio/wav' : format === 'ogg' ? 'audio/ogg' : 'audio/mpeg');

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    stream.on('end', () => {
      // Clean up temp file
      try { fs.unlinkSync(filePath); } catch {}
    });

  } catch (err) {
    console.error('Download error:', err.message);
    res.status(500).json({ 
      error: 'Download failed', 
      message: err.message.includes('yt-dlp') 
        ? 'yt-dlp not installed. Run: pip install yt-dlp' 
        : err.message 
    });
  }
});

// ─── 8D Audio Stream Route ─────────────────────────────────────────────────────
// Requires: yt-dlp + ffmpeg installed
// This streams YouTube audio processed with TRUE 8D binaural effects via ffmpeg
app.get('/api/stream8d/:videoId', requireAuth, async (req, res) => {
  const { videoId } = req.params;
  if (!videoId) return res.status(400).json({ error: 'videoId required' });

  try {
    const { spawn, execFile } = await import('child_process');

    // First get the direct audio URL from yt-dlp
    const audioUrl = await new Promise((resolve, reject) => {
      execFile('yt-dlp', [
        `https://www.youtube.com/watch?v=${videoId}`,
        '-x', '-g', '--audio-format', 'mp3', '--no-playlist'
      ], { timeout: 30000 }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout.trim().split('\n')[0]);
      });
    });

    // Set headers for audio streaming
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');

    // ffmpeg 8D audio processing chain:
    // apulsator    = tremolo LFO rotation (0.08 Hz = slow pan)
    // aecho        = reverb simulation (concert hall)
    // equalizer    = bass boost at 60Hz
    // stereotools  = stereo widening
    // loudnorm     = normalize output volume
    const ffmpeg = spawn('ffmpeg', [
      '-i', audioUrl,
      '-af', [
        'apulsator=hz=0.08:offset=0',           // 8D rotation LFO
        'aecho=1.0:0.7:60:0.25',                // room reverb
        'equalizer=f=60:t=o:w=2:g=5',           // bass boost
        'equalizer=f=8000:t=o:w=2:g=2',         // air boost (brightness)
        'stereotools=mlev=0.03',                 // stereo width
        'loudnorm=I=-16:TP=-1.5:LRA=11'         // normalize
      ].join(','),
      '-f', 'mp3',
      '-ab', '192k',
      'pipe:1'
    ]);

    ffmpeg.stdout.pipe(res);
    ffmpeg.stderr.on('data', () => {}); // suppress ffmpeg logs
    ffmpeg.on('error', err => {
      console.error('ffmpeg error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'ffmpeg not installed' });
    });
    req.on('close', () => ffmpeg.kill('SIGKILL'));

  } catch (err) {
    console.error('8D stream error:', err.message);
    res.status(500).json({ 
      error: 'Streaming failed',
      message: err.message.includes('yt-dlp') ? 'Install yt-dlp: pip install yt-dlp' : err.message
    });
  }
});

// ─── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🎵 NOVA Backend running on http://localhost:${PORT}`);
  console.log(`📋 Configure your API keys in .env file\n`);
});
