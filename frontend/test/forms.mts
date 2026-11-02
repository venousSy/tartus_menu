/**
 * Helpers of the dashboard tests: they use the Server Actions the way a browser does (decision D11),
 * so no browser and no test library are needed.
 * - A form is posted like a browser without JavaScript: every hidden input React rendered (the action
 *   reference, its bound state, $ACTION_KEY) plus the visible fields.
 * - An action the page calls with values (a drag reorder, a switch) is called like the page's
 *   JavaScript does: by its id from the build's manifest.
 */
import { readFileSync } from "node:fs";

/** A form of a page: what a browser would send, in order, and the names of those fields. */
export type Form = { fields: [string, string][]; names: string[] };

/** An access cookie with the Cafe Owner role. proxy.ts only reads its claims; the fake Django accepts any token. */
export function ownerCookie(): string {
  const part = (data: object) => Buffer.from(JSON.stringify(data)).toString("base64url");
  return `access=${part({ alg: "none" })}.${part({ role: "CAFE_OWNER", exp: Math.floor(Date.now() / 1000) + 3600 })}.x`;
}

const unescape = (text: string) =>
  text.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const attr = (tag: string, name: string) => {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return match ? unescape(match[1]) : null;
};

/**
 * The forms of a page, each with what a browser would send: inputs, the text of textareas, the
 * selected option of selects, and checkboxes only when they are ticked.
 */
export function formsOf(html: string): Form[] {
  return [...html.matchAll(/<form[^>]*>([\s\S]*?)<\/form>/g)].map((form) => {
    const fields: [string, string][] = [];
    for (const [control] of form[1].matchAll(/<input[^>]*>|<textarea[^>]*>[\s\S]*?<\/textarea>|<select[^>]*>[\s\S]*?<\/select>/g)) {
      const name = attr(control, "name");
      if (name === null) continue;
      if (control.startsWith("<textarea")) {
        fields.push([name, unescape(/>([\s\S]*?)<\/textarea>$/.exec(control)![1])]);
      } else if (control.startsWith("<select")) {
        const options = [...control.matchAll(/<option[^>]*>/g)].map((o) => o[0]);
        const chosen = options.find((o) => /\sselected(=|\s|>)/.test(o)) ?? options[0];
        fields.push([name, chosen ? attr(chosen, "value") ?? "" : ""]);
      } else if (/type="(checkbox|radio)"/.test(control)) {
        if (/\schecked(=|\s|\/?>)/.test(control)) fields.push([name, attr(control, "value") ?? "on"]);
      } else {
        fields.push([name, attr(control, "value") ?? ""]);
      }
    }
    return { fields, names: fields.map(([name]) => name) };
  });
}

/**
 * Posts `form` to `url` as a browser without JavaScript. `values` replace the fields of the same
 * name or add new ones; null removes one (an unticked checkbox).
 */
export async function submit(url: string, cookie: string, form: Form, values: Record<string, string | null> = {}) {
  const body = new FormData();
  for (const [name, value] of form.fields) {
    const next = name in values ? values[name] : value;
    if (next !== null) body.append(name, next);
  }
  for (const [name, value] of Object.entries(values)) {
    if (value !== null && !form.names.includes(name)) body.append(name, value);
  }
  const res = await fetch(url, { method: "POST", redirect: "manual", headers: { Cookie: cookie, Origin: new URL(url).origin }, body });
  return { status: res.status, location: res.headers.get("location"), html: await res.text() };
}

/**
 * The state the action of a no-JavaScript post returned. With Cache Components the answer's HTML is
 * a resumed render without it (observation 41); Next sends it in the page data instead.
 */
export function actionState(html: string): unknown {
  const chunk = /self\.__next_f\.push\(\[2,(\[[\s\S]*?\])\]\)<\/script>/.exec(html);
  return chunk ? JSON.parse(chunk[1])[0] : undefined;
}

/**
 * Calls the Server Action `name` of `file` (as the build's manifest names it, for example
 * "src/app/(app)/dashboard/categories/actions.ts") the way the page's JavaScript does. Returns its
 * result and the whole answer: after refresh() the answer also carries the page, rendered anew.
 */
export async function callAction(page: string, cookie: string, file: string, name: string, args: unknown[]) {
  const manifest = JSON.parse(readFileSync(new URL("../.next/server/server-reference-manifest.json", import.meta.url), "utf8"));
  const id = Object.entries(manifest.node as Record<string, { exportedName: string; filename: string }>)
    .find(([, entry]) => entry.exportedName === name && entry.filename === file)?.[0];
  if (!id) throw new Error(`No Server Action ${name} in ${file}`);
  const res = await fetch(page, {
    method: "POST",
    redirect: "manual",
    headers: { "Next-Action": id, "Content-Type": "text/plain;charset=UTF-8", Accept: "text/x-component", Cookie: cookie, Origin: new URL(page).origin },
    body: JSON.stringify(args),
  });
  // React's answer is a stream of "row:value" lines. Row 0 holds { a: the action's result, ... }.
  const payload = await res.text();
  const rows = new Map(payload.split("\n").filter(Boolean).map((line) => {
    const colon = line.indexOf(":");
    return [line.slice(0, colon), line.slice(colon + 1)] as [string, string];
  }));
  const root = JSON.parse(rows.get("0") ?? "null");
  const result = typeof root?.a === "string" && root.a.startsWith("$@") ? JSON.parse(rows.get(root.a.slice(2)) ?? "null") : root?.a;
  return { result, payload };
}

/** Text React rendered as HTML. Every dashboard page also carries all its texts in its page data. */
export const shown = (html: string, text: string) => html.includes(`>${text}<`);
