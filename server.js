const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { spawn } = require('child_process');

// Zero-dependency .env loader
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    envContent.split('\n').forEach(line => {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match) {
        const key = match[1];
        let val = match[2] || '';
        val = val.trim().replace(/^['"]|['"]$/g, '');
        if (!process.env[key]) process.env[key] = val;
      }
    });
  }
} catch (_) {}

const searchHandler = require('./api/search.js');

const PORT = process.env.PORT || 3000;
const PYTHON_SERVICE_PORT = process.env.SEARCH_SERVICE_PORT || 5005;

let pythonServiceProcess = null;

// Function to check if Python search microservice is already running
function checkPythonService(callback) {
  const req = http.request({
    hostname: '127.0.0.1',
    port: PYTHON_SERVICE_PORT,
    path: '/health',
    method: 'GET',
    timeout: 1500
  }, (res) => {
    callback(res.statusCode === 200);
  });

  req.on('error', () => callback(false));
  req.on('timeout', () => {
    req.destroy();
    callback(false);
  });
  req.end();
}

// Function to auto-spawn Python search microservice
function startPythonService() {
  checkPythonService((isRunning) => {
    if (isRunning) {
      console.log(`[PIXEL DECK] Python Search Microservice already active on port ${PYTHON_SERVICE_PORT}`);
      return;
    }

    console.log(`[PIXEL DECK] Launching Python ytmusicapi search service on port ${PYTHON_SERVICE_PORT}...`);
    const scriptPath = path.join(__dirname, 'search_service.py');
    pythonServiceProcess = spawn('python', [scriptPath], {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    pythonServiceProcess.stdout.on('data', (data) => {
      process.stdout.write(data.toString());
    });

    pythonServiceProcess.stderr.on('data', (data) => {
      process.stderr.write(data.toString());
    });

    pythonServiceProcess.on('close', (code) => {
      console.log(`[PIXEL DECK] Python Search Microservice exited with code ${code}`);
      pythonServiceProcess = null;
    });
  });
}

// Start microservice
startPythonService();

// Clean up child process on exit
function cleanup() {
  if (pythonServiceProcess) {
    try {
      pythonServiceProcess.kill();
    } catch (_) {}
  }
  process.exit();
}
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('exit', cleanup);

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);

  // Universal CORS support (permits file:/// and external dev ports)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  // Vercel Serverless Function Proxy / API Router
  if (parsed.pathname === '/api/search') {
    req.query = parsed.query;
    res.status = code => {
      res.statusCode = code;
      return {
        json: data => {
          if (!res.headersSent) {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify(data));
          }
        },
        end: () => {
          if (!res.headersSent) res.end();
        }
      };
    };

    try {
      Promise.resolve(searchHandler(req, res)).catch(err => {
        console.error('API Search Error:', err);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ status: 'error', code: 'SERVER_ERROR', message: err.message, results: [] }));
        }
      });
    } catch (err) {
      console.error('Sync Search Error:', err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ status: 'error', code: 'SERVER_ERROR', message: err.message, results: [] }));
      }
    }
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
      '.html': 'text/html; charset=UTF-8',
      '.js': 'application/javascript; charset=UTF-8',
      '.css': 'text/css; charset=UTF-8',
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
