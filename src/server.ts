import { randomBytes } from "node:crypto";
import { createApp } from "./app.ts";
import { createAi } from "./ai.ts";
import { openDb } from "./db.ts";

const DEMO_DESMOS_KEY = "dcb31709b452b1cf9dc26972add0fda6";

const port = Number(process.env.PORT ?? 3000);
const dbFile = process.env.DATABASE_FILE ?? "data/app.db";

let teacherPasscode = process.env.TEACHER_PASSCODE?.trim();
if (!teacherPasscode) {
  teacherPasscode = randomBytes(4).toString("hex");
  console.warn(`TEACHER_PASSCODE is not set. Teacher passcode for this run: ${teacherPasscode}`);
}
if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
  console.warn("ANTHROPIC_API_KEY is not set: AI activity writing and hints will not work.");
}
const desmosApiKey = process.env.DESMOS_API_KEY || DEMO_DESMOS_KEY;
if (desmosApiKey === DEMO_DESMOS_KEY) {
  console.warn("Using the Desmos demo API key. Get your own key from Desmos before using this with a class.");
}

const app = createApp({
  db: openDb(dbFile),
  ai: createAi(),
  teacherPasscode,
  desmos: { apiKey: desmosApiKey, version: process.env.DESMOS_API_VERSION || "v1.11" },
});

app.listen(port, () => {
  console.log(`Math activity platform running at http://localhost:${port}`);
  console.log(`  Teacher: http://localhost:${port}/teacher.html`);
  console.log(`  Students: http://localhost:${port}/`);
});
