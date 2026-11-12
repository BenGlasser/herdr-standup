// The standup itself, from what the sources found: what got done on the last working day, what's
// next, and what's in the way. No Herdr imports, so it can be tried outside Herdr.
//
// A ticket, from any tracker:
//   { source, ref, title, url, status, progress, priority, due, doneAt, blocked, updated, match }
//   priority: "urgent" | "high" | "normal" | "low" | null; due, doneAt, updated: ms or null;
//   progress: it's being worked on; match: how a commit message names it ({ text } or { repo, number })
// A commit: { repo, sha, subject, at, url, branch } (branch: set for work not merged yet)
// A pull request (or GitLab merge request):
//   { source, ref, title, url, repo, sigil, number, branch, author, draft, action, at }
//   ref: "api#12" or "api!12"; sigil: "#" or "!"; action: what you did in the span ("merged" or
//   "opened" yours; "approved", "changes" or "reviewed" someone else's), or "review": open, waiting on you

const DAY = 86400000;
const PRIORITY = { urgent: 0, high: 1, normal: 2, low: 3 };
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// What counts most when you did several things to one pull request.
const ACTIONS = ["merged", "opened", "approved", "changes", "reviewed"];
export const VERB = { merged: "Merged", opened: "Opened", approved: "Approved", changes: "Requested changes on", reviewed: "Reviewed", review: "Review" };

export const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
export const dayKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
export const dateLabel = (ms) => { const d = new Date(ms); return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`; };
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// "Yesterday" as a span of local time ending at the start of today: the previous workday (on a
// Monday that's Friday, with the weekend in it), or the previous calendar day.
export function lookback(now, mode = "workday") {
  const to = startOfDay(now);
  let from = startOfDay(to - DAY / 2);
  if (mode === "workday") while ([0, 6].includes(new Date(from).getDay())) from = startOfDay(from - DAY / 2);
  const name = from === startOfDay(to - DAY / 2) ? "Yesterday" : ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][new Date(from).getDay()];
  return { from, to, name, label: dateLabel(from) };
}

// When a ticket is due, in words: "overdue 2d", "due today", "due tomorrow", "due Fri, Nov 14".
export function dueText(due, now) {
  if (due == null) return null;
  const days = Math.round((startOfDay(due) - startOfDay(now)) / DAY);
  if (days < 0) return { text: `overdue ${-days}d`, late: true };
  if (days === 0) return { text: "due today", soon: true };
  if (days === 1) return { text: "due tomorrow", soon: true };
  return { text: `due ${dateLabel(due)}` };
}

// Whether a commit message names a ticket: its id as a word ("APP-1234: fix …"), or for a GitHub
// or GitLab issue "#12" in that issue's repo.
export function names(ticket, commit) {
  const m = ticket.match;
  if (!m) return false;
  if (m.text) return new RegExp(`(^|[^\\w-])${esc(m.text)}(?![\\w-])`, "i").test(commit.subject);
  if (m.number) return String(commit.repo).toLowerCase() === String(m.repo).toLowerCase() && new RegExp(`#${m.number}(?!\\d)`).test(commit.subject);
  return false;
}

// Whether a pull request is for a ticket: its title names it, or its branch does ("app-1234-fix").
export function mentions(ticket, pr) {
  if (names(ticket, { repo: pr.repo, subject: pr.title })) return true;
  const text = ticket.match?.text;
  return Boolean(text && pr.branch && new RegExp(`(^|[^a-z0-9])${esc(text)}(?![0-9])`, "i").test(pr.branch));
}

// Whether a commit is part of a pull request, in the same repo: its subject names it the way
// merges and squashes do ("Fix login (#12)", "… (!12)"), or it's on the request's branch.
export function inPr(pr, commit) {
  if (String(commit.repo).toLowerCase() !== String(pr.repo).toLowerCase()) return false;
  if (commit.branch && pr.branch && commit.branch === pr.branch) return true;
  return new RegExp(`\\(${esc(pr.sigil ?? "#")}${pr.number}\\)`).test(commit.subject);
}

// What to do today, most pressing first: overdue or due today, then what's in progress, then by
// priority, then the soonest due, then the most recently touched.
export function rankToday(tickets, now) {
  const today = startOfDay(now);
  const key = (x) => [
    x.due != null && x.due < today + DAY ? 0 : 1,
    x.progress ? 0 : 1,
    PRIORITY[x.priority] ?? 4,
    x.due ?? Infinity,
    -(x.updated ?? 0),
  ];
  return [...tickets].sort((a, b) => {
    const ka = key(a), kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
    return 0;
  });
}

// One of each pull request (by its link), keeping what counts most.
function onePerPr(prs) {
  const byUrl = new Map();
  for (const p of prs) {
    const k = p.url ?? `${p.source}:${p.ref}`, was = byUrl.get(k);
    if (!was || ACTIONS.indexOf(p.action) < ACTIONS.indexOf(was.action)) byUrl.set(k, p);
  }
  return [...byUrl.values()];
}

