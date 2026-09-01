const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const searchHandler = require('./api/search.js');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);

  // Vercel Serverless Function Proxy
  if (parsed.pathname === '/api/search') {
    req.query = parsed.query;
    res.status = code => {
      res.statusCode = code;
      return {
        json: data => {
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(data));
        },
        end: () => res.end()
      };
    };
    searchHandler(req, res);
    return;
  }

  // Static File Server
  const file = parsed.pathname === '/' ? 'index.html' : parsed.pathname.slice(1);
  const filePath = path.join(__dirname, file);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(file).toLowerCase();
    const map = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.svg': 'image/svg+xml'
    };
    res.writeHead(200, { 'Content-Type': map[ext] || 'text/plain' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`PIXEL DECK Server running on http://127.0.0.1:${PORT}`);
});
