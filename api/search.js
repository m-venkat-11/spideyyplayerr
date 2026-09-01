const https = require('https');
const crypto = require('crypto');

function decryptJioSaavn(enc) {
  if (!enc) return '';
  try {
    const key = Buffer.from('38346591', 'utf8');
    const decipher = crypto.createDecipheriv('des-ecb', key, null);
    let dec = decipher.update(enc, 'base64', 'utf8');
    dec += decipher.final('utf8');
    return dec.replace('_96.mp4', '_320.mp4');
  } catch (e) {
    return '';
  }
}

function formatTime(sec) {
  if (isNaN(sec) || sec < 0) return '00:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return (m < 10 ? '0' + m : m) + ':' + (s < 10 ? '0' + s : s);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const query = (req.query && (req.query.query || req.query.q)) || 'Coldplay';
  const page = parseInt((req.query && req.query.page) || '1', 10);
  const limit = parseInt((req.query && req.query.limit) || '20', 10);

  const saavnUrl = `https://www.jiosaavn.com/api.php?__call=search.getResults&q=${encodeURIComponent(query)}&_format=json&_marker=0&api_version=4&ctx=web6dot0&n=${limit}&p=${page}`;

  https.get(saavnUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }, (saavnRes) => {
    let data = '';
    saavnRes.on('data', chunk => data += chunk);
    saavnRes.on('end', () => {
      try {
        const json = JSON.parse(data);
        const results = (json.results || []).map(item => {
          const enc = item.more_info?.encrypted_media_url;
          const streamUrl = decryptJioSaavn(enc);
          const rawTitle = (item.title || item.song || '')
            .replace(/&quot;/g, '"')
            .replace(/&amp;/g, '&')
            .replace(/&#039;/g, "'")
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>');
          const rawSubtitle = (item.subtitle || item.primary_artists || '')
            .replace(/&quot;/g, '"')
            .replace(/&amp;/g, '&')
            .replace(/&#039;/g, "'");
          const rawAlbum = (item.more_info?.album || item.album || '')
            .replace(/&quot;/g, '"')
            .replace(/&amp;/g, '&')
            .replace(/&#039;/g, "'");
          const artwork = (item.image || '')
            .replace('150x150', '500x500')
            .replace('50x50', '500x500');

          return {
            id: 'saavn_' + item.id,
            title: rawTitle,
            artist: rawSubtitle,
            album: rawAlbum || 'Single',
            duration: parseInt(item.more_info?.duration || item.duration || '210', 10),
            durationFormatted: formatTime(parseInt(item.more_info?.duration || item.duration || '210', 10)),
            artwork: artwork || 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=300&q=80',
            streamUrl: streamUrl,
            provider: 'jiosaavn',
            sourceType: 'stream'
          };
        }).filter(t => t.streamUrl && t.streamUrl.startsWith('http'));

        return res.status(200).json({
          status: 'success',
          total: json.total || results.length,
          results: results
        });
      } catch (err) {
        return res.status(500).json({ status: 'error', message: err.message });
      }
    });
  }).on('error', (err) => {
    return res.status(500).json({ status: 'error', message: err.message });
  });
};
