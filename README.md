# Math Activity Platform

Class activities with an embedded Desmos graphing calculator, written with AI.

- **Teachers** describe an activity ("6 screens introducing slope-intercept form…"), and Claude writes it: screens, calculator setups, questions and answer keys. Edit it directly or ask the AI to revise it, then publish it to get a class code.
- **Students** (9th grade) join with the class code and a nickname, work through the screens with the calculator, and can press **Hint**. The tutor sees their calculator and answer and nudges them without giving the answer away (5 hints per screen).
- **Dashboard** shows each student's answers and hint use, updating every few seconds.

## Run it

Needs Node.js 22.13 or newer.

```bash
npm install
cp .env.example .env   # then add your ANTHROPIC_API_KEY and a TEACHER_PASSCODE
npm run dev
```

- Students: http://localhost:3000/
- Teacher: http://localhost:3000/teacher.html

Without an API key everything except the AI features works: you can still paste activity JSON in through the API, publish it, and have students join.

## Settings (`.env`)

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API key. Needed for writing activities and hints. |
| `TEACHER_PASSCODE` | Password for the teacher pages. If empty, a random one is printed when the server starts. |
| `DESMOS_API_KEY` | Desmos API key. Defaults to Desmos's public **demo key**, which is for development only: get your own from Desmos before using this with a class. |
| `DESMOS_API_VERSION` | Desmos API version to load (default `v1.10`). |
| `PORT` | Default 3000. |
| `DATABASE_FILE` | SQLite file, default `data/app.db`. |

## Privacy

- Students join with a nickname only; the join screen asks them not to use their full name.
- Hint requests send only the screen, the student's answer and their calculator entries to the AI, never the nickname.
- Answer keys and teacher notes are never sent to student browsers.
- Check your district's policy on AI tools before using this with students.

## Code

- `src/schema.ts`: the activity format (also what the AI must produce)
- `src/ai.ts`: Claude calls for writing activities and giving hints, with their prompts
- `src/app.ts`: the HTTP API
- `src/db.ts`: SQLite storage (Node's built-in `node:sqlite`)
- `public/`: the student page (`index.html`) and teacher page (`teacher.html`)
- `test/`: API tests, using a stand-in for the AI so they run without a key

```bash
npm test
npm run typecheck
```
