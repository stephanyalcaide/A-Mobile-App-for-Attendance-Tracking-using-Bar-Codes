/**
 * FlyBy — Express REST API Backend
 * Firebase Cloud Functions (Node.js 20, 1st Gen)
 *
 * Architecture:
 *   - Single Express app exported as `api` (handles all HTTP routes)
 *   - Scheduled `autoCloseSessions` kept separate (not HTTP traffic)
 *
 * Security layers (outermost → innermost):
 *   1. CORS           — whitelist allowed origins
 *   2. helmetHeaders  — harden HTTP response headers
 *   3. authenticate   — verify Firebase Auth ID token on every request
 *   4. Route handler  — actual business logic
 *   5. errorHandler   — catch-all, never leaks stack traces to client
 */

"use strict";

const functions   = require("firebase-functions");
const admin       = require("firebase-admin");
const express     = require("express");
const cors        = require("cors");

admin.initializeApp();
const db = admin.firestore();

/* ═══════════════════════════════════════════════════════════════
   APP INIT
═══════════════════════════════════════════════════════════════ */

const app = express();

/* ═══════════════════════════════════════════════════════════════
   MIDDLEWARE 1 — CORS
   Only the GitHub Pages frontend (and localhost for dev) may call
   this API. Any other origin gets rejected before it touches a route.
═══════════════════════════════════════════════════════════════ */

