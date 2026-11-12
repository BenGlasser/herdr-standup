// Where the standup's tickets and pull requests come from: the trackers you turn on. ClickUp, Linear
// and Jira through their APIs with a token from the keychain; GitHub through the gh CLI's sign-in;
// GitLab through its API with a token. Each returns some of { open, closed, prs, reviews } in the
// shapes report.js describes, or throws a message for the panel. They only read.
import { exec } from "herdr";

const DAY = 86400000;
const PROGRESS = /progress|doing|review|active|started|working|developing/i;
const BLOCKED = /block|waiting|on hold/i;
const PRIORITY_LABEL = /(?:^|[^a-z])(?:priority|prio|pri)?[\s:/_-]*(urgent|critical|highest|high|medium|normal|low|lowest)(?![a-z])|^p([0-3])$/i;

const enc = encodeURIComponent;
const day = (at) => new Date(at).toISOString().slice(0, 10);
const inSpan = (at, span) => at != null && at >= span.from && at < span.to;
// A timestamp in ms; also reads Jira's "+0000" offsets, which aren't ISO.
const ms = (s) => (s ? Date.parse(String(s).replace(/([+-]\d{2})(\d{2})$/, "$1:$2")) || null : null);
// A date with no time ("2026-11-14"), as the start of that day here.
const dateOnly = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s ?? ""); return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : null; };

export function priorityFromLabels(labels) {
  for (const l of labels) {
    const m = PRIORITY_LABEL.exec(l);
    if (!m) continue;
    const word = (m[1] ?? ["urgent", "high", "normal", "low"][Number(m[2])]).toLowerCase();
    return { critical: "urgent", highest: "urgent", medium: "normal", lowest: "low" }[word] ?? word;
  }
  return null;
}

// A tracker's priority name as one of the report's four (Jira's Highest/Blocker…Trivial too).
function priorityWord(name) {
  const w = String(name ?? "").toLowerCase();
  if (/urgent|critical|highest|blocker/.test(w)) return "urgent";
  if (/high|major/.test(w)) return "high";
  if (/low|minor|trivial/.test(w)) return "low";
  if (/medium|normal/.test(w)) return "normal";
  return null;
}

// A JSON request; a failure throws "<Name> said 401: <its message>".
async function http(name, url, opts = {}) {
  const res = await fetch(url, opts);
  const body = await res.text();
  if (!res.ok) {
    let why = body.slice(0, 160).trim();
    try {
      const j = JSON.parse(body);
      why = j.err ?? j.message ?? j.error ?? j.errorMessages?.[0] ?? j.errors?.[0]?.message ?? why;
    } catch {}
    if (typeof why !== "string") why = JSON.stringify(why).slice(0, 160);
    throw new Error(`${name} said ${res.status}${why ? `: ${why}` : ""}`);
  }
  return body ? JSON.parse(body) : {};
}

// ---- ClickUp ---------------------------------------------------------------------------------------
const clickupCall = (token, path) => http("ClickUp", `https://api.clickup.com/api/v2${path}`, { headers: { Authorization: token } });

function clickupTicket(t) {
  const status = t.status?.status ?? "";
  const tags = (t.tags ?? []).map((x) => x.name ?? "");
  return {
    source: "clickup", ref: t.custom_id || `#${t.id}`, title: t.name ?? "", url: t.url ?? `https://app.clickup.com/t/${t.id}`,
    status, progress: PROGRESS.test(status), priority: t.priority?.priority ?? null,
    due: t.due_date ? Number(t.due_date) : null, doneAt: t.date_done ? Number(t.date_done) : t.date_closed ? Number(t.date_closed) : null,
    blocked: BLOCKED.test(status) || tags.some((x) => /block/i.test(x)), updated: Number(t.date_updated ?? 0),
    type: t.status?.type ?? "custom", match: { text: t.custom_id || t.id },
  };
}

// Your ClickUp tasks: open ones assigned to you, and those finished (done or closed) in the span.
// `team`: the workspace's id or name; blank is your first.
export async function clickup(token, { team }, span) {
  const me = (await clickupCall(token, "/user")).user;
  const teams = (await clickupCall(token, "/team")).teams ?? [];
  const want = String(team ?? "").trim().toLowerCase();
  const ws = teams.find((x) => want && (String(x.id) === want || x.name?.toLowerCase() === want)) ?? teams[0];
  if (!ws) throw new Error("this token can't see any ClickUp workspace");
  const pages = async (q) => {
    const all = [];
    for (let page = 0; page < 5; page++) {
      const d = await clickupCall(token, `/team/${ws.id}/task?page=${page}&assignees%5B%5D=${me.id}&subtasks=true&${q}`);
      all.push(...(d.tasks ?? []));
      if (d.last_page === true || (d.tasks ?? []).length < 100) break;
    }
    return all.map(clickupTicket);
  };
  const open = (await pages("include_closed=false&order_by=updated")).filter((t) => t.type !== "done" && t.type !== "closed");
  const closed = await pages(`include_closed=true&date_done_gt=${span.from}&date_done_lt=${span.to}`);
  return { open, closed };
}

