import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp, MAX_HINTS_PER_SCREEN } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import type { AiService, HintInput } from "../src/ai.ts";
import type { Activity } from "../src/schema.ts";

const sample: Activity = {
  title: "Slope Explorer",
  screens: [
    {
      title: "Meet m",
      instructions: "Move the slider for m.",
      calculator: { expressions: [{ latex: "y=mx", hidden: false }, { latex: "m=1", hidden: false }], bounds: { left: -10, right: 10, bottom: -10, top: 10 } },
      question: { type: "text", prompt: "What does m change?", choices: [], answerKey: "How steep the line is" },
      teacherNotes: "Listen for 'steepness'.",
    },
    {
      title: "Check",
      instructions: "Pick one.",
      calculator: null,
      question: { type: "multiple_choice", prompt: "Slope of y=3x+1?", choices: ["1", "3"], answerKey: "3" },
      teacherNotes: "",
    },
  ],
};

const hintCalls: HintInput[] = [];
const fakeAi: AiService = {
  async writeActivity(request, current) {
    return current ? { ...current, title: `${current.title} (revised)` } : { ...sample, title: request };
  },
  async hint(input) {
    hintCalls.push(input);
    return "Look at what happens to the line as m gets bigger.";
  },
};

let server: Server;
let base: string;
const PASS = "test-pass";

before(async () => {
  const app = createApp({ db: openDb(":memory:"), ai: fakeAi, teacherPasscode: PASS, desmos: { apiKey: "k", version: "v1.10" } });
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

async function call(path: string, { method = "GET", body, headers = {} }: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}
const teacher = { "x-teacher-passcode": PASS };

test("teacher routes need the passcode", async () => {
  assert.equal((await call("/api/teacher/activities")).status, 401);
  assert.equal((await call("/api/teacher/activities", { headers: { "x-teacher-passcode": "nope" } })).status, 401);
  assert.equal((await call("/api/teacher/activities", { headers: teacher })).status, 200);
});

test("full flow: generate, publish, join, answer, hint, dashboard", async () => {
  const gen = await call("/api/teacher/activities/generate", { method: "POST", headers: teacher, body: { request: "Slopes" } });
  assert.equal(gen.status, 201);
  const id = gen.data.id;

  // Not published yet: no code, students can't join.
  assert.equal(gen.data.classCode, null);

  const pub = await call(`/api/teacher/activities/${id}/publish`, { method: "POST", headers: teacher });
  const code: string = pub.data.classCode;
  assert.match(code, /^[A-Z2-9]{6}$/);

  assert.equal((await call("/api/join", { method: "POST", body: { code: "WRONG1", nickname: "A" } })).status, 404);
  const join = await call("/api/join", { method: "POST", body: { code: code.toLowerCase(), nickname: "Pat" } });
  assert.equal(join.status, 201);
  const student = { "x-student-token": join.data.token };
  assert.equal((await call("/api/join", { method: "POST", body: { code, nickname: "Pat" } })).status, 409);

  // Students never see answer keys or teacher notes.
  const view = await call("/api/student/activity", { headers: student });
  assert.equal(view.status, 200);
  const text = JSON.stringify(view.data);
  assert.ok(!text.includes("answerKey") && !text.includes("How steep") && !text.includes("teacherNotes"));

  const saved = await call("/api/student/responses", { method: "POST", headers: student, body: { screenIndex: 1, answer: "3", expressions: [] } });
  assert.equal(saved.status, 200);
  assert.equal((await call("/api/student/responses", { method: "POST", headers: student, body: { screenIndex: 9, answer: "x", expressions: [] } })).status, 400);

  const hint = await call("/api/student/hint", { method: "POST", headers: student, body: { screenIndex: 0, answer: "", expressions: ["y=mx", "m=4"] } });
  assert.equal(hint.status, 200);
  assert.equal(hint.data.hintsLeft, MAX_HINTS_PER_SCREEN - 1);
  // The AI gets the math and the answer key, but not the nickname.
  const sent = JSON.stringify(hintCalls.at(-1));
  assert.ok(sent.includes("m=4") && sent.includes("How steep"));
  assert.ok(!sent.includes("Pat"));

  const dash = await call(`/api/teacher/activities/${id}/dashboard`, { headers: teacher });
  assert.equal(dash.data.students.length, 1);
  assert.equal(dash.data.responses.find((r: any) => r.screenIndex === 1).answer, "3");
  assert.deepEqual(dash.data.hints, [{ studentId: dash.data.students[0].id, screenIndex: 0, count: 1 }]);

  // Closing the activity locks students out.
  await call(`/api/teacher/activities/${id}/unpublish`, { method: "POST", headers: teacher });
  assert.equal((await call("/api/student/activity", { headers: student })).status, 401);
});

test("hints are limited per screen", async () => {
  const gen = await call("/api/teacher/activities/generate", { method: "POST", headers: teacher, body: { request: "Limits" } });
  const { data } = await call(`/api/teacher/activities/${gen.data.id}/publish`, { method: "POST", headers: teacher });
  const join = await call("/api/join", { method: "POST", body: { code: data.classCode, nickname: "Sam" } });
  const student = { "x-student-token": join.data.token };
  const ask = () => call("/api/student/hint", { method: "POST", headers: student, body: { screenIndex: 0, answer: "", expressions: [] } });
  for (let i = 0; i < MAX_HINTS_PER_SCREEN; i++) assert.equal((await ask()).status, 200);
  assert.equal((await ask()).status, 429);
});

test("teacher edits are validated, and revise returns without saving", async () => {
  const gen = await call("/api/teacher/activities/generate", { method: "POST", headers: teacher, body: { request: "Edits" } });
  const id = gen.data.id;
  assert.equal((await call(`/api/teacher/activities/${id}`, { method: "PUT", headers: teacher, body: { title: "x" } })).status, 400);
  const ok = await call(`/api/teacher/activities/${id}`, { method: "PUT", headers: teacher, body: { ...sample, title: "Renamed" } });
  assert.equal(ok.data.title, "Renamed");
  const rev = await call(`/api/teacher/activities/${id}/revise`, { method: "POST", headers: teacher, body: { request: "harder" } });
  assert.equal(rev.data.activity.title, "Renamed (revised)");
  assert.equal((await call(`/api/teacher/activities/${id}`, { headers: teacher })).data.title, "Renamed");
});
