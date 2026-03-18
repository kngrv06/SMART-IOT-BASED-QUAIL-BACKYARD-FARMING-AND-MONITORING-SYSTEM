import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Blynk Proxy Endpoint
  // This allows the frontend to call Blynk without exposing the Auth Token
  app.all("/api/blynk/:path*", async (req, res) => {
    const blynkToken = process.env.BLYNK_AUTH_TOKEN;
    if (!blynkToken) {
      return res.status(500).json({ error: "BLYNK_AUTH_TOKEN not configured in backend" });
    }

    // Extract the path after /api/blynk/
    // Example: /api/blynk/get?v0 -> blynk.cloud/external/api/get?token=...&v0
    const blynkPath = req.path.replace("/api/blynk/", "");
    
    // Get the original query string from the request URL
    const originalQuery = req.url.includes("?") ? req.url.split("?")[1] : "";
    
    // Construct the Blynk URL by prepending the token to the original query
    const blynkUrl = `https://blynk.cloud/external/api/${blynkPath}?token=${blynkToken}${originalQuery ? "&" + originalQuery : ""}`;

    try {
      const response = await fetch(blynkUrl, {
        method: req.method,
        headers: req.method === "POST" ? { "Content-Type": "application/json" } : {},
        body: req.method === "POST" ? JSON.stringify(req.body) : undefined,
      });

      const data = await response.text();
      
      // Try to parse as JSON if possible, otherwise send as text
      try {
        res.json(JSON.parse(data));
      } catch {
        res.send(data);
      }
    } catch (error) {
      console.error("Blynk Proxy Error:", error);
      res.status(500).json({ error: "Failed to connect to Blynk" });
    }
  });

  // API Health Check
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