// The standup: { span, yesterday: [...], today: { items, more }, reviews: { items, more }, blockers: [...] }.
//   yesterday: { kind: "ticket", ticket, commits, prs } (closed, with the commits and pull requests
//   for it), then { kind: "pr", pr, commits } (the other pull requests: merged, opened, reviewed),
//   then { kind: "repo", repo, commits, unmerged } (the rest, by repo; merged work first)
//   reviews: open pull requests waiting on your review, oldest first
export function build({ open = [], closed = [], commits = [], prs = [], reviews = [] }, { now = Date.now(), mode = "workday", todayMax = 5 } = {}) {
  const span = lookback(now, mode);
  const done = closed.filter((t) => t.doneAt == null || (t.doneAt >= span.from && t.doneAt < span.to))
    .sort((a, b) => (a.doneAt ?? 0) - (b.doneAt ?? 0));
  const pulls = onePerPr(prs).sort((a, b) => ACTIONS.indexOf(a.action) - ACTIONS.indexOf(b.action) || (a.at ?? 0) - (b.at ?? 0));
  const used = new Set(), usedPr = new Set();
  const take = (test) => { const mine = commits.filter((c) => !used.has(c.sha) && test(c)); mine.forEach((c) => used.add(c.sha)); return mine; };
  const yesterday = done.map((ticket) => {
    const mine = take((c) => names(ticket, c));
    const ps = pulls.filter((p) => !usedPr.has(p) && mentions(ticket, p));
    ps.forEach((p) => usedPr.add(p));
    for (const p of ps) mine.push(...take((c) => inPr(p, c)));
    return { kind: "ticket", ticket, commits: mine, prs: ps };
  });
  for (const pr of pulls.filter((p) => !usedPr.has(p))) yesterday.push({ kind: "pr", pr, commits: take((c) => inPr(pr, c)) });
  for (const unmerged of [false, true]) {
    const byRepo = new Map();
    for (const c of commits.filter((c) => !used.has(c.sha) && Boolean(c.branch) === unmerged).sort((a, b) => a.at - b.at)) {
      if (!byRepo.has(c.repo)) byRepo.set(c.repo, []);
      byRepo.get(c.repo).push(c);
    }
    for (const [repo, list] of byRepo) yesterday.push({ kind: "repo", repo, commits: list, unmerged });
  }
  const blockers = open.filter((t) => t.blocked);
  const ranked = rankToday(open.filter((t) => !t.blocked), now);
  const waiting = onePerPr(reviews).sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  return {
    span, yesterday, blockers,
    today: { items: ranked.slice(0, todayMax), more: Math.max(0, ranked.length - todayMax) },
    reviews: { items: waiting.slice(0, todayMax), more: Math.max(0, waiting.length - todayMax) },
  };
}

// A ticket's details for a line: "high · due tomorrow · in review".
export function ticketMeta(t, now) {
  const due = dueText(t.due, now);
  return [t.priority && t.priority !== "normal" ? t.priority : null, due?.text ?? null, t.progress || t.blocked ? t.status?.toLowerCase() : null]
    .filter(Boolean).join(" · ");
}

const short = (s, n = 90) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// The standup for pasting, three sections with one line per item. `format`:
//   "markdown": bold headings, "- " bullets, ids linked ([APP-12](…)), for Slack, GitHub, Notion…
//   "text": no markup at all, "• " bullets, each link after its line, for anywhere else
export function text(report, { now = Date.now(), notes = "", commitsShown = 3, format = "markdown" } = {}) {
  const r = report, md = format === "markdown", lines = [];
  const head = (name, extra) => `${md ? `**${name}**` : name}${extra ? ` (${extra})` : ""}`;
  const bullet = (s) => lines.push(`${md ? "-" : "•"} ${s}`);
  const ref = (id, url) => (md && url ? `[${id}](${url})` : id);
  // "APP-12: Fix login — high · due tomorrow", with its link (Markdown: on the id; text: at the end)
  const item = (id, url, title, meta) => `${ref(id, url)}: ${short(title)}${meta ? ` — ${meta}` : ""}${!md && url ? ` (${url})` : ""}`;
  const prMeta = (p) => `${VERB[p.action].toLowerCase()} ${ref(p.ref, p.url)}`;

  lines.push(head(r.span.name, r.span.label));
  if (!r.yesterday.length) bullet("Nothing recorded");
  for (const y of r.yesterday) {
    if (y.kind === "ticket") {
      const bits = [y.commits.length ? plural(y.commits.length, "commit") : null, ...(y.prs ?? []).map(prMeta)].filter(Boolean);
      bullet(`Closed ${item(y.ticket.ref, y.ticket.url, y.ticket.title, bits.join(", "))}`);
    } else if (y.kind === "pr") {
      bullet(`${VERB[y.pr.action]} ${item(y.pr.ref, y.pr.url, y.pr.title, y.commits.length ? plural(y.commits.length, "commit") : "")}`);
    } else {
      const shown = y.commits.slice(0, commitsShown).map((c) => short(c.subject, 70)).join("; ");
      const more = y.commits.length > commitsShown ? ` and ${y.commits.length - commitsShown} more` : "";
      bullet(`${md ? `**${y.repo}**` : y.repo}${y.unmerged ? " (not merged yet)" : ""}: ${shown}${more}`);
    }
  }
  lines.push("", head("Today"));
  const reviews = r.reviews ?? { items: [], more: 0 };
  if (!r.today.items.length && !reviews.items.length) bullet("Nothing assigned");
  for (const t of r.today.items) bullet(item(t.ref, t.url, t.title, ticketMeta(t, now)));
  if (r.today.more) bullet(`And ${r.today.more} more assigned`);
  for (const p of reviews.items) bullet(`Review ${item(p.ref, p.url, p.title, p.author ? `from ${p.author}` : "")}`);
  if (reviews.more) bullet(`And ${plural(reviews.more, "more review")} waiting`);
  lines.push("", head("Blockers"));
  const noted = notes.split("\n").map((l) => l.trim().replace(/^[-*•]\s*/, "")).filter(Boolean);
  if (!r.blockers.length && !noted.length) bullet("None");
  for (const t of r.blockers) bullet(item(t.ref, t.url, t.title, t.status || "blocked"));
  for (const n of noted) bullet(n);
  return lines.join("\n");
}
