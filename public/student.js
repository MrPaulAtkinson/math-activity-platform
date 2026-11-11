import { api, makeCalculator, calculatorLatex, el } from "./common.js";

const app = document.getElementById("app");
const TOKEN_KEY = "studentToken";

const store = {
  get: () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } },
  set: (v) => { try { localStorage.setItem(TOKEN_KEY, v); } catch {} },
  clear: () => { try { localStorage.removeItem(TOKEN_KEY); } catch {} },
};

let token = store.get();
let state; // { nickname, activity, responses }
let index = 0;
let calc;

const auth = () => ({ "x-student-token": token });

function showJoin(message) {
  const error = el("p", { class: "error" }, message || "");
  const code = el("input", { type: "text", id: "code", autocomplete: "off", maxlength: 12, style: "text-transform:uppercase" });
  const nickname = el("input", { type: "text", id: "nickname", autocomplete: "off", maxlength: 24 });
  const form = el(
    "form",
    { class: "panel narrow" },
    el("h2", {}, "Join your class"),
    el("label", { for: "code" }, "Class code"),
    code,
    el("label", { for: "nickname" }, "Nickname"),
    nickname,
    el("p", { class: "muted" }, "Use a nickname your teacher will recognize. Don't use your full name."),
    el("button", { class: "primary", type: "submit" }, "Join"),
    error,
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      ({ token } = await api("/api/join", { method: "POST", body: { code: code.value, nickname: nickname.value } }));
      store.set(token);
      await start();
    } catch (err) {
      error.textContent = err.message;
    }
  });
  app.replaceChildren(form);
  code.focus();
}

async function start() {
  try {
    state = await api("/api/student/activity", { headers: auth() });
  } catch (err) {
    store.clear();
    token = null;
    return showJoin(err.status === 401 ? "" : err.message);
  }
  document.getElementById("title").textContent = state.activity.title;
  document.getElementById("who").textContent = state.nickname;
  index = 0;
  await showScreen();
}

function savedFor(i) {
  return state.responses.find((r) => r.screenIndex === i);
}

function readAnswer(form, question) {
  if (question.type === "multiple_choice") {
    return form.querySelector("input[name=choice]:checked")?.value ?? "";
  }
  return form.querySelector("[name=answer]")?.value ?? "";
}

async function saveCurrent(form, question) {
  const work = { screenIndex: index, answer: readAnswer(form, question), expressions: calculatorLatex(calc) };
  await api("/api/student/responses", { method: "POST", headers: auth(), body: work });
  const existing = savedFor(index);
  if (existing) Object.assign(existing, work);
  else state.responses.push(work);
  return work;
}

async function showScreen() {
  calc?.destroy();
  calc = undefined;
  const screens = state.activity.screens;
  const screen = screens[index];
  const saved = savedFor(index);
  const q = screen.question;
  const status = el("span", { class: "saved" });
  const hintBox = el("div");

  const answerArea =
    q.type === "none"
      ? null
      : q.type === "multiple_choice"
        ? el(
            "div",
            { class: "choices" },
            q.choices.map((c) =>
              el("label", {}, el("input", { type: "radio", name: "choice", value: c, checked: saved?.answer === c }), c),
            ),
          )
        : q.type === "numeric"
          ? el("input", { type: "text", name: "answer", inputmode: "decimal", value: saved?.answer ?? "" })
          : Object.assign(el("textarea", { name: "answer" }), { value: saved?.answer ?? "" });

  const form = el(
    "form",
    {},
    q.type !== "none" ? el("p", {}, el("strong", {}, q.prompt)) : null,
    answerArea,
    el(
      "div",
      { class: "row", style: "margin-top:10px" },
      q.type !== "none" ? el("button", { class: "primary", type: "submit" }, "Save answer") : null,
      el("button", { type: "button", onclick: () => getHint(form, q, hintBox) }, "Hint"),
      status,
    ),
    hintBox,
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await saveCurrent(form, q);
      status.textContent = "Saved ✓";
    } catch (err) {
      status.textContent = err.message;
    }
  });

  const go = async (i) => {
    try {
      await saveCurrent(form, q);
    } catch {
      // Moving on matters more than this save; the next save will catch up.
    }
    index = i;
    await showScreen();
  };

  const calcEl = screen.calculator ? el("div", { class: "calc" }) : null;
  app.replaceChildren(
    el(
      "div",
      { class: "panel row" },
      el("div", { class: "dots" }, screens.map((s, i) =>
        el("button", { type: "button", class: i === index ? "current" : null, title: s.title, onclick: () => go(i) }, String(i + 1)),
      )),
      el("span", { class: "spacer" }),
      el("button", { type: "button", disabled: index === 0, onclick: () => go(index - 1) }, "← Back"),
      el("button", { type: "button", class: "primary", disabled: index === screens.length - 1, onclick: () => go(index + 1) }, "Next →"),
    ),
    el(
      "div",
      { class: calcEl ? "screen-layout" : "" },
      el("section", { class: "panel" }, el("h2", {}, screen.title), el("p", { class: "instructions" }, screen.instructions), form),
      calcEl,
    ),
  );

  if (calcEl) {
    try {
      calc = await makeCalculator(calcEl, screen.calculator, saved?.expressions);
    } catch (err) {
      calcEl.replaceChildren(el("p", { class: "error", style: "padding:12px" }, err.message));
    }
  }
}

async function getHint(form, question, box) {
  const button = form.querySelector("button[type=button]");
  button.disabled = true;
  box.replaceChildren(el("p", { class: "muted" }, "Thinking…"));
  try {
    const work = { screenIndex: index, answer: readAnswer(form, question), expressions: calculatorLatex(calc) };
    const { hint, hintsLeft } = await api("/api/student/hint", { method: "POST", headers: auth(), body: work });
    box.replaceChildren(
      el("div", { class: "hint" }, hint),
      el("p", { class: "muted" }, `${hintsLeft} hint${hintsLeft === 1 ? "" : "s"} left on this screen.`),
    );
  } catch (err) {
    box.replaceChildren(el("p", { class: "error" }, err.message));
  } finally {
    button.disabled = false;
  }
}

if (token) start();
else showJoin();
