import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const app = express();

// Hardcoded Blynk Auth Token (or use process.env.BLYNK_AUTH_TOKEN in Vercel)
const BLYNK_AUTH_TOKEN = "at2L15c2T-cBRodKkRS0BW8DMWT_hmpL"; 
const BLYNK_BASE_URL = 'https://blynk.cloud/external/api';

// Blynk Proxy API
app.get('/api/blynk/:action', async (req, res) => {
  const { action } = req.params;
  
  if (!BLYNK_AUTH_TOKEN) {
    return res.status(500).json({ error: 'BLYNK_AUTH_TOKEN is not configured.' });
  }

  const queryParams = new URLSearchParams();
  queryParams.append('token', BLYNK_AUTH_TOKEN);
  
  for (const [key, value] of Object.entries(req.query)) {
    if (value === '') {
      queryParams.append(key, '');
    } else {
      queryParams.append(key, value as string);
    }
  }

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

// For local testing
if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
  const PORT = 3000;
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

export default app;
