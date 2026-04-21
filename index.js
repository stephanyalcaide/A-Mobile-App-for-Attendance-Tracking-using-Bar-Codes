/**
 * FlyBy — Firebase Cloud Functions Backend
 * 
 * Three functions:
 *  1. autoCloseSessions   — runs nightly at 11:59 PM, closes any open sessions
 *  2. semesterReport      — HTTP endpoint, calculates attendance stats server-side
 *  3. notifyTardy         — fires when a student is marked late, logs the event
 *                           (swap console.log for an email API like SendGrid to send real emails)
 */

const functions = require("firebase-functions");
const admin     = require("firebase-admin");
admin.initializeApp();
const db = admin.firestore();

/* ─────────────────────────────────────────────────────────────
   1. NIGHTLY CLEANUP — auto-close sessions left open
   Runs every day at 11:59 PM Central time
   ───────────────────────────────────────────────────────────── */
exports.autoCloseSessions = functions.pubsub
  .schedule("59 23 * * *")
  .timeZone("America/Chicago")
  .onRun(async (context) => {
    const openSessions = await db.collection("sessions")
      .where("endedAt", "==", null)
      .get();

    if (openSessions.empty) {
      console.log("[Cleanup] No open sessions found.");
      return null;
    }

    const batch = db.batch();
    openSessions.forEach((doc) => {
      batch.update(doc.ref, {
        endedAt:  admin.firestore.FieldValue.serverTimestamp(),
        autoNote: "Auto-closed by nightly cleanup job",
      });
    });

    await batch.commit();
    console.log(`[Cleanup] Closed ${openSessions.size} open session(s).`);
    return null;
  });


/* ─────────────────────────────────────────────────────────────
   2. SEMESTER REPORT — server-side calculation
   GET /semesterReport?classId=xxx&professor=yyy
   Returns: { report: [{ name, present, late, absent, rate, total }] }
   ───────────────────────────────────────────────────────────── */
exports.semesterReport = functions.https.onRequest(async (req, res) => {
  // CORS — allow the GitHub Pages frontend
  res.set("Access-Control-Allow-Origin", "https://tenjusu.github.io");
  res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.status(204).send(""); return; }

  const { classId, professor } = req.query;
  if (!professor) { res.status(400).json({ error: "professor required" }); return; }

  try {
    // Fetch all sessions for this class
    let query = db.collection("sessions").where("professor", "==", professor);
    if (classId) query = query.where("classId", "==", classId);
    const snap = await query.get();

    const sessions = snap.docs.map(d => d.data());
    const total    = sessions.length;

    // Fetch student roster
    let studentDocs;
    if (classId) {
      studentDocs = await db.collection("classes").doc(classId).collection("students").get();
    } else {
      studentDocs = await db.collection("Students").get();
    }
    const students = studentDocs.docs.map(d => ({ id: d.id, name: d.data().name }));

    // Calculate per-student stats
    const report = students.map(s => {
      let present = 0, late = 0;
      sessions.forEach(sess => {
        const rec = (sess.attendance || {})[s.id];
        if (rec) { rec.late ? late++ : present++; }
      });
      const absent = total - present - late;
      const rate   = total > 0 ? Math.round(((present + late) / total) * 100) : 0;
      return { name: s.name, present, late, absent, rate, total };
    });

    // Sort by attendance rate descending
    report.sort((a, b) => b.rate - a.rate);

    console.log(`[Report] Generated for ${professor} — ${total} sessions, ${students.length} students.`);
    res.status(200).json({ report, generatedAt: new Date().toISOString(), source: "cloud-function" });

  } catch (e) {
    console.error("[Report] Error:", e.message);
    res.status(500).json({ error: e.message });
  }
});


/* ─────────────────────────────────────────────────────────────
   3. TARDY NOTIFICATION — fires when attendance record is written
   Listens for writes to sessions/{sessionId}
   If a student was marked late, logs it (replace with email API to send real alerts)
   ───────────────────────────────────────────────────────────── */
exports.notifyTardy = functions.firestore
  .document("sessions/{sessionId}")
  .onUpdate(async (change, context) => {
    const before = change.before.data();
    const after  = change.after.data();

    const beforeAtt = before.attendance || {};
    const afterAtt  = after.attendance  || {};

    // Find newly-added late records
    const newLateStudents = Object.entries(afterAtt).filter(([id, rec]) => {
      return rec.late === true && !beforeAtt[id];
    });

    if (newLateStudents.length === 0) return null;

    for (const [studentId, rec] of newLateStudents) {
      const className = after.class || "your class";
      const date      = after.date  || new Date().toLocaleDateString();

      // ── LOG (replace this block with SendGrid / Nodemailer to send real email) ──
      console.log(`[Tardy Notice] ${rec.name} was marked tardy in ${className} on ${date}`);

      // Example SendGrid integration (uncomment + install @sendgrid/mail):
      //
      // const sgMail = require('@sendgrid/mail');
      // sgMail.setApiKey(functions.config().sendgrid.key);
      // await sgMail.send({
      //   to:      `${studentId}@ilstu.edu`,
      //   from:    'noreply@flyby-isu.app',
      //   subject: `Attendance Notice — ${className}`,
      //   text:    `You were marked tardy for ${className} on ${date}. Please contact your professor if this is an error.`,
      // });
    }

    return null;
  });
