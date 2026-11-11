import { api, makeCalculator, el } from "./common.js";

const app = document.getElementById("app");
const logout = document.getElementById("logout");
const KEY = "teacherPasscode";

const store = {
  get: () => { try { return sessionStorage.getItem(KEY); } catch { return null; } },
  set: (v) => { try { sessionStorage.setItem(KEY, v); } catch {} },
  clear: () => { try { sessionStorage.removeItem(KEY); } catch {} },
};

let passcode = store.get();
let calcs = [];
let refreshTimer;

const tapi = (path, opts = {}) =>
  api(`/api/teacher${path}`, { ...opts, headers: { "x-teacher-passcode": passcode ?? "" } }).catch((err) => {
    if (err.status === 401) {
      store.clear();
      passcode = null;
      showLogin("Wrong passcode.");
    }
    throw err;
  });

function reset() {
  calcs.forEach((c) => c.destroy());
  calcs = [];
  clearInterval(refreshTimer);
}

function showLogin(message) {
  reset();
  logout.hidden = true;
  const input = el("input", { type: "password", id: "pass", autocomplete: "current-password" });
  const form = el(
    "form",
    { class: "panel narrow" },
    el("h2", {}, "Teacher sign in"),
    el("label", { for: "pass" }, "Passcode"),
    input,
    el("p", { class: "error" }, message || ""),
    el("button", { class: "primary", type: "submit" }, "Sign in"),
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    passcode = input.value;
    store.set(passcode);
    showHome();
  });
  app.replaceChildren(form);
  input.focus();
}

async function showHome() {
  reset();
  logout.hidden = false;
  let activities;
  try {
    activities = await tapi("/activities");
  } catch {
    return;
  }

  const request = el("textarea", {
    id: "request",
    placeholder: "e.g. 6 screens introducing slope-intercept form. Start with a slider exploration, then have students match a line to its equation, and end with 2 check questions.",
  });
  const status = el("p", { class: "muted" });
  const button = el("button", { class: "primary", type: "submit" }, "Write activity with AI");
  const form = el("form", { class: "panel" }, el("h2", {}, "New activity"), el("label", { for: "request" }, "What should the activity cover?"), request, el("div", { class: "row", style: "margin-top:10px" }, button, status));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    button.disabled = true;
    status.textContent = "Writing the activity… this can take a minute.";
    try {
      const row = await tapi("/activities/generate", { method: "POST", body: { request: request.value } });
      showEditor(row.id);
    } catch (err) {
      status.textContent = err.message;
      button.disabled = false;
    }
  });

  app.replaceChildren(
    form,
    el(
      "section",
      { class: "panel" },
      el("h2", {}, "Your activities"),
      activities.length
        ? el("ul", { class: "activity-list" }, activities.map((a) =>
            el("li", {}, el("button", { type: "button", onclick: () => showEditor(a.id) }, a.title),
              a.classCode ? el("span", { class: "muted" }, `  Live, code ${a.classCode}`) : null),
          ))
        : el("p", { class: "muted" }, "None yet."),
    ),
  );
}

