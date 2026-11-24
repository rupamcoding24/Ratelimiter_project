require("dotenv").config();

const express = require("express");
const { MongoClient } = require("mongodb");

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 3000);
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017";
const DB_NAME = process.env.DB_NAME || "rate_limiter_db";
const REQUEST_LIMIT = Number(process.env.REQUEST_LIMIT || 5);
const WINDOW_MS = Number(process.env.WINDOW_MS || 60_000);

let requestsCollection;

async function connectDatabase() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();

  const db = client.db(DB_NAME);
  requestsCollection = db.collection("rate_limit_windows");

  // MongoDB removes expired documents in the background.
  await requestsCollection.createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0 }
  );

  console.log(`Connected to MongoDB database: ${DB_NAME}`);
}

async function rateLimiter(req, res, next) {
  try {
    const now = Date.now();
    const windowStartMs = Math.floor(now / WINDOW_MS) * WINDOW_MS;
    const expiresAtMs = windowStartMs + WINDOW_MS;

    // For a real application, prefer a verified account/user ID.
    const clientId = req.ip || "unknown";
    const documentId = `${clientId}:${windowStartMs}`;

    // $inc makes the counter update atomic for this document.
    const updatedDocument = await requestsCollection.findOneAndUpdate(
      { _id: documentId },
      {
        $inc: { count: 1 },
        $setOnInsert: {
          clientId,
          windowStart: new Date(windowStartMs),
          expiresAt: new Date(expiresAtMs)
        }
      },
      {
        upsert: true,
        returnDocument: "after"
      }
    );

    const currentCount = updatedDocument.count;
    const remaining = Math.max(REQUEST_LIMIT - currentCount, 0);
    const retryAfterSeconds = Math.max(
      Math.ceil((expiresAtMs - now) / 1000),
      1
    );

    res.set("X-RateLimit-Limit", String(REQUEST_LIMIT));
    res.set("X-RateLimit-Remaining", String(remaining));
    res.set("X-RateLimit-Reset", String(Math.ceil(expiresAtMs / 1000)));

    if (currentCount > REQUEST_LIMIT) {
      res.set("Retry-After", String(retryAfterSeconds));
      return res.status(429).json({
        success: false,
        message: "Rate limit exceeded. Please try again later.",
        limit: REQUEST_LIMIT,
        windowSeconds: Math.ceil(WINDOW_MS / 1000),
        retryAfterSeconds
      });
    }

    next();
  } catch (error) {
    console.error("Rate limiter error:", error);
    return res.status(503).json({
      success: false,
      message: "Rate-limiting service is temporarily unavailable."
    });
  }
}

app.get("/health", (req, res) => {
  res.json({ success: true, message: "Server is running." });
});

app.get("/api/demo", rateLimiter, (req, res) => {
  res.json({
    success: true,
    message: "Request accepted."
  });
});

connectDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server running at http://localhost:${PORT}`);
      console.log(
        `Limit: ${REQUEST_LIMIT} requests per ${WINDOW_MS / 1000} seconds`
      );
    });
  })
  .catch((error) => {
    console.error("Could not start application:", error);
    process.exit(1);
  });
