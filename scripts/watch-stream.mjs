#!/usr/bin/env node
/* The watchdog that is not on the machine it watches.
 *
 * There is already one on the VPS, reading the self-updater's heartbeat every
 * fifteen minutes, and it catches everything except the fault that matters
 * most: it cannot tell you the box is off, because it would be off too. This
 * one runs on GitHub's infrastructure and probes the stream host from the
 * outside, which is the only vantage point from which "there is nothing
 * there" is an observation rather than a silence.
 *
 * Why not the Vercel cron I first offered: this account is on Hobby, where a
 * cron may run once per DAY, within an hour-wide window of its own choosing.
 * A daily postcard is not a watchdog, and dressing one up as one is worse
 * than not having it.
 *
 * Two channels, and the order is deliberate:
 *   WhatsApp, if the bridge answers — the message he actually reads, and the
 *     one that works for the common fault, a box that is up but stuck.
 *   A GitHub issue, always — because the bridge lives on the machine being
 *     watched, so the total outage is exactly the case where WhatsApp cannot
 *     work. GitHub emails the repository owner when an issue opens. The open
 *     issue is also the state: this job keeps nothing between runs, so
 *     "is there an issue open" IS "am I already complaining about this".
 *
 * Nothing here alerts on a single bad probe. A deploy, an nginx reload and a
 * pm2 restart all look like an outage for a few seconds, and an alert channel
 * that cries during routine work is muted within a week and then fails for
 * the fault that counts.
 */

const TARGET = process.env.WATCH_TARGET || 'https://stream.jrvsystems.app/healthz';
const REPO = process.env.GITHUB_REPOSITORY || 'JRVGLOBALSERVICES/cast-bridge';
const GH_TOKEN = process.env.GITHUB_TOKEN || '';
const HOOK = process.env.CAST_WATCH_HOOK || '';   // https://hook.jrvsystems.app/api/hooks/watch/<token>
const LABEL = 'watchdog';
const SECOND_LOOK_MS = Number(process.env.WATCH_SECOND_LOOK_MS || 90000);

/* ---- the probe ---------------------------------------------------- */

async function probe() {
  const started = Date.now();
  try {
    const res = await fetch(TARGET, {
      signal: AbortSignal.timeout(15000),
      headers: { 'user-agent': 'cast-bridge-watchdog (github actions)' }
    });
    const ms = Date.now() - started;
    if (!res.ok) return { kind: 'unreachable', detail: 'answered HTTP ' + res.status, ms };
    let body;
    try { body = await res.json(); } catch (e) { return { kind: 'unreachable', detail: 'answered with something that is not JSON', ms }; }
    return classify(body, ms);
  } catch (err) {
    /* A DNS failure, a refused connection and a timeout are one story from
       out here: nothing is serving. Which of the three it was belongs in the
       message, because it is the first thing you would want to know. */
    const why = /timeout|abort/i.test(String(err && err.name) + String(err && err.message))
      ? 'no answer within 15s'
      : String(err && err.message || err).slice(0, 120);
    return { kind: 'unreachable', detail: why, ms: Date.now() - started };
  }
}

function classify(body, ms) {
  if (body.ok !== true) return { kind: 'unhealthy', detail: 'healthz says ok:false', ms };

  const u = body.self_update;
  if (!u || typeof u !== 'object') {
    return { kind: 'no_heartbeat', detail: 'serving, but running a build from before the updater stamped anything', ms };
  }
  if (u.state === 'blocked' || u.state === 'pull_failed' || u.state === 'fetch_failed') {
    return { kind: 'wedged', detail: 'the self-updater is ' + u.state + ' — it is alive and cannot move', ms };
  }
  if (u.state === 'never') {
    return { kind: 'no_heartbeat', detail: 'the updater has not run once since the heartbeat was added', ms };
  }
  if (u.stale === true) {
    const age = Number(u.age_s);
    const mins = Number.isFinite(age) ? Math.round(age / 60) + ' min' : 'an unknown time';
    return { kind: 'stale', detail: 'the updater last ticked ' + mins + ' ago — the cron line is gone or the script is erroring', ms };
  }
  return { kind: 'ok', detail: 'up_to_date, heartbeat ' + (u.age_s ?? '?') + 's old', ms };
}

/* ---- the two channels --------------------------------------------- */

async function whatsapp(text) {
  if (!HOOK) return 'no hook configured';
  try {
    const res = await fetch(HOOK, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(12000)
    });
    return res.ok ? 'sent' : 'refused HTTP ' + res.status;
  } catch (e) {
    /* Expected, and informative: the bridge is on the box being watched. */
    return 'unreachable';
  }
}