// ---- GitHub (gh) -----------------------------------------------------------------------------------
async function gh(query, vars) {
  const args = ["api", "graphql", "-f", `query=${query}`, ...Object.entries(vars).flatMap(([k, v]) => ["-f", `${k}=${v}`])];
  const r = await exec("gh", args, { timeout: 45000 }).catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
  if (r.code !== 0) {
    const err = r.stderr || "gh failed";
    throw new Error(/not logged|auth login/i.test(err) ? "gh isn't signed in (run gh auth login)"
      : /ENOENT|not found|no such file/i.test(err) ? "the gh CLI isn't installed" : err.trim().split("\n")[0]);
  }
  const d = JSON.parse(r.stdout);
  if (!d.data && d.errors?.length) throw new Error(d.errors[0].message);
  return d.data ?? {};
}

const ISSUE_FIELDS = "title url number state closedAt updatedAt repository { name nameWithOwner } labels(first: 20) { nodes { name } } milestone { dueOn }";
const PR_FIELDS = "number title url createdAt mergedAt isDraft headRefName author { login } repository { name nameWithOwner }";

function githubTicket(i) {
  const labels = (i.labels?.nodes ?? []).map((l) => l.name);
  const blocked = labels.some((l) => BLOCKED.test(l)), progress = labels.some((l) => PROGRESS.test(l));
  return {
    source: "github", ref: `${i.repository.name}#${i.number}`, title: i.title, url: i.url,
    status: blocked ? "blocked" : progress ? "in progress" : i.state.toLowerCase(), progress, priority: priorityFromLabels(labels),
    due: i.milestone?.dueOn ? Date.parse(i.milestone.dueOn) : null, doneAt: ms(i.closedAt),
    blocked, updated: ms(i.updatedAt) ?? 0, match: { repo: i.repository.name, number: i.number },
  };
}

function githubPr(n, action, at) {
  return {
    source: "github", ref: `${n.repository.name}#${n.number}`, title: n.title, url: n.url, repo: n.repository.name,
    sigil: "#", number: n.number, branch: n.headRefName ?? null, author: n.author?.login ?? null, draft: Boolean(n.isDraft), action, at,
  };
}

// Your GitHub work: issues assigned to you (open, and closed in the span) and pull requests (yours
// merged or opened in the span, others' you reviewed in it, and open ones waiting on your review).
// `filter` narrows every search ("org:acme", "repo:acme/api").
export async function github({ filter, issues = true, prs = true }, span) {
  const f = String(filter ?? "").trim(), since = day(span.from - DAY);
  const out = { open: [], closed: [], prs: [], reviews: [] };
  const search = (name, fields) => `${name}: search(query: $${name}, type: ISSUE, first: 50) { nodes { ${fields} } }`;
  const parts = [], vars = {};
  if (issues) {
    parts.push(search("open", `... on Issue { ${ISSUE_FIELDS} }`), search("closed", `... on Issue { ${ISSUE_FIELDS} }`));
    vars.open = `is:issue is:open assignee:@me ${f} sort:updated-desc`;
    vars.closed = `is:issue is:closed assignee:@me closed:${since}..${day(span.to + DAY)} ${f}`;
  }
  if (prs) {
    parts.push(search("merged", `... on PullRequest { ${PR_FIELDS} }`), search("opened", `... on PullRequest { ${PR_FIELDS} }`),
      search("reviewed", `... on PullRequest { ${PR_FIELDS} reviews(last: 50) { nodes { author { login } state submittedAt } } }`),
      search("waiting", `... on PullRequest { ${PR_FIELDS} }`));
    vars.merged = `is:pr author:@me merged:>=${since} ${f}`;
    vars.opened = `is:pr author:@me created:>=${since} ${f}`;
    vars.reviewed = `is:pr reviewed-by:@me -author:@me updated:>=${since} ${f}`;
    vars.waiting = `is:pr is:open review-requested:@me archived:false ${f} sort:created-asc`;
  }
  if (!parts.length) return out;
  const decl = Object.keys(vars).map((k) => `$${k}: String!`).join(", ");
  const d = await gh(`query(${decl}) { viewer { login } ${parts.join(" ")} }`, vars);
  const nodes = (k) => (d[k]?.nodes ?? []).filter((n) => n?.url);
  out.open = nodes("open").map(githubTicket);
  out.closed = nodes("closed").map(githubTicket).filter((t) => inSpan(t.doneAt, span));
  for (const n of nodes("merged")) if (inSpan(ms(n.mergedAt), span)) out.prs.push(githubPr(n, "merged", ms(n.mergedAt)));
  for (const n of nodes("opened")) if (inSpan(ms(n.createdAt), span)) out.prs.push(githubPr(n, "opened", ms(n.createdAt)));
  const me = String(d.viewer?.login ?? "").toLowerCase();
  for (const n of nodes("reviewed")) {
    const mine = (n.reviews?.nodes ?? []).filter((r) => String(r.author?.login ?? "").toLowerCase() === me && inSpan(ms(r.submittedAt), span));
    if (!mine.length) continue;
    const action = mine.some((r) => r.state === "APPROVED") ? "approved" : mine.some((r) => r.state === "CHANGES_REQUESTED") ? "changes" : "reviewed";
    out.prs.push(githubPr(n, action, Math.max(...mine.map((r) => ms(r.submittedAt)))));
  }
  out.reviews = nodes("waiting").filter((n) => !n.isDraft).map((n) => githubPr(n, "review", ms(n.createdAt)));
  return out;
}