async function showEditor(id) {
  reset();
  let row;
  try {
    row = await tapi(`/activities/${id}`);
  } catch (err) {
    return app.replaceChildren(el("p", { class: "error" }, err.message));
  }
  let draft = row.activity;
  const status = el("span", { class: "muted" });
  const json = Object.assign(el("textarea", { class: "code", id: "json", spellcheck: "false" }), { value: JSON.stringify(draft, null, 2) });
  const preview = el("div");
  const reviseText = el("textarea", { id: "revise", placeholder: "e.g. Make screen 3 harder and add a multiple choice question at the end." });

  const readJson = () => {
    try {
      return JSON.parse(json.value);
    } catch {
      throw new Error("The JSON has a typo in it, so it can't be saved.");
    }
  };

  const save = async () => {
    try {
      row = await tapi(`/activities/${id}`, { method: "PUT", body: readJson() });
      draft = row.activity;
      status.textContent = "Saved ✓";
      renderPreview();
    } catch (err) {
      status.textContent = err.message;
    }
  };

  const revise = async (e) => {
    e.preventDefault();
    status.textContent = "Revising with AI… this can take a minute.";
    try {
      await save();
      const { activity } = await tapi(`/activities/${id}/revise`, { method: "POST", body: { request: reviseText.value } });
      json.value = JSON.stringify(activity, null, 2);
      draft = activity;
      renderPreview();
      status.textContent = "Revision ready. Check the preview, then Save to keep it.";
    } catch (err) {
      status.textContent = err.message;
    }
  };

  const setLive = async (on) => {
    try {
      await save();
      await tapi(`/activities/${id}/${on ? "publish" : "unpublish"}`, { method: "POST" });
      showEditor(id);
    } catch (err) {
      status.textContent = err.message;
    }
  };

  const remove = async () => {
    if (!confirm(`Delete "${row.title}" and all student work in it?`)) return;
    await tapi(`/activities/${id}`, { method: "DELETE" });
    showHome();
  };

  async function renderPreview() {
    calcs.forEach((c) => c.destroy());
    calcs = [];
    const parts = draft.screens.map((s, i) => {
      const calcEl = s.calculator ? el("div", { class: "calc", style: "height:300px" }) : null;
      const card = el(
        "div",
        { class: "panel" },
        el("h3", {}, `${i + 1}. ${s.title}`),
        el("p", { class: "instructions" }, s.instructions),
        s.question.type !== "none"
          ? el("p", {}, el("strong", {}, `Question (${s.question.type.replace("_", " ")}): `), s.question.prompt)
          : null,
        s.question.choices.length ? el("ul", {}, s.question.choices.map((c) => el("li", {}, c))) : null,
        s.question.answerKey ? el("p", { class: "muted" }, `Answer key: ${s.question.answerKey}`) : null,
        s.teacherNotes ? el("p", { class: "muted" }, `Notes: ${s.teacherNotes}`) : null,
        calcEl,
      );
      return { card, calcEl, s };
    });
    preview.replaceChildren(...parts.map((p) => p.card));
    for (const p of parts) {
      if (!p.calcEl) continue;
      try {
        calcs.push(await makeCalculator(p.calcEl, p.s.calculator));
      } catch (err) {
        p.calcEl.replaceChildren(el("p", { class: "error", style: "padding:12px" }, err.message));
      }
    }
  }

  const reviseForm = el("form", {}, el("label", { for: "revise" }, "Ask AI to change it"), reviseText, el("button", { type: "submit", style: "margin-top:8px" }, "Revise"));
  reviseForm.addEventListener("submit", revise);

  app.replaceChildren(
    el(
      "div",
      { class: "panel row" },
      el("button", { type: "button", onclick: showHome }, "← All activities"),
      el("strong", {}, row.title),
      el("span", { class: "spacer" }),
      row.classCode
        ? [el("span", {}, "Class code: ", el("span", { class: "code-badge" }, row.classCode)),
           el("button", { type: "button", onclick: () => showDashboard(id) }, "Student work"),
           el("button", { type: "button", onclick: () => setLive(false) }, "Close to students")]
        : el("button", { type: "button", class: "primary", onclick: () => setLive(true) }, "Publish to students"),
      el("button", { type: "button", onclick: remove }, "Delete"),
    ),
    el(
      "div",
      { class: "screen-layout" },
      el(
        "section",
        { class: "panel" },
        reviseForm,
        el("label", { for: "json" }, "Edit directly"),
        json,
        el("div", { class: "row", style: "margin-top:8px" }, el("button", { type: "button", class: "primary", onclick: save }, "Save"), status),
      ),
      el("section", {}, preview),
    ),
  );
  renderPreview();
}

async function showDashboard(id) {
  reset();
  const body = el("div");
  app.replaceChildren(
    el("div", { class: "panel row" },
      el("button", { type: "button", onclick: () => showEditor(id) }, "← Back to activity"),
      el("span", { class: "muted" }, "Updates every 5 seconds.")),
    body,
  );

  const render = async () => {
    let data;
    try {
      data = await tapi(`/activities/${id}/dashboard`);
    } catch {
      return clearInterval(refreshTimer);
    }
    const { activity, students, responses, hints } = data;
    const answer = (sid, i) => responses.find((r) => r.studentId === sid && r.screenIndex === i);
    const hintCount = (sid, i) => hints.find((h) => h.studentId === sid && h.screenIndex === i)?.count ?? 0;
    const screens = activity.activity.screens;
    body.replaceChildren(
      el("section", { class: "panel" },
        el("h2", {}, `${activity.title}: `, activity.classCode ? el("span", { class: "code-badge" }, activity.classCode) : "closed"),
        el("p", { class: "muted" }, `${students.length} student${students.length === 1 ? "" : "s"} joined.`),
        el("div", { class: "table-wrap" },
          el("table", {},
            el("thead", {}, el("tr", {}, el("th", {}, "Student"), screens.map((s, i) => el("th", { title: s.question.prompt }, `${i + 1}. ${s.title}`)))),
            el("tbody", {}, students.map((st) =>
              el("tr", {}, el("th", {}, st.nickname), screens.map((s, i) => {
                const a = answer(st.id, i);
                const h = hintCount(st.id, i);
                return el("td", {},
                  a?.answer || (a ? el("span", { class: "muted" }, "visited") : ""),
                  h ? el("div", { class: "muted" }, `${h} hint${h === 1 ? "" : "s"}`) : null);
              })),
            )),
          ),
        ),
      ),
    );
  };
  await render();
  refreshTimer = setInterval(render, 5000);
}

logout.addEventListener("click", () => {
  store.clear();
  passcode = null;
  showLogin();
});

if (passcode) showHome();
else showLogin();
