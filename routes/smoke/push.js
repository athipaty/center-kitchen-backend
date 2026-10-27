// Web push for Smoke Finder alerts, using the backend's existing VAPID keys.
const webpush = require("web-push");

const pushConfigured = () =>
  Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT);

let vapidSet = false;
function ensureVapid() {
  if (vapidSet) return;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  vapidSet = true;
}

// Notification texts come from the app's own dictionaries (shipped in the
// smoke-finder package), so the app and its alerts always say the same thing.
const LANGS = ["en", "zh", "ms", "ta", "th"];
let textsPromise;
const loadTexts = () =>
  (textsPromise ??= Promise.all([
    import("smoke-finder/src/rules.js"),
    ...LANGS.map((l) => import(`smoke-finder/app/src/i18n/${l}.js`)),
  ]).then(([rules, ...dicts]) => ({ rules, dicts: Object.fromEntries(LANGS.map((l, i) => [l, dicts[i].default])) })));

const fill = (text, vars) => text.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");

// One notification per device per data update; extra changes are summarised.
async function messageFor(lang, changes) {
  const { rules, dicts } = await loadTexts();
  const dict = dicts[lang] ?? dicts.en;
  const t = (key, vars = {}) => fill(dict[key] ?? dicts.en[key] ?? key, vars);
  const place = (rule) => (rule ? dict[`rule.${rule}.label`] ?? rules.RULES_BY_ID[rule]?.label ?? "" : "");

  const [first] = changes;
  let body = t(`notify.${first.verdict}`, { label: first.label, place: place(first.rule) });
  if (changes.length > 1) body += ` ${t("notify.more", { n: changes.length - 1 })}`;
  return { title: t("notify.title"), body, url: "/map" };
}

// Resolves { ok: true } or { ok: false, gone } — gone means the subscription
// is dead (the user revoked it or uninstalled) and should be deleted.
async function sendPush(subscription, payload) {
  ensureVapid();
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload), { TTL: 24 * 3600 });
    return { ok: true };
  } catch (err) {
    return { ok: false, gone: err.statusCode === 404 || err.statusCode === 410, error: err.message };
  }
}

module.exports = { pushConfigured, messageFor, sendPush };