// ---- GitLab (API token) ----------------------------------------------------------------------------
const gitlabHost = (host) => String(host || "https://gitlab.com").trim().replace(/\/+$/, "");
const gitlabCall = (host, token, path) => http("GitLab", `${gitlabHost(host)}/api/v4${path}`, { headers: { "PRIVATE-TOKEN": token } });
// "group/sub/project#12" → "project"
const project = (full, sigil) => String(full ?? "").split(sigil)[0].split("/").pop();

function gitlabTicket(i) {
  const labels = i.labels ?? [];
  const blocked = labels.some((l) => BLOCKED.test(l)), progress = labels.some((l) => PROGRESS.test(l));
  const repo = project(i.references?.full, "#");
  return {
    source: "gitlab", ref: `${repo}#${i.iid}`, title: i.title ?? "", url: i.web_url,
    status: blocked ? "blocked" : progress ? "in progress" : i.state, progress, priority: priorityFromLabels(labels),
    due: dateOnly(i.due_date) ?? dateOnly(i.milestone?.due_date), doneAt: ms(i.closed_at), blocked,
    updated: ms(i.updated_at) ?? 0, match: { repo, number: i.iid },
  };
}

function gitlabPr(m, action, at) {
  const repo = project(m.references?.full, "!");
  return {
    source: "gitlab", ref: `${repo}!${m.iid}`, title: m.title ?? "", url: m.web_url, repo, sigil: "!", number: m.iid,
    branch: m.source_branch ?? null, author: m.author?.username ?? null, draft: Boolean(m.draft ?? m.work_in_progress), action, at,
  };
}

