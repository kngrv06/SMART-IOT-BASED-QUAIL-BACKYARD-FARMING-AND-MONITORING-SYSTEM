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
  app.all("/api/blynk/:path*", async (req, res) => {
    const blynkToken = process.env.BLYNK_AUTH_TOKEN;
    
    if (!blynkToken || blynkToken === "YOUR_BLYNK_AUTH_TOKEN") {
      console.error("Blynk Error: BLYNK_AUTH_TOKEN is missing or not configured.");
      return res.status(500).json({ 
        error: "BLYNK_AUTH_TOKEN not configured",
        details: "Please add BLYNK_AUTH_TOKEN to your AI Studio Secrets (Settings -> Secrets)."
      });
    }

    // Extract the path from params for reliability
    const blynkPath = (req.params as any).path || "";
    
    // Get the original query string
    const originalQuery = req.url.includes("?") ? req.url.split("?")[1] : "";
    
    // Construct the Blynk URL
    // We try to use regional server if blynk.cloud fails or for better performance
    // For Philippines/Asia, sgp1 is common.
    const blynkUrl = `https://blynk.cloud/external/api/${blynkPath}?token=${blynkToken}${originalQuery ? "&" + originalQuery : ""}`;
    const sgpUrl = `https://sgp1.blynk.cloud/external/api/${blynkPath}?token=${blynkToken}${originalQuery ? "&" + originalQuery : ""}`;

    try {
      console.log(`Blynk Proxy: Fetching ${blynkPath}...`);
      let response = await fetch(blynkUrl, {
        method: req.method,
        headers: req.method === "POST" ? { "Content-Type": "application/json" } : {},
        body: req.method === "POST" ? JSON.stringify(req.body) : undefined,
      });

      // If blynk.cloud returns 404 or fails, try sgp1 (common for Philippines)
      if (!response.ok && response.status === 404) {
        console.log("Blynk Proxy: blynk.cloud returned 404, trying sgp1.blynk.cloud...");
        response = await fetch(sgpUrl, {
          method: req.method,
          headers: req.method === "POST" ? { "Content-Type": "application/json" } : {},
          body: req.method === "POST" ? JSON.stringify(req.body) : undefined,
        });
      }

      const data = await response.text();
      
      if (!response.ok) {
        console.warn(`Blynk API returned ${response.status}: ${data}`);
        // If it's still 404, it might be an invalid token or pin
        if (response.status === 404) {
          return res.status(404).json({ 
            error: "Blynk Resource Not Found", 
            details: "The Auth Token might be invalid or the Virtual Pin does not exist in your template.",
            blynkResponse: data
          });
        }
        return res.status(response.status).send(data);
      }

      try {
        res.json(JSON.parse(data));
      } catch {
        res.send(data);
      }
    } catch (error) {
      console.error("Blynk Proxy Fetch Error:", error);
      res.status(500).json({ error: "Failed to connect to Blynk Cloud" });
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
