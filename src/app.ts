import express, { type NextFunction, type Request, type Response } from "express";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { ActivitySchema, studentView } from "./schema.ts";
import { AiError, type AiService } from "./ai.ts";
import type { Db } from "./db.ts";

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

export const MAX_HINTS_PER_SCREEN = 5;

export type AppOptions = {
  db: Db;
  ai: AiService;
  teacherPasscode: string;
  desmos: { apiKey: string; version: string };
};

export function createApp({ db, ai, teacherPasscode, desmos }: AppOptions) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(express.static(publicDir));

  app.get("/api/config", (_req, res) => {
    res.json({ desmosApiKey: desmos.apiKey, desmosVersion: desmos.version });
  });

  // ---------- Teacher ----------

  const teacher = express.Router();
  teacher.use((req, res, next) => {
    const given = Buffer.from(String(req.get("x-teacher-passcode") ?? ""));
    const expected = Buffer.from(teacherPasscode);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return res.status(401).json({ error: "Wrong teacher passcode." });
    }
    next();
  });

  const idParam = (req: Request) => Number(req.params.id);

  teacher.get("/activities", (_req, res) => {
    res.json(db.listActivities().map(({ id, title, classCode, updatedAt }) => ({ id, title, classCode, updatedAt })));
  });

  teacher.get("/activities/:id", (req, res) => {
    const row = db.getActivity(idParam(req));
    if (!row) return res.status(404).json({ error: "Activity not found." });
    res.json(row);
  });

  // Write a new activity with AI.
  teacher.post("/activities/generate", async (req, res, next) => {
    const { request } = z.object({ request: z.string().trim().min(1).max(4000) }).parse(req.body);
    try {
      const activity = await ai.writeActivity(request);
      res.status(201).json(db.createActivity(activity));
    } catch (err) {
      next(err);
    }
  });

  // Ask AI to revise an existing activity. Returns the revision without saving it.
  teacher.post("/activities/:id/revise", async (req, res, next) => {
    const { request } = z.object({ request: z.string().trim().min(1).max(4000) }).parse(req.body);
    const row = db.getActivity(idParam(req));
    if (!row) return res.status(404).json({ error: "Activity not found." });
    try {
      res.json({ activity: await ai.writeActivity(request, row.activity) });
    } catch (err) {
      next(err);
    }
  });

  teacher.post("/activities", (req, res) => {
    res.status(201).json(db.createActivity(ActivitySchema.parse(req.body)));
  });

  teacher.put("/activities/:id", (req, res) => {
    const row = db.updateActivity(idParam(req), ActivitySchema.parse(req.body));
    if (!row) return res.status(404).json({ error: "Activity not found." });
    res.json(row);
  });

  teacher.delete("/activities/:id", (req, res) => {
    if (!db.deleteActivity(idParam(req))) return res.status(404).json({ error: "Activity not found." });
    res.status(204).end();
  });

  teacher.post("/activities/:id/publish", (req, res) => {
    const code = db.publish(idParam(req));
    if (!code) return res.status(404).json({ error: "Activity not found." });
    res.json({ classCode: code });
  });

  teacher.post("/activities/:id/unpublish", (req, res) => {
    if (!db.unpublish(idParam(req))) return res.status(404).json({ error: "Activity not found." });
    res.json({ classCode: null });
  });

  teacher.get("/activities/:id/dashboard", (req, res) => {
    const row = db.getActivity(idParam(req));
    if (!row) return res.status(404).json({ error: "Activity not found." });
    res.json({ activity: row, ...db.dashboard(row.id) });
  });

  app.use("/api/teacher", teacher);

  // ---------- Students ----------

  app.post("/api/join", (req, res) => {
    const { code, nickname } = z
      .object({ code: z.string().trim().min(1).max(12), nickname: z.string().trim().min(1).max(24) })
      .parse(req.body);
    const row = db.getActivityByCode(code);
    if (!row) return res.status(404).json({ error: "No activity with that class code." });
    const student = db.addStudent(row.id, nickname);
    if (!student) return res.status(409).json({ error: "That nickname is taken in this class. Pick another." });
    res.status(201).json({ token: student.token });
  });

  // Finds the student from their token and checks their activity is still published.
  const student = (req: Request, res: Response, next: NextFunction) => {
    const s = db.getStudentByToken(String(req.get("x-student-token") ?? ""));
    const row = s && db.getActivity(s.activityId);
    if (!s || !row?.classCode) return res.status(401).json({ error: "Please join again with your class code." });
    res.locals.student = s;
    res.locals.activity = row.activity;
    next();
  };

  app.get("/api/student/activity", student, (_req, res) => {
    const s = res.locals.student;
    res.json({
      nickname: s.nickname,
      activity: studentView(res.locals.activity),
      responses: db.getStudentResponses(s.id).map(({ screenIndex, answer, expressions }) => ({ screenIndex, answer, expressions })),
    });
  });

  const WorkSchema = z.object({
    screenIndex: z.number().int().min(0),
    answer: z.string().max(4000),
    expressions: z.array(z.string().max(500)).max(100),
  });

  app.post("/api/student/responses", student, (req, res) => {
    const work = WorkSchema.parse(req.body);
    if (work.screenIndex >= res.locals.activity.screens.length) return res.status(400).json({ error: "No such screen." });
    db.saveResponse(res.locals.student.id, work.screenIndex, work.answer, work.expressions);
    res.json({ saved: true });
  });

  app.post("/api/student/hint", student, async (req, res, next) => {
    const work = WorkSchema.parse(req.body);
    const screen = res.locals.activity.screens[work.screenIndex];
    if (!screen) return res.status(400).json({ error: "No such screen." });
    const studentId = res.locals.student.id;
    const previousHints = db.countHints(studentId, work.screenIndex);
    if (previousHints >= MAX_HINTS_PER_SCREEN) {
      return res.status(429).json({ error: "You've used all the hints for this screen. Ask your teacher!" });
    }
    db.saveResponse(studentId, work.screenIndex, work.answer, work.expressions);
    try {
      // Only the math goes to the AI: never the student's nickname.
      const hint = await ai.hint({ screen, answer: work.answer, expressions: work.expressions, previousHints });
      db.addHint(studentId, work.screenIndex, hint);
      res.json({ hint, hintsLeft: MAX_HINTS_PER_SCREEN - previousHints - 1 });
    } catch (err) {
      next(err);
    }
  });

  // ---------- Errors ----------

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid request.", details: err.issues });
    }
    if (err instanceof AiError) return res.status(502).json({ error: err.message });
    if (err instanceof Anthropic.AuthenticationError) {
      console.error("Claude API key missing or invalid:", err.message);
      return res.status(503).json({ error: "AI is not set up on this server (API key missing or invalid)." });
    }
    if (err instanceof Anthropic.RateLimitError) {
      return res.status(503).json({ error: "The AI is busy. Wait a moment and try again." });
    }
    if (err instanceof Anthropic.APIError) {
      console.error(`Claude API error ${err.status}:`, err.message);
      return res.status(502).json({ error: "The AI request failed. Try again." });
    }
    if (err instanceof Error && err.message.includes("Could not resolve authentication")) {
      return res.status(503).json({ error: "AI is not set up on this server (no API key)." });
    }
    console.error(err);
    res.status(500).json({ error: "Something went wrong." });
  });

  return app;
}