// Your GitLab work: issues assigned to you (open, and closed in the span) and merge requests (yours
// merged or opened in the span; others' you approved or commented on in it, from your activity; open
// ones that name you as a reviewer). `host`: blank is gitlab.com.
export async function gitlab(token, { host, issues = true, mrs = true }, span) {
  const call = (path) => gitlabCall(host, token, path);
  const since = enc(new Date(span.from - DAY).toISOString());
  const me = await call("/user");
  const out = { open: [], closed: [], prs: [], reviews: [] };
  const jobs = [];
  if (issues) jobs.push((async () => {
    out.open = (await call("/issues?scope=assigned_to_me&state=opened&order_by=updated_at&per_page=100")).map(gitlabTicket);
    out.closed = (await call(`/issues?scope=assigned_to_me&state=closed&updated_after=${since}&per_page=100`))
      .map(gitlabTicket).filter((t) => inSpan(t.doneAt, span));
  })());
  if (mrs) jobs.push((async () => {
    for (const m of await call(`/merge_requests?scope=created_by_me&state=merged&updated_after=${since}&per_page=100`))
      if (inSpan(ms(m.merged_at), span)) out.prs.push(gitlabPr(m, "merged", ms(m.merged_at)));
    const from = enc(new Date(span.from).toISOString()), to = enc(new Date(span.to).toISOString());
    for (const m of await call(`/merge_requests?scope=created_by_me&created_after=${from}&created_before=${to}&per_page=100`))
      out.prs.push(gitlabPr(m, "opened", ms(m.created_at)));
    // Reviews: your approvals and comments in the span (event dates are whole days, so a day either side).
    const window = `after=${day(span.from - DAY)}&before=${day(span.to + DAY)}&per_page=100`;
    const events = [...await call(`/events?action=approved&target_type=merge_request&${window}`),
      ...await call(`/events?action=commented&target_type=note&${window}`)].filter((e) => inSpan(ms(e.created_at), span));
    const touched = new Map();
    for (const e of events) {
      const iid = e.target_type === "MergeRequest" ? e.target_iid : e.note?.noteable_type === "MergeRequest" ? e.note.noteable_iid : null;
      if (!iid || !e.project_id) continue;
      const key = `${e.project_id}!${iid}`, was = touched.get(key);
      touched.set(key, { project: e.project_id, iid, approved: e.action_name === "approved" || Boolean(was?.approved), at: Math.max(was?.at ?? 0, ms(e.created_at)) });
    }
    for (const x of [...touched.values()].slice(0, 20)) {
      const m = await call(`/projects/${x.project}/merge_requests/${x.iid}`).catch(() => null);
      if (m && m.author?.id !== me.id) out.prs.push(gitlabPr(m, x.approved ? "approved" : "reviewed", x.at));
    }
    out.reviews = (await call(`/merge_requests?scope=all&state=opened&reviewer_username=${enc(me.username)}&order_by=created_at&sort=asc&per_page=50`))
      .filter((m) => !(m.draft ?? m.work_in_progress)).map((m) => gitlabPr(m, "review", ms(m.created_at)));
  })());
  await Promise.all(jobs);
  return out;
}

// ---- Linear (API key) ------------------------------------------------------------------------------
const LINEAR_FIELDS = "identifier title url priority dueDate completedAt updatedAt state { name type } labels(first: 10) { nodes { name } } "
  + "inverseRelations(first: 10) { nodes { type issue { identifier completedAt canceledAt } } }";

async function linearCall(token, query) {
  const d = await http("Linear", "https://api.linear.app/graphql", {
    method: "POST", headers: { Authorization: token, "Content-Type": "application/json" }, body: JSON.stringify({ query }),
  });
  if (d.errors?.length) throw new Error(`Linear said: ${d.errors[0].message}`);
  return d.data ?? {};
}

function linearTicket(i) {
  const labels = (i.labels?.nodes ?? []).map((l) => l.name), state = i.state?.name ?? "";
  // Blocked: its state or a label says so, or an issue that blocks it isn't finished.
  const by = (i.inverseRelations?.nodes ?? []).filter((r) => r.type === "blocks" && r.issue && !r.issue.completedAt && !r.issue.canceledAt).map((r) => r.issue.identifier);
  const named = BLOCKED.test(state) || labels.some((l) => BLOCKED.test(l));
  return {
    source: "linear", ref: i.identifier, title: i.title ?? "", url: i.url, status: !named && by.length ? `blocked by ${by.join(", ")}` : state,
    progress: i.state?.type === "started", priority: [null, "urgent", "high", "normal", "low"][i.priority] ?? null,
    due: dateOnly(i.dueDate), doneAt: ms(i.completedAt), blocked: named || by.length > 0, updated: ms(i.updatedAt) ?? 0,
    match: { text: i.identifier },
  };
}

// Your Linear issues: open ones assigned to you, and those completed in the span.
export async function linear(token, _opts, span) {
  const from = JSON.stringify(new Date(span.from).toISOString()), to = JSON.stringify(new Date(span.to).toISOString());
  const d = await linearCall(token, `query { viewer {
    open: assignedIssues(first: 50, orderBy: updatedAt, filter: { state: { type: { nin: ["completed", "canceled"] } } }) { nodes { ${LINEAR_FIELDS} } }
    done: assignedIssues(first: 50, filter: { completedAt: { gte: ${from}, lt: ${to} } }) { nodes { ${LINEAR_FIELDS} } } } }`);
  return { open: (d.viewer?.open?.nodes ?? []).map(linearTicket), closed: (d.viewer?.done?.nodes ?? []).map(linearTicket) };
}

