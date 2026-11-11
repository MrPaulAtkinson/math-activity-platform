import { DatabaseSync } from "node:sqlite";
import { randomBytes, randomInt } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { ActivitySchema, type Activity } from "./schema.ts";

// No 0/O or 1/I/L, so codes are easy to read off a projector.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export type ActivityRow = {
  id: number;
  title: string;
  activity: Activity;
  classCode: string | null;
  updatedAt: string;
};

export type ResponseRow = {
  studentId: number;
  nickname: string;
  screenIndex: number;
  answer: string;
  expressions: string[];
  updatedAt: string;
};

export function openDb(file?: string) {
  if (file && file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file ?? ":memory:");
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      json TEXT NOT NULL,
      class_code TEXT UNIQUE,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS students (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
      nickname TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (activity_id, nickname)
    );
    CREATE TABLE IF NOT EXISTS responses (
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      screen_index INTEGER NOT NULL,
      answer TEXT NOT NULL,
      expressions TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (student_id, screen_index)
    );
    CREATE TABLE IF NOT EXISTS hints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      screen_index INTEGER NOT NULL,
      hint TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const toRow = (r: any): ActivityRow => {
    const activity = ActivitySchema.parse(JSON.parse(r.json));
    return { id: r.id, title: activity.title, activity, classCode: r.class_code, updatedAt: r.updated_at };
  };

  return {
    raw: db,

    createActivity(activity: Activity): ActivityRow {
      const r = db.prepare("INSERT INTO activities (json) VALUES (?) RETURNING *").get(JSON.stringify(activity));
      return toRow(r);
    },

    updateActivity(id: number, activity: Activity): ActivityRow | undefined {
      const r = db
        .prepare("UPDATE activities SET json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? RETURNING *")
        .get(JSON.stringify(activity), id);
      return r ? toRow(r) : undefined;
    },

    getActivity(id: number): ActivityRow | undefined {
      const r = db.prepare("SELECT * FROM activities WHERE id = ?").get(id);
      return r ? toRow(r) : undefined;
    },

    listActivities(): ActivityRow[] {
      return db.prepare("SELECT * FROM activities ORDER BY updated_at DESC, id DESC").all().map(toRow);
    },

    deleteActivity(id: number): boolean {
      return db.prepare("DELETE FROM activities WHERE id = ?").run(id).changes > 0;
    },

    /** Gives the activity a class code (keeping an existing one). */
    publish(id: number): string | undefined {
      const existing = this.getActivity(id);
      if (!existing) return undefined;
      if (existing.classCode) return existing.classCode;
      for (;;) {
        const code = Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
        try {
          db.prepare("UPDATE activities SET class_code = ? WHERE id = ?").run(code, id);
          return code;
        } catch {
          // Code already used by another activity; try another.
        }
      }
    },

    unpublish(id: number): boolean {
      return db.prepare("UPDATE activities SET class_code = NULL WHERE id = ?").run(id).changes > 0;
    },

    getActivityByCode(code: string): ActivityRow | undefined {
      const r = db.prepare("SELECT * FROM activities WHERE class_code = ?").get(code.trim().toUpperCase());
      return r ? toRow(r) : undefined;
    },

    /** Returns undefined if the nickname is taken in this activity. */
    addStudent(activityId: number, nickname: string): { id: number; token: string } | undefined {
      const token = randomBytes(24).toString("hex");
      try {
        const r = db
          .prepare("INSERT INTO students (activity_id, nickname, token) VALUES (?, ?, ?) RETURNING id")
          .get(activityId, nickname, token) as { id: number };
        return { id: r.id, token };
      } catch {
        return undefined;
      }
    },

    getStudentByToken(token: string): { id: number; activityId: number; nickname: string } | undefined {
      const r = db.prepare("SELECT id, activity_id, nickname FROM students WHERE token = ?").get(token) as any;
      return r ? { id: r.id, activityId: r.activity_id, nickname: r.nickname } : undefined;
    },

    saveResponse(studentId: number, screenIndex: number, answer: string, expressions: string[]) {
      db.prepare(
        `INSERT INTO responses (student_id, screen_index, answer, expressions) VALUES (?, ?, ?, ?)
         ON CONFLICT (student_id, screen_index)
         DO UPDATE SET answer = excluded.answer, expressions = excluded.expressions, updated_at = CURRENT_TIMESTAMP`,
      ).run(studentId, screenIndex, answer, JSON.stringify(expressions));
    },

    getStudentResponses(studentId: number): ResponseRow[] {
      return db
        .prepare(
          `SELECT r.*, s.nickname FROM responses r JOIN students s ON s.id = r.student_id
           WHERE r.student_id = ? ORDER BY r.screen_index`,
        )
        .all(studentId)
        .map(toResponse);
    },

    addHint(studentId: number, screenIndex: number, hint: string) {
      db.prepare("INSERT INTO hints (student_id, screen_index, hint) VALUES (?, ?, ?)").run(studentId, screenIndex, hint);
    },

    countHints(studentId: number, screenIndex: number): number {
      const r = db
        .prepare("SELECT COUNT(*) AS n FROM hints WHERE student_id = ? AND screen_index = ?")
        .get(studentId, screenIndex) as { n: number };
      return r.n;
    },

    /** Everything the teacher dashboard shows for one activity. */
    dashboard(activityId: number) {
      const students = db
        .prepare("SELECT id, nickname, created_at FROM students WHERE activity_id = ? ORDER BY nickname COLLATE NOCASE")
        .all(activityId) as { id: number; nickname: string; created_at: string }[];
      const responses = db
        .prepare(
          `SELECT r.*, s.nickname FROM responses r JOIN students s ON s.id = r.student_id
           WHERE s.activity_id = ?`,
        )
        .all(activityId)
        .map(toResponse);
      const hints = db
        .prepare(
          `SELECT h.student_id, h.screen_index, COUNT(*) AS n FROM hints h JOIN students s ON s.id = h.student_id
           WHERE s.activity_id = ? GROUP BY h.student_id, h.screen_index`,
        )
        .all(activityId) as { student_id: number; screen_index: number; n: number }[];
      return {
        students: students.map((s) => ({ id: s.id, nickname: s.nickname, joinedAt: s.created_at })),
        responses,
        hints: hints.map((h) => ({ studentId: h.student_id, screenIndex: h.screen_index, count: h.n })),
      };
    },
  };
}

function toResponse(r: any): ResponseRow {
  return {
    studentId: r.student_id,
    nickname: r.nickname,
    screenIndex: r.screen_index,
    answer: r.answer,
    expressions: JSON.parse(r.expressions),
    updatedAt: r.updated_at,
  };
}

export type Db = ReturnType<typeof openDb>;
