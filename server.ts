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
    app.all("/api/blynk/*", async (req, res) => {
        let blynkToken = process.env.BLYNK_AUTH_TOKEN;
        
        if (!blynkToken || blynkToken === "YOUR_BLYNK_AUTH_TOKEN") {
            console.error("Blynk Error: BLYNK_AUTH_TOKEN is missing or not configured.");
            return res.status(500).json({ 
                error: "BLYNK_AUTH_TOKEN not configured",
                details: "Please add BLYNK_AUTH_TOKEN to your AI Studio Secrets (Settings -> Secrets)."
            });
        }

        blynkToken = blynkToken.trim();
        // In Express 5, the wildcard '*' is captured in req.params[0]
        const blynkPath = (req.params as any)[0] || "";
        
        // Reconstruct query string from req.query to be safe
        const queryParams = new URLSearchParams();
        for (const [key, value] of Object.entries(req.query)) {
            if (typeof value === 'string') {
                queryParams.append(key, value);
            } else if (Array.isArray(value)) {
                value.forEach(v => queryParams.append(key, String(v)));
            }
        }
        const queryString = queryParams.toString();

        const servers = [
            "blynk.cloud",
            "sgp1.blynk.cloud",
            "fra1.blynk.cloud",
            "ny3.blynk.cloud",
            "blr1.blynk.cloud"
        ];

        console.log(`Blynk Proxy: [${req.method}] ${blynkPath} | Token Len: ${blynkToken.length} | Query: ${queryString}`);

        let lastResponseData = null;
        let lastStatus = 404;

        for (const server of servers) {
            const blynkUrl = `https://${server}/external/api/${blynkPath}?token=${blynkToken}${queryString ? "&" + queryString : ""}`;
            
            try {
                const response = await fetch(blynkUrl, {
                    method: req.method,
                    headers: req.method === "POST" ? { "Content-Type": "application/json" } : {},
                    body: req.method === "POST" ? JSON.stringify(req.body) : undefined,
                });

                const data = await response.text();
                lastStatus = response.status;
                lastResponseData = data;

                if (response.ok) {
                    try {
                        return res.json(JSON.parse(data));
                    } catch {
                        return res.send(data);
                    }
                }

                // If it's a 400 or 403, it's likely a real error we should stop at
                if (response.status !== 404) {
                    console.warn(`Blynk Proxy: ${server} returned ${response.status}: ${data}`);
                    return res.status(response.status).send(data);
                }
            } catch (error) {
                console.error(`Blynk Proxy: Error connecting to ${server}:`, error);
            }
        }

        res.status(lastStatus).json({
            error: "Blynk Connection Failed",
            details: "Resource not found on any Blynk regional server. Check your Token and Virtual Pins.",
            blynkResponse: lastResponseData
        });
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
    app.get("*all", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