// ---- Jira (API token) ------------------------------------------------------------------------------
// Jira Cloud (*.atlassian.net): your email and an API token. Jira Data Center: a personal access token, no email.
const jiraSite = (site) => { const s = String(site ?? "").trim().replace(/\/+$/, ""); return s && !/^https?:\/\//i.test(s) ? `https://${s}` : s; };
const isCloud = (site) => /\.atlassian\.net$/i.test(site.replace(/^https?:\/\//i, ""));
const jiraHeaders = (token, email) => ({ Authorization: email ? `Basic ${base64(`${email}:${token}`)}` : `Bearer ${token}`, Accept: "application/json" });
const JIRA_FIELDS = "summary,status,priority,duedate,resolutiondate,statuscategorychangedate,updated,labels";

async function jiraSearch(site, headers, jql) {
  const all = [];
  if (isCloud(site)) {
    let next = null;
    for (let page = 0; page < 3; page++) {
      const d = await http("Jira", `${site}/rest/api/3/search/jql?jql=${enc(jql)}&fields=${JIRA_FIELDS}&maxResults=100${next ? `&nextPageToken=${enc(next)}` : ""}`, { headers });
      all.push(...(d.issues ?? []));
      if (d.isLast !== false || !d.nextPageToken) break;
      next = d.nextPageToken;
    }
  } else {
    for (let at = 0; at < 300; at += 100) {
      const d = await http("Jira", `${site}/rest/api/2/search?jql=${enc(jql)}&fields=${JIRA_FIELDS}&maxResults=100&startAt=${at}`, { headers });
      all.push(...(d.issues ?? []));
      if (at + 100 >= (d.total ?? 0)) break;
    }
  }
  return all;
}

function jiraTicket(site, i) {
  const f = i.fields ?? {}, status = f.status?.name ?? "";
  return {
    source: "jira", ref: i.key, title: f.summary ?? "", url: `${site}/browse/${i.key}`, status,
    progress: f.status?.statusCategory?.key === "indeterminate", priority: priorityWord(f.priority?.name),
    due: dateOnly(f.duedate), doneAt: ms(f.resolutiondate) ?? ms(f.statuscategorychangedate) ?? ms(f.updated),
    blocked: BLOCKED.test(status) || (f.labels ?? []).some((l) => BLOCKED.test(l)), updated: ms(f.updated) ?? 0, match: { text: i.key },
  };
}

// Your Jira issues: open ones assigned to you, and those that reached Done in the span. `jql` narrows
// both ("project = APP").
export async function jira(token, { site, email, jql }, span) {
  const base = jiraSite(site);
  if (!base) throw new Error("add your Jira site in settings");
  const headers = jiraHeaders(token, String(email ?? "").trim());
  const and = String(jql ?? "").trim() ? ` AND (${String(jql).trim()})` : "";
  const days = Math.ceil((Date.now() - span.from) / DAY) + 1;
  const [open, done] = await Promise.all([
    jiraSearch(base, headers, `assignee = currentUser() AND statusCategory != Done${and} ORDER BY updated DESC`),
    jiraSearch(base, headers, `assignee = currentUser() AND statusCategory = Done AND updated >= -${days}d${and} ORDER BY updated DESC`),
  ]);
  return { open: open.map((i) => jiraTicket(base, i)), closed: done.map((i) => jiraTicket(base, i)).filter((t) => inSpan(t.doneAt, span)) };
}

// ---- tokens ----------------------------------------------------------------------------------------
// Whether a tracker takes this token, before it's kept: asks who it belongs to. `s`: the settings.
export async function checkToken(kind, token, s) {
  if (kind === "clickup") return clickupCall(token, "/user");
  if (kind === "gitlab") return gitlabCall(s.gitlab.host, token, "/user");
  if (kind === "linear") return linearCall(token, "query { viewer { id } }");
  if (kind === "jira") {
    const base = jiraSite(s.jira.site);
    if (!base) throw new Error("add your Jira site first");
    return http("Jira", `${base}/rest/api/${isCloud(base) ? 3 : 2}/myself`, { headers: jiraHeaders(token, String(s.jira.email ?? "").trim()) });
  }
  throw new Error(`no token for ${kind}`);
}

// Base64 of text as UTF-8 (for Jira's basic sign-in; the runtime may have no btoa).
export function base64(text) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", b = [];
  for (const ch of String(text)) {
    const c = ch.codePointAt(0);
    if (c < 0x80) b.push(c);
    else if (c < 0x800) b.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) b.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else b.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  let out = "";
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    out += A[(n >> 18) & 63] + A[(n >> 12) & 63] + (i + 1 < b.length ? A[(n >> 6) & 63] : "=") + (i + 2 < b.length ? A[n & 63] : "=");
  }
  return out;
}