const ALLOWED_ORIGINS = [
  "https://tenjusu.github.io",
  "http://localhost:3000", // dev only — remove in production
];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (e.g. mobile apps, Postman during dev)
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS: origin '${origin}' not allowed`));
    }
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

app.use(express.json({ limit: "16kb" })); // reject absurdly large payloads

/* ═══════════════════════════════════════════════════════════════
   MIDDLEWARE 2 — SECURITY HEADERS (Helmet-style, manual)
   Sets defensive HTTP headers without requiring the helmet package.
   Prevents common attacks: clickjacking, MIME sniffing, XSS, etc.
═══════════════════════════════════════════════════════════════ */

function helmetHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options",    "nosniff");
  res.setHeader("X-Frame-Options",           "DENY");
  res.setHeader("X-XSS-Protection",          "1; mode=block");
  res.setHeader("Referrer-Policy",           "strict-origin-when-cross-origin");
  res.setHeader("Content-Security-Policy",   "default-src 'none'");
  res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  // Never cache API responses — attendance data is always real-time
  res.setHeader("Cache-Control",             "no-store");
  next();
}

app.use(helmetHeaders);

/* ═══════════════════════════════════════════════════════════════
   MIDDLEWARE 3 — AUTHENTICATION
   Every protected route must include a valid Firebase Auth ID token
   in the Authorization header:
     Authorization: Bearer <Firebase ID token>

   The token is verified against Firebase's public keys server-side.
   No token = 401. Bad token = 401. Expired token = 401.
   On success, the decoded token payload is attached to req.user so
   route handlers can check the professor's email, uid, etc.
═══════════════════════════════════════════════════════════════ */

async function authenticate(req, res, next) {
  const authHeader = req.headers["authorization"] || "";

  if (!authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized: no token provided" });
  }

  const idToken = authHeader.split("Bearer ")[1].trim();

  try {
    // Verifies signature + expiry against Firebase's public certs
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.user = decoded; // { uid, email, name, ... }
    next();
  } catch (err) {
    // Distinguish expired vs genuinely invalid
    const reason = err.code === "auth/id-token-expired"
      ? "Token expired — please sign in again"
      : "Unauthorized: invalid token";
    return res.status(401).json({ error: reason });
  }
}

/* ═══════════════════════════════════════════════════════════════
   ROUTES
═══════════════════════════════════════════════════════════════ */

/* ── Health check (public, no auth) ───────────────────────── */
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", ts: new Date().toISOString() });
});

/* ── POST /scan ────────────────────────────────────────────
   Placeholder: receives a scanned barcode and marks the student
   present in the active session for that class.

   Expected body:
     { sessionId: string, barcodeValue: string, classId: string }

   Security: requires auth. Professor's email from token is logged
   so every scan is attributable to a specific authenticated user.
──────────────────────────────────────────────────────────── */
app.post("/scan", authenticate, async (req, res, next) => {
  try {
    const { sessionId, barcodeValue, classId } = req.body;

    if (!sessionId || !barcodeValue) {
      return res.status(400).json({ error: "sessionId and barcodeValue are required" });
    }

    // ── TODO: implement full barcode → student lookup ──────────────
    // const studentSnap = await db.collection("classes").doc(classId)
    //   .collection("students").where("barcode", "==", barcodeValue).limit(1).get();
    // if (studentSnap.empty) return res.status(404).json({ error: "Student not found" });
    // const student = studentSnap.docs[0];
    // const isLate  = ...; // calculate based on session startedAt + remaining time
    // await db.collection("sessions").doc(sessionId).update({
    //   [`attendance.${student.id}`]: { name: student.data().name, scannedAt: FieldValue.serverTimestamp(), late: isLate, override: false }
    // });
    // ──────────────────────────────────────────────────────────────

    console.log(`[Scan] Barcode received: ${barcodeValue} | Session: ${sessionId} | By: ${req.user.email}`);

    res.status(200).json({
      message:      "Scan received — backend processing not yet implemented",
      barcodeValue,
      sessionId,
      professor:    req.user.email,
    });
  } catch (err) {
    next(err); // passes to errorHandler
  }
});

/* ── POST /tardy ───────────────────────────────────────────
   Refactored from: notifyTardy (Firestore trigger)
   Receives a tardy event and sends a notification.
   In production, swap the console.log for SendGrid / nodemailer.

   Expected body:
     { studentName: string, studentEmail: string, className: string, date: string }
──────────────────────────────────────────────────────────── */
app.post("/tardy", authenticate, async (req, res, next) => {
  try {
    const { studentName, studentEmail, className, date } = req.body;

    if (!studentName || !className) {
      return res.status(400).json({ error: "studentName and className are required" });
    }

    // ── TODO: send real email with SendGrid ────────────────────────
    // const sgMail = require("@sendgrid/mail");
    // sgMail.setApiKey(functions.config().sendgrid.key);
    // await sgMail.send({
    //   to:      studentEmail,
    //   from:    "noreply@flyby-isu.app",
    //   subject: `Attendance Notice — ${className}`,
    //   text:    `You were marked tardy in ${className} on ${date}. Contact your professor if this is an error.`,
    // });
    // ──────────────────────────────────────────────────────────────

    console.log(`[Tardy] ${studentName} | ${className} | ${date} | Notified by: ${req.user.email}`);

    res.status(200).json({ message: "Tardy notification queued", studentName, className });
  } catch (err) {
    next(err);
  }
});

/* ── GET /report/:classId ──────────────────────────────────
   Refactored from: semesterReport (standalone HTTPS function)
   Calculates attendance stats server-side for a class.
   The professor email is pulled from the auth token — no need
   to pass it as a query param (closes a spoofing vector).
──────────────────────────────────────────────────────────── */
app.get("/report/:classId", authenticate, async (req, res, next) => {
  try {
    const { classId } = req.params;
    const professor   = req.user.email; // from verified token — can't be spoofed

    // Fetch sessions
    const sessSnap = await db.collection("sessions")
      .where("professor", "==", professor)
      .where("classId",   "==", classId)
      .get();

    const sessions = sessSnap.docs.map((d) => d.data());
    const total    = sessions.length;

    // Fetch students for this class
    const stuSnap = await db
      .collection("classes").doc(classId)
      .collection("students").get();

    const students = stuSnap.docs.map((d) => ({ id: d.id, name: d.data().name }));

    // Calculate per-student stats
    const report = students.map((s) => {
      let present = 0, late = 0;
      sessions.forEach((sess) => {
        const rec = (sess.attendance || {})[s.id];
        if (rec) { rec.late ? late++ : present++; }
      });
      return {
        name:    s.name,
        present, late,
        absent:  total - present - late,
        rate:    total > 0 ? Math.round(((present + late) / total) * 100) : 0,
        total,
      };
    });

    report.sort((a, b) => b.rate - a.rate);

    console.log(`[Report] ${professor} | class: ${classId} | ${total} sessions`);

    res.status(200).json({
      report,
      classId,
      generatedAt: new Date().toISOString(),
      source:      "express-api",
    });
  } catch (err) {
    next(err);
  }
});

/* ═══════════════════════════════════════════════════════════════
   MIDDLEWARE 4 — 404 HANDLER
   Catches any request that didn't match a route above.
   Returns a clean JSON 404 instead of an Express HTML page.
═══════════════════════════════════════════════════════════════ */
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

/* ═══════════════════════════════════════════════════════════════
   MIDDLEWARE 5 — GLOBAL ERROR HANDLER
   Express calls this whenever a route calls next(err).
   Critical: we log the full error server-side but NEVER send the
   stack trace to the client — stack traces leak implementation
   details that attackers use for reconnaissance.
═══════════════════════════════════════════════════════════════ */
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Full details in Cloud Logging (visible to you, not the client)
  console.error(`[Error] ${req.method} ${req.path}`, err);

  // CORS errors get a specific status
  if (err.message && err.message.startsWith("CORS")) {
    return res.status(403).json({ error: "Forbidden: origin not allowed" });
  }

  // Everything else gets a generic 500 — no leak
  res.status(500).json({ error: "Internal server error" });
});

/* ═══════════════════════════════════════════════════════════════
   EXPORTS
   `api`  — all HTTP routes, wrapped as a single Cloud Function
   `autoCloseSessions` — scheduled, lives outside Express
═══════════════════════════════════════════════════════════════ */

// Single HTTPS entry point for all Express routes
exports.api = functions.https.onRequest(app);

/* ── Scheduled: nightly cleanup ───────────────────────────
   Runs every night at 11:59 PM Chicago time.
   Finds sessions with endedAt == null and closes them.
   Lives outside Express — it's not HTTP traffic.
──────────────────────────────────────────────────────────── */
exports.autoCloseSessions = functions.pubsub
  .schedule("59 23 * * *")
  .timeZone("America/Chicago")
  .onRun(async () => {
    const open = await db
      .collection("sessions")
      .where("endedAt", "==", null)
      .get();

    if (open.empty) {
      console.log("[Cleanup] No open sessions.");
      return null;
    }

    const batch = db.batch();
    open.forEach((doc) => {
      batch.update(doc.ref, {
        endedAt:  admin.firestore.FieldValue.serverTimestamp(),
        autoNote: "Auto-closed by nightly cleanup",
      });
    });

    await batch.commit();
    console.log(`[Cleanup] Closed ${open.size} session(s).`);
    return null;
  });
