// Shared helpers for the student and teacher pages.

export async function api(path, { method = "GET", body, headers = {} } = {}) {
  const res = await fetch(path, {
    method,
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

let desmosLoading;

/** Loads the Desmos calculator script once, using the key from the server. */
export function loadDesmos() {
  desmosLoading ??= api("/api/config").then(
    ({ desmosApiKey, desmosVersion }) =>
      new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = `https://www.desmos.com/api/${encodeURIComponent(desmosVersion)}/calculator.js?apiKey=${encodeURIComponent(desmosApiKey)}`;
        script.onload = () => resolve(window.Desmos);
        script.onerror = () => reject(new Error("Could not load the Desmos calculator."));
        document.head.append(script);
      }),
  );
  return desmosLoading;
}

/**
 * Puts a calculator in `el` set up from a screen's calculator config.
 * `saved` (optional) is a list of the student's own LaTeX expressions to restore.
 */
export async function makeCalculator(el, config, saved) {
  const Desmos = await loadDesmos();
  const calc = Desmos.GraphingCalculator(el, {
    expressionsCollapsed: false,
    settingsMenu: false,
    border: false,
  });
  const exprs = saved?.length ? saved.map((latex) => ({ latex, hidden: false })) : config.expressions;
  exprs.forEach((e, i) => calc.setExpression({ id: `e${i}`, latex: e.latex, hidden: e.hidden }));
  if (config.bounds) calc.setMathBounds(config.bounds);
  return calc;
}

/** The student's current calculator entries as LaTeX strings. */
export function calculatorLatex(calc) {
  if (!calc) return [];
  return calc
    .getExpressions()
    .filter((e) => e.type === "expression" && e.latex)
    .map((e) => e.latex);
}

/** Small element helper: el("p", { class: "x" }, "text", child) - text is never parsed as HTML. */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  node.append(...children.flat().filter((c) => c != null && c !== false));
  return node;
}