async function gh(method, path, body) {
  const res = await fetch('https://api.github.com' + path, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: 'Bearer ' + GH_TOKEN,
      'content-type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) throw new Error(method + ' ' + path + ' → HTTP ' + res.status);
  return res.status === 204 ? null : res.json();
}

async function openComplaint() {
  const list = await gh('GET', `/repos/${REPO}/issues?state=open&labels=${LABEL}&per_page=1`);
  return Array.isArray(list) && list.length ? list[0] : null;
}

function since(iso) {
  const mins = Math.max(1, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (mins < 60) return mins + ' min';
  const h = Math.floor(mins / 60);
  return h + 'h ' + (mins % 60) + 'm';
}

/* ---- what to say -------------------------------------------------- */

const HEADLINE = {
  unreachable: 'stream.jrvsystems.app is not answering',
  unhealthy: 'the stream host is answering but reporting itself unhealthy',
  wedged: 'the stream host cannot update itself',
  stale: 'the self-updater has stopped ticking',
  no_heartbeat: 'the stream host has no self-update heartbeat'
};

async function main() {
  let verdict = await probe();

  /* One bad probe is a restart. Look again before believing it. */
  if (verdict.kind !== 'ok') {
    console.log('first look: ' + verdict.kind + ' — waiting ' + Math.round(SECOND_LOOK_MS / 1000) + 's for a second opinion');
    await new Promise((r) => setTimeout(r, SECOND_LOOK_MS));
    const again = await probe();
    if (again.kind === 'ok') {
      console.log('second look: ok — treating the first as a restart, saying nothing');
      verdict = again;
    } else {
      verdict = again;
    }
  }

  /* Deliberately not the whole body: these logs are public. */
  console.log('verdict: ' + verdict.kind + ' (' + verdict.detail + ') in ' + verdict.ms + 'ms');

  const open = GH_TOKEN ? await openComplaint() : null;

  if (verdict.kind === 'ok') {
    if (!open) { console.log('healthy, nothing outstanding — silent'); return; }
    const lasted = since(open.created_at);
    const line = '✅ ' + 'stream.jrvsystems.app is back. It was unreachable or stuck for ' + lasted + '. ' + verdict.detail + '.';
    console.log('whatsapp: ' + await whatsapp(line));
    await gh('POST', `/repos/${REPO}/issues/${open.number}/comments`, { body: line + '\n\nClosed by the external watchdog.' });
    await gh('PATCH', `/repos/${REPO}/issues/${open.number}`, { state: 'closed', state_reason: 'completed' });
    console.log('closed #' + open.number + ' after ' + lasted);
    return;
  }

  const headline = HEADLINE[verdict.kind] || 'the stream host is in a state this watchdog does not have a name for';
  const line = '🔴 ' + headline + ' — ' + verdict.detail + '. Seen twice, ' +
               Math.round(SECOND_LOOK_MS / 1000) + 's apart, from outside the VPS.';

  /* Already complaining? Then say nothing — a fault that repeats every ten
     minutes for an hour is how an alert channel gets muted, and a muted
     channel fails for the fault that counts.
     
     With one exception, and it is the case this whole job exists for: if the
     first alert could not reach WhatsApp because the box was off, the message
     he actually reads was never delivered. So a run that finds the bridge
     answering again delivers it late, once, and records that it did. */
  if (open) {
    const undelivered = /\| WhatsApp \| (unreachable|refused|no hook configured)/.test(open.body || '');
    if (!undelivered) { console.log('already complaining in #' + open.number + ' — silent'); return; }
    const late = await whatsapp(line);
    console.log('retrying the undelivered alert: ' + late);
    if (late !== 'sent') return;
    await gh('PATCH', `/repos/${REPO}/issues/${open.number}`, {
      body: (open.body || '').replace(/\| WhatsApp \| [^|\n]*\|/, '| WhatsApp | sent late, once the bridge answered again |')
    });
    await gh('POST', `/repos/${REPO}/issues/${open.number}/comments`, {
      body: 'The bridge answers again but the stream host still does not. ' +
            'The original alert has now been delivered to WhatsApp.'
    });
    return;
  }

  const sent = await whatsapp(line);
  console.log('whatsapp: ' + sent);

  if (!GH_TOKEN) { console.log('no GITHUB_TOKEN — WhatsApp was the only channel'); return; }

  const issue = await gh('POST', `/repos/${REPO}/issues`, {
    title: '🔴 ' + headline,
    labels: [LABEL],
    body: [
      line,
      '',
      '| | |',
      '|---|---|',
      '| target | `' + TARGET + '` |',
      '| verdict | `' + verdict.kind + '` |',
      '| WhatsApp | ' + sent + ' |',
      '',
      sent === 'unreachable'
        ? 'The bridge did not answer either, which is consistent with the whole VPS being down — ' +
          'that is why this issue exists, since WhatsApp cannot reach anyone when the machine that ' +
          'sends it is the machine that is off.'
        : 'WhatsApp was reachable, so the box is up and stuck rather than gone.',
      '',
      'This issue is also the watchdog\'s memory. It closes itself, with the outage duration, ' +
      'on the first healthy probe. Closing it by hand only means it will open a new one.'
    ].join('\n')
  });
  console.log('opened #' + issue.number);
}

main().catch((err) => { console.error('watchdog itself failed: ' + err.message); process.exit(1); });
