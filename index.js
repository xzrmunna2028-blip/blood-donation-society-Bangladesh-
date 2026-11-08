/* অ্যাডমিনে "Send notification" চাপলে push_queue-তে লেখা হয় → এই ফাংশন OneSignal দিয়ে সবাইকে পুশ পাঠায়।
   OneSignal REST API Key onesignal.config.js-এ বসান (অথবা Firebase Secret ব্যবহার করুন, README দেখুন)।
   আগের ভার্সনের ভুল: OneSignal কাউকে না পেলেও HTTP 200 দেয় (id ফাঁকা, errors-এ "not subscribed"),
   আর কোড সেটাকে সফল ধরত। এখন সত্যিকারের সফলতা (id আছে কিনা) দেখে, না হলে আরেকটা সেগমেন্টে চেষ্টা করে। */
const { onValueCreated, onValueWritten } = require("firebase-functions/v2/database");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
admin.initializeApp();

const CFG = require("./onesignal.config.js");
const ONESIGNAL_KEY = defineSecret("ONESIGNAL_API_KEY");
const APP_ID = CFG.APP_ID;
// onesignal.config.js-এ REST_API_KEY বসানো থাকলে সেটা চলে (আলাদা Secret লাগে না); ফাঁকা থাকলে Firebase Secret ব্যবহার হয়
const SECRETS = CFG.REST_API_KEY ? [] : [ONESIGNAL_KEY];
const getKey = () => CFG.REST_API_KEY || ONESIGNAL_KEY.value();
const SEGMENTS = ["Subscribed Users", "Total Subscriptions"];

async function sendOnce(key, payload) {
  if (!APP_ID || !key) return { res: { ok: false, status: 0 }, out: { errors: ["OneSignal App ID / REST API Key এখনো বসানো হয়নি"] } };
  const scheme = /^os_v2_/.test(key) ? "Key " : "Basic "; // নতুন কী = Key, পুরনো REST কী = Basic
  const res = await fetch("https://api.onesignal.com/notifications", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: scheme + key },
    body: JSON.stringify(payload),
  });
  const out = await res.json().catch(() => ({}));
  return { res, out };
}

exports.sendPush = onValueCreated(
  { ref: "/push_queue/{id}", region: "asia-southeast1", instance: "blood-society-3727a-default-rtdb", secrets: SECRETS },
  async (event) => {
    const d = event.data.val() || {};
    const title = String(d.title || "Blood Donate Society").slice(0, 120);
    const body = String(d.body || d.title || "—").slice(0, 500);
    const key = getKey();
    let last = null;
    try {
      for (const seg of SEGMENTS) {
        const payload = {
          app_id: APP_ID,
          target_channel: "push",
          included_segments: [seg],
          headings: { en: title },
          contents: { en: body },
        };
        if (d.url && /^https?:\/\//.test(String(d.url))) payload.url = String(d.url);
        const r = await sendOnce(key, payload);
        last = { seg, status: r.res.status, out: r.out };
        console.log("onesignal", seg, r.res.status, JSON.stringify(r.out).slice(0, 400));
        if (r.res.ok && r.out && r.out.id) break; // সত্যিই পাঠানো হয়েছে
      }
    } catch (e) {
      return event.data.ref.update({ done: false, error: String(e).slice(0, 300) });
    }
    const ok = !!(last && last.status >= 200 && last.status < 300 && last.out && last.out.id);
    if (ok && !d.log) {
      /* অ্যাপের বেল আইকনের তালিকার জন্য */
      await event.data.ref.root.child("push_log").push({ title, body, ts: Date.now() });
    }
    return event.data.ref.update({
      done: ok,
      status: last ? last.status : 0,
      segment: last ? last.seg : null,
      onesignal_id: ok ? last.out.id : null,
      error: ok ? null : JSON.stringify((last && last.out) || {}).slice(0, 300),
    });
  }
);

/* নতুন কেউ সাবস্ক্রাইব করলে (push_subs/<uid>/optedIn false→true) অ্যাডমিনদের কাছে পুশ আসে।
   অ্যাডমিন যে ডিভাইসে নিজের অ্যাডমিন অ্যাকাউন্ট দিয়ে সাইটে লগইন করে সাবস্ক্রাইব করেছেন, সেখানে পৌঁছায়। */
exports.notifyAdminNewSub = onValueWritten(
  { ref: "/push_subs/{uid}", region: "asia-southeast1", instance: "blood-society-3727a-default-rtdb", secrets: SECRETS },
  async (event) => {
    const before = event.data.before.val();
    const after = event.data.after.val();
    if (!after || after.optedIn !== true) return null;
    if (before && before.optedIn === true) return null;
    const root = event.data.after.ref.root;
    const adm = (await root.child("admins").once("value")).val() || {};
    const ids = Object.keys(adm).filter((k) => adm[k] === true);
    if (!ids.length) return null;
    const all = (await root.child("push_subs").once("value")).val() || {};
    const total = Object.values(all).filter((x) => x && x.optedIn === true).length;
    const who = String(after.name || after.email || "একজন ইউজার").slice(0, 60);
    const r = await sendOnce(getKey(), {
      app_id: APP_ID,
      target_channel: "push",
      include_aliases: { external_id: ids },
      headings: { en: "নতুন সাবস্ক্রাইবার" },
      contents: { en: who + " সাবস্ক্রাইব করেছে। মোট সাবস্ক্রাইবার: " + total },
    });
    console.log("notifyAdminNewSub", r.res.status, JSON.stringify(r.out).slice(0, 300));
    return null;
  }
);

/* নির্দিষ্ট ইউজারদের নোটিফিকেশন: অ্যাডমিন push_targeted-এ লেখে → শুধু ওই ইউজারদের ফোনে পুশ যায় (external_id = Firebase uid) */
exports.sendPushTargeted = onValueCreated(
  { ref: "/push_targeted/{id}", region: "asia-southeast1", instance: "blood-society-3727a-default-rtdb", secrets: SECRETS },
  async (event) => {
    const d = event.data.val() || {};
    const ids = (Array.isArray(d.to) ? d.to : Object.keys(d.to || {})).filter(Boolean).slice(0, 1500);
    if (!ids.length) return event.data.ref.update({ done: false, error: "no recipients" });
    const title = String(d.title || "Blood Donate Society").slice(0, 120);
    const body = String(d.body || d.title || "\u2014").slice(0, 500);
    try {
      const r = await sendOnce(getKey(), { app_id: APP_ID, target_channel: "push", include_aliases: { external_id: ids }, headings: { en: title }, contents: { en: body } });
      const ok = !!(r.res.ok && r.out && r.out.id);
      return event.data.ref.update({ done: ok, status: r.res.status, onesignal_id: ok ? r.out.id : null, error: ok ? null : JSON.stringify(r.out || {}).slice(0, 300) });
    } catch (e) {
      return event.data.ref.update({ done: false, error: String(e).slice(0, 300) });
    }
  }
);
