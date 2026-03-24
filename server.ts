import express from 'express';
import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Hardcoded Blynk Auth Token
const BLYNK_AUTH_TOKEN = "at2L15c2T-cBRodKkRS0BW8DMWT_hmpL"; 
const BLYNK_BASE_URL = 'https://blynk.cloud/external/api';

const app = express();

// --- Background Logging System ---
let hourlyLogs: any[] = [];
const MAX_LOGS = 24; // Keep last 24 hours

async function logSensorData() {
  if (!BLYNK_AUTH_TOKEN) return;

  try {
    // Fetch V0 (Temp), V1 (Hum), V2 (Ammonia)
    const url = `${BLYNK_BASE_URL}/get?token=${BLYNK_AUTH_TOKEN}&V0&V1&V2`;
    const response = await axios.get(url);
    const data = response.data;

    const now = new Date();
    const timeStr = now.getHours().toString().padStart(2, '0') + ":00";
    const dateStr = now.toISOString().split('T')[0];

    const entry = {
      time: timeStr,
      date: dateStr,
      temp: parseFloat(data.V0) || 0,
      hum: parseFloat(data.V1) || 0,
      amm: parseFloat(data.V2) || 0,
      eggs: 0, // Eggs are usually manual, default to 0 for server logs
      timestamp: now.getTime()
    };

    hourlyLogs.push(entry);
    if (hourlyLogs.length > MAX_LOGS) {
      hourlyLogs.shift();
    }
    console.log(`[Server Log] Data recorded at ${timeStr}`);
  } catch (error: any) {
    console.error("[Server Log] Failed to fetch data for logging:", error.message);
  }
}

// Start background task: Check every minute, log on the hour
setInterval(() => {
  const now = new Date();
  if (now.getMinutes() === 0) {
    logSensorData();
  }
}, 60000);

// Initial log on startup
logSensorData();

async function startServer() {
  const PORT = 3000;

  // History API
  app.get('/api/history', (req, res) => {
    res.json(hourlyLogs);
  });

  // Blynk Proxy API
  app.get('/api/blynk/:action', async (req, res) => {
    const { action } = req.params;
    
    if (!BLYNK_AUTH_TOKEN) {
      return res.status(500).json({ error: 'BLYNK_AUTH_TOKEN is not configured in the backend.' });
    }

    // Construct the query parameters for Blynk
    const queryParams = new URLSearchParams();
    queryParams.append('token', BLYNK_AUTH_TOKEN);
    
    // Add all incoming query parameters from the frontend
    // We handle keys without values (like V0, V1) specifically for Blynk
    for (const [key, value] of Object.entries(req.query)) {
      if (value === '') {
        // For Blynk multiple pin get: ?V0&V1
        queryParams.append(key, '');
      } else {
        queryParams.append(key, value as string);
      }
    }

    // Clean up the URL: URLSearchParams adds '=' even for empty values (e.g., V0=)
    // Blynk is usually fine with V0=, but we'll make it cleaner
    let queryString = queryParams.toString().replace(/=(?=&|$)/g, '');
    const blynkUrl = `${BLYNK_BASE_URL}/${action}?${queryString}`;

    try {
      const response = await axios.get(blynkUrl);
      res.status(response.status).send(response.data);
    } catch (error: any) {
      console.error(`Blynk Proxy Error (${action}):`, error.message);
      if (error.response) {
        res.status(error.response.status).send(error.response.data);
      } else {
        res.status(500).json({ error: 'Failed to connect to Blynk Cloud API' });
      }
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Only listen if not running as a Vercel function
  if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Server running on http://localhost:${PORT}`);
      if (!BLYNK_AUTH_TOKEN) {
        console.warn('WARNING: BLYNK_AUTH_TOKEN is not set. Blynk integration will not work.');
      }
    });
  }
}

startServer();

export default app;
