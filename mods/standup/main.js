// Standup: your daily standup, written from where your work is. What you did on the last workday
// (tickets you closed, pull requests you merged, opened or reviewed, your commits that reached each
// repo's main branch), what's next today (your open tickets, most pressing first: due, in progress,
// priority; then reviews waiting on you), and what's in your way (blocked tickets, plus anything you
// type). COPY puts it on the clipboard as plain text or as Markdown.
//
// Sources, chosen in its settings (⚙): git repos (folders on this computer; any host), and the
// trackers you turn on: ClickUp, GitHub (the gh CLI's sign-in), GitLab, Linear and Jira (tokens kept
// in the system keychain). Settings are shared state "standup.settings"; today's typed blockers are
// "standup.notes".
//
// As a block in a layout, props {block: its id} let it read only while it shows; without a block (a
// pane, or `mod.open standup` as a window) it reads when it opens. It reads again on ⟳, and once a
// day while it shows. It only reads: it never changes a ticket or a repo, apart from fetching
// origin's main branch when "Fetch from origin first" is on.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, Scrollbar } from "gpui-base";
import { home, layout, pickFolder, props, setShared, shared, theme, window } from "herdr";
import { VERB, build, dateLabel, dayKey, dueText, text } from "./report.js";
import { browse, commits, copy, emails, findRepos, mainRefs, readToken, saveToken } from "./sources.js";
import { checkToken, clickup, github, gitlab, jira, linear } from "./trackers.js";

const SETTINGS = "standup.settings", NOTES = "standup.notes";
const ICON = (name) => `mods/standup/${name}.svg`;
const DEFAULTS = {
  repos: [],                  // [{path, branches}]: branches "development, main"; blank = origin's default
  emails: "",                 // more commit emails, besides git's user.email
  fetch: true,                // fetch origin's main branch before reading it
  unmerged: false,            // also count commits not merged yet
  mode: "workday",            // "workday": Monday looks back to Friday; "day": the previous day
  todayMax: 5,
  clickup: { on: false, team: "" },
  github: { on: false, filter: "", issues: true, prs: true },
  gitlab: { on: false, host: "", issues: true, mrs: true },
  linear: { on: false },
  jira: { on: false, site: "", email: "", jql: "" },
};
const TRACKERS = ["clickup", "github", "gitlab", "linear", "jira"];
const NAME = { clickup: "ClickUp", github: "GitHub", gitlab: "GitLab", linear: "Linear", jira: "Jira" };
const TOKENS = { clickup: "pk_…", gitlab: "glpat-…", linear: "lin_api_…", jira: "API token" }; // the ones with a keychain token
const COMMITS_SHOWN = 4;

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const tilde = (path) => { const h = home(); return path === h ? "~" : path.startsWith(`${h}/`) ? `~${path.slice(h.length)}` : path; };
const ago = (ms) => { const m = Math.floor((Date.now() - ms) / 60000); return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`; };
const age = (ms) => { const m = Math.floor((Date.now() - ms) / 60000); return m < 60 ? `${Math.max(1, m)}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`; };
const why = (e) => String(e?.message ?? e).split("\n")[0];
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

export default class Standup extends View {
  init(p, cx) {
    const given = p ?? props() ?? {};
    this.block = given.block ?? null;
    // In the panel dock (mods/nightdrive-dock) it shows when the dock says so, not by its own block.
    this.inDock = Boolean(given.dock);
    this.platform = window()?.platform ?? "macos";
    const s = this.settings();
    this.view = this.configured(s) ? "report" : "settings";
    this.report = null;
    this.errors = {};
    this.expanded = new Set();
    const nested = (kind, key, placeholder) => this.input(placeholder, s[kind][key], (v) => this.set({ [kind]: { ...this.settings()[kind], [key]: v } }));
    this.emailsInput = this.input("you@work.com, you@home.com", s.emails, (v) => this.set({ emails: v }));
    this.fields = {
      team: nested("clickup", "team", "your first workspace"),
      filter: nested("github", "filter", "org:acme or repo:acme/api (optional)"),
      host: nested("gitlab", "host", "https://gitlab.com"),
      site: nested("jira", "site", "acme.atlassian.net"),
      email: nested("jira", "email", "you@acme.com (blank for a Data Center token)"),
      jql: nested("jira", "jql", "project = APP (optional)"),
    };
    this.tokens = {};
    for (const [kind, placeholder] of Object.entries(TOKENS)) {
      const input = InputState.new({ placeholder });
      input.set_masked(true);
      input.on("submit", (_e, cx) => this.keepToken(cx, kind));
      this.tokens[kind] = { input, has: false, replacing: false, saving: false, note: null };
    }
    this.branchInputs = new Map();
    for (const r of s.repos) this.branchInput(r);
    this.notes = TextareaState.new({ placeholder: "Anything in your way? Each line goes in the copy.", rows: 2 });
    const n = shared(NOTES);
    if (n?.day === dayKey(Date.now())) this.notes.set_value(n.text ?? "");
    this.notes.on("blur", () => this.keepNotes());
    cx.spawn(async (cx) => {
      for (const kind of Object.keys(TOKENS)) this.tokens[kind].has = Boolean(await readToken(this.platform, kind));
      cx.notify();
    });
  }

  // A text field whose value goes into the settings when you leave it or press Enter.
  input(placeholder, value, save) {
    const state = InputState.new({ placeholder, value: value ?? "" });
    const keep = () => save(state.value().trim());
    state.on("blur", keep);
    state.on("submit", keep);
    return state;
  }

  branchInput(repo) {
    if (this.branchInputs.has(repo.path)) return this.branchInputs.get(repo.path);
    const state = this.input("auto", repo.branches, (v) => this.set({ repos: this.settings().repos.map((r) => (r.path === repo.path ? { ...r, branches: v } : r)) }));
    this.branchInputs.set(repo.path, state);
    return state;
  }

  settings() {
    const s = shared(SETTINGS) ?? {};
    const out = { ...DEFAULTS, ...s };
    for (const k of TRACKERS) out[k] = { ...DEFAULTS[k], ...s[k] };
    return out;
  }

  set(patch) { setShared(SETTINGS, { ...this.settings(), ...patch }); }

  configured(s) { return s.repos.length > 0 || TRACKERS.some((k) => s[k].on); }

  keepNotes() {
    const text = this.notes.value();
    const was = shared(NOTES);
    if (was?.text !== text || was?.day !== dayKey(Date.now())) setShared(NOTES, { day: dayKey(Date.now()), text });
  }

  // Shown: no block (a pane or a window), or nothing above its block hidden and each stack on its branch.
  visible() {
    if (this.inDock) return (shared("dock")?.shown ?? []).includes(this.block);
    const root = layout();
    if (!this.block || !find(root, this.block)) return true;
    const shown = (node) => {
      if (!node || node.hidden) return false;
      if (node.id === this.block) return true;
      const kids = node.children ?? [];
      if (node.type === "stack") return shown(kids.find((c) => c.id === node.active) ?? kids[0]);
      return kids.some(shown);
    };
    return shown(root);
  }

  // ---- reading ----
  // `drawing`: called from render, which mustn't ask for another render (it shows the change itself).
  generate(cx, drawing = false) {
    if (this.busy) return;
    const s = this.settings();
    this.busy = true;
    this.errors = {};
    this.progress = "Reading…";
    if (!drawing) cx.notify();
    cx.spawn(async (cx) => {
      const now = Date.now(), data = { open: [], closed: [], commits: [], prs: [], reviews: [] };
      const span = build({}, { now, mode: s.mode }).span, sources = [];
      const jobs = [], waiting = new Set();
      // Starting a source only notes it (this may still be inside render); finishing one redraws.
      const step = (name, done) => {
        done ? waiting.delete(name) : waiting.add(name);
        this.progress = waiting.size ? `Reading ${[...waiting].join(", ")}…` : "Writing…";
        if (done) cx.notify();
      };
      if (s.repos.length) jobs.push((async () => {
        step("git");
        try {
          const repos = await findRepos(s.repos);
          this.mine = await emails(repos, s.emails);
          sources.push(plural(repos.length, "repo"));
          if (!this.mine.length) this.errors.git = "git: no commit email (set user.email, or add one in settings)";
          await Promise.all(repos.map(async (repo) => {
            try {
              const refs = await mainRefs(repo, s.fetch);
              if (!refs.length) { this.errors[`git:${repo.name}`] = `${repo.name}: no ${repo.branches || "main"} branch found`; return; }
              data.commits.push(...await commits(repo, refs, this.mine, span, s.unmerged));
            } catch (e) { this.errors[`git:${repo.name}`] = `${repo.name}: ${why(e)}`; }
          }));
        } catch (e) { this.errors.git = `git: ${why(e)}`; }
        step("git", true);
      })());
      // A tracker: what it found joins the rest; what went wrong shows under the status line.
      const tracker = (kind, read) => jobs.push((async () => {
        step(NAME[kind]);
        try {
          const r = await read();
          for (const k of ["open", "closed", "prs", "reviews"]) data[k].push(...(r[k] ?? []));
          sources.push(NAME[kind]);
        } catch (e) { this.errors[kind] = `${NAME[kind]}: ${why(e)}`; }
        step(NAME[kind], true);
      })());
      const token = async (kind) => {
        const value = await readToken(this.platform, kind);
        this.tokens[kind].has = Boolean(value);
        if (!value) throw new Error("no token yet: add one in settings");
        return value;
      };
      if (s.clickup.on) tracker("clickup", async () => clickup(await token("clickup"), s.clickup, span));
      if (s.github.on) tracker("github", () => github(s.github, span));
      if (s.gitlab.on) tracker("gitlab", async () => gitlab(await token("gitlab"), s.gitlab, span));
      if (s.linear.on) tracker("linear", async () => linear(await token("linear"), s.linear, span));
      if (s.jira.on) tracker("jira", async () => jira(await token("jira"), s.jira, span));
      await Promise.all(jobs);
      this.report = { ...build(data, { now, mode: s.mode, todayMax: s.todayMax }), day: dayKey(now), at: Date.now(), sources };
      this.busy = false;
      this.progress = null;
      cx.notify();
    });
  }

  // `format`: "text" (no markup) or "markdown".
  doCopy(cx, format) {
    if (!this.report) return;
    this.keepNotes();
    const out = text(this.report, { notes: this.notes.value(), format });
    cx.spawn(async (cx) => {
      try { await copy(this.platform, out); this.copied = { format, at: Date.now() }; this.copyError = null; }
      catch (e) { this.copyError = why(e); }
      cx.notify();
      cx.timer.after(2000, (cx) => cx.notify());
    });
  }

  // Checks the typed token with its tracker (who it belongs to), then keeps it in the keychain.
  keepToken(cx, kind) {
    const k = this.tokens[kind], token = k.input.value().trim();
    if (!token || k.saving) return;
    k.saving = true;
    k.note = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await checkToken(kind, token, this.settings()).catch((e) => { throw new Error(`${NAME[kind]} turned that token down (${why(e).replace(/^\w+ said /, "")})`); });
        await saveToken(this.platform, kind, token);
        k.input.set_value("");
        k.has = true;
        k.replacing = false;
      } catch (e) { k.note = why(e); }
      k.saving = false;
      cx.notify();
    });
  }

  addFolder(cx) {
    cx.spawn(async (cx) => {
      const path = await pickFolder({ prompt: "A repo, or a folder of repos" });
      if (!path) return;
      const repos = this.settings().repos;
      if (repos.some((r) => r.path === path)) return;
      const repo = { path, branches: "" };
      this.branchInput(repo);
      this.set({ repos: [...repos, repo] });
      cx.notify();
    });
  }

  done(cx) {
    this.view = "report";
    this.generate(cx);
  }

  // ---- pieces ----
  iconButton(t, id, icon, tip, action, label = null) {
    return h_flex().id(id).h(26).px(label ? 8 : 6).gap(5).flex_none().items_center().cursor_pointer()
      .border_1().border_color(t.border).text_size(10.5).font_bold().text_color(t.muted)
      .hover((s) => s.bg(t.hover).border_color(t.accent).text_color(t.accent))
      .tooltip(tip).on_click((_e, cx) => { cx.stop_propagation(); action(cx); })
      .child(svg(ICON(icon)).size(13))
      .when(Boolean(label), (e) => e.child(label));
  }

  // Copy, in two halves: TEXT (no markup) and MD (Markdown). The one just copied says so.
  copyButtons(t) {
    const just = this.copied && Date.now() - this.copied.at < 2000 ? this.copied.format : null;
    const half = (format, label, tip) => h_flex().id(`su-copy-${format}`).h_full().px(8).items_center().cursor_pointer()
      .text_color(just === format ? t.ansi2 : t.muted).hover((s) => s.bg(t.hover).text_color(t.accent))
      .tooltip(tip).on_click((_e, cx) => { cx.stop_propagation(); this.doCopy(cx, format); })
      .child(just === format ? "COPIED" : label);
    return h_flex().h(26).flex_none().items_center().border_1().border_color(t.border).text_size(10.5).font_bold()
      .child(h_flex().h_full().pl(7).pr(1).items_center().text_color(t.dim).child(svg(ICON("copy")).size(13)))
      .child(half("text", "TEXT", "Copy as plain text: no markup, each link after its line"))
      .child(div().w(1).h(14).bg(t.border))
      .child(half("markdown", "MD", "Copy as Markdown: bold headings and linked ids, for Slack, GitHub or Notion"));
  }

  section(t, label, extra) {
    return h_flex().gap(8).items_center().pt(6).pb(4).border_b(1).border_color(t.border)
      .child(div().text_size(10.5).font_bold().text_color(t.accent).child(label))
      .when(Boolean(extra), (e) => e.child(div().text_size(10.5).text_color(t.dim).child(extra)));
  }

  // A ticket or pull request: its id and title, and a line of what matters about it. Click: open it.
  ticketRow(t, x, id, lead, meta) {
    return v_flex().id(id).py(6).px(4).gap(2).cursor_pointer().hover((s) => s.bg(t.hover))
      .tooltip(x.url ? `Open in ${NAME[x.source] ?? "the browser"}` : x.ref)
      .on_click(() => browse(this.platform, x.url))
      .child(h_flex().gap(8).items_center().min_w(0)
        .when(Boolean(lead), (e) => e.child(lead))
        .child(div().flex_none().text_size(11.5).font_bold().text_color(t.accent).child(x.ref))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(x.title)))
      .when(Boolean(meta), (e) => e.child(meta));
  }

  todayMeta(t, x, now) {
    const due = dueText(x.due, now);
    const bits = [];
    if (x.priority && x.priority !== "normal") bits.push([x.priority.toUpperCase(), x.priority === "urgent" ? t.blocked : x.priority === "high" ? t.ansi3 : t.dim]);
    if (due) bits.push([due.text, due.late ? t.blocked : due.soon ? t.ansi3 : t.muted]);
    if (x.progress || x.blocked) bits.push([x.status.toLowerCase(), x.blocked ? t.blocked : t.ansi4]);
    if (!bits.length) return null;
    return h_flex().gap(10).pl(2).text_size(10.5).children(bits.map(([s, c]) => div().font_bold().text_color(c).child(s)));
  }

  // A pull request's mark, in the color of what happened to it.
  prIcon(t, action) {
    const tone = { merged: t.ansi5, opened: t.ansi2, approved: t.ansi2, changes: t.ansi3, reviewed: t.ansi4, review: t.ansi3 }[action] ?? t.muted;
    return svg(ICON("pr")).size(13).flex_none().text_color(tone);
  }

  commitLine(t, c) {
    return h_flex().id(`sc-${c.sha}`).gap(8).pl(14).py(2).cursor_pointer().hover((s) => s.bg(t.hover))
      .tooltip(c.branch ? `On ${c.branch}` : c.sha.slice(0, 7)).on_click(() => browse(this.platform, c.url))
      .child(div().flex_none().text_color(t.dim).child("·"))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(c.subject));
  }

  yesterdayRow(t, y, i) {
    const dim = (s) => div().pl(2).text_size(10.5).text_color(t.dim).child(s);
    if (y.kind === "ticket") {
      const bits = ["closed", y.commits.length ? plural(y.commits.length, "commit") : null, ...(y.prs ?? []).map((p) => `${VERB[p.action].toLowerCase()} ${p.ref}`)];
      return this.ticketRow(t, y.ticket, `sy-${i}`, div().flex_none().text_color(t.ansi2).font_bold().child("✓"), dim(bits.filter(Boolean).join(" · ")));
    }
    if (y.kind === "pr") {
      const n = y.commits.length;
      return this.ticketRow(t, y.pr, `sy-${i}`, this.prIcon(t, y.pr.action),
        dim(`${VERB[y.pr.action].toLowerCase()}${y.pr.author && !["merged", "opened"].includes(y.pr.action) ? ` · ${y.pr.author}'s` : ""}${n ? ` · ${plural(n, "commit")}` : ""}`));
    }
    const key = `${y.repo}:${y.unmerged}`, open = this.expanded.has(key);
    const shown = open ? y.commits : y.commits.slice(0, COMMITS_SHOWN), more = y.commits.length - shown.length;
    return v_flex().py(4).gap(1)
      .child(h_flex().gap(8).items_center().px(4)
        .child(div().text_size(12.5).font_bold().text_color(t.foreground).child(y.repo))
        .child(div().text_size(10.5).text_color(y.unmerged ? t.ansi3 : t.dim).child(`${plural(y.commits.length, "commit")}${y.unmerged ? " · not merged yet" : ""}`)))
      .children(shown.map((c) => this.commitLine(t, c)))
      .when(more > 0 || open, (e) => e.child(div().id(`sm-${key}`).pl(14).py(2).text_size(11).text_color(t.accent).cursor_pointer()
        .on_click((_e, cx) => { open ? this.expanded.delete(key) : this.expanded.add(key); cx.notify(); })
        .child(open ? "Show fewer" : `${more} more`)));
  }

  reviewRow(t, p, i) {
    return this.ticketRow(t, p, `sr-${i}`, this.prIcon(t, "review"),
      div().pl(2).text_size(10.5).font_bold().text_color(t.ansi3).child(`review requested${p.author ? ` · from ${p.author}` : ""}${p.at ? ` · opened ${age(p.at)} ago` : ""}`));
  }

  scroller(id, content) {
    return div().flex_1().min_h(0).relative()
      .child(v_flex().id(id).absolute().inset_0().overflow_y_scroll().child(content))
      .child(Scrollbar.vertical(id).absolute().inset_0());
  }

  reportView(t) {
    const r = this.report, now = Date.now(), errs = Object.values(this.errors);
    const header = h_flex().h(42).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
      .child(svg(ICON("standup")).size(15).text_color(t.accent))
      .child(div().text_size(13).font_bold().text_color(t.foreground).child("Standup"))
      .child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(dateLabel(now)))
      .child(div().flex_1())
      .child(this.copyButtons(t))
      .child(this.iconButton(t, "su-refresh", "refresh", "Read again", (cx) => this.generate(cx)))
      .child(this.iconButton(t, "su-settings", "settings", "Settings", (cx) => { this.view = "settings"; cx.notify(); }));
    const status = this.busy ? this.progress ?? "Reading…" : r ? `From ${r.sources.join(", ") || "nothing"} · ${ago(r.at)}` : "";
    let body = v_flex().p(12).gap(6)
      .child(div().text_size(11).text_color(t.dim).child(status))
      .when(errs.length > 0, (e) => e.children(errs.map((x) => div().text_size(11).text_color(t.blocked).child(x))))
      .when(Boolean(this.copyError), (e) => e.child(div().text_size(11).text_color(t.blocked).child(`Copy: ${this.copyError}`)));
    if (r) {
      const reviews = r.reviews ?? { items: [], more: 0 };
      body = body.child(this.section(t, r.span.name.toUpperCase(), r.span.label))
        .when(!r.yesterday.length, (e) => e.child(div().px(4).py(6).text_size(12).text_color(t.dim).child("Nothing closed, reviewed or committed.")))
        .children(r.yesterday.map((y, i) => this.yesterdayRow(t, y, i)))
        .child(this.section(t, "TODAY", r.today.more ? `top ${r.today.items.length} of ${r.today.items.length + r.today.more}` : null))
        .when(!r.today.items.length && !reviews.items.length, (e) => e.child(div().px(4).py(6).text_size(12).text_color(t.dim).child("Nothing assigned to you.")))
        .children(r.today.items.map((x, i) => this.ticketRow(t, x, `st-${i}`, null, this.todayMeta(t, x, now))))
        .children(reviews.items.map((p, i) => this.reviewRow(t, p, i)))
        .when(reviews.more > 0, (e) => e.child(div().px(4).py(2).text_size(11).text_color(t.dim).child(`and ${plural(reviews.more, "more review")} waiting`)))
        .child(this.section(t, "BLOCKERS"))
        .when(!r.blockers.length, (e) => e.child(div().px(4).py(4).text_size(12).text_color(t.dim).child("No blocked tickets.")))
        .children(r.blockers.map((x, i) => this.ticketRow(t, x, `sb-${i}`, null, this.todayMeta(t, x, now))))
        .child(div().id("su-notes").mt(4).p(8).border_1().border_color(t.input).bg(t.background)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Textarea.new(this.notes).w_full().text_size(12.5).text_color(t.foreground)));
    }
    return v_flex().size_full().min_h(0).child(header).child(this.scroller("su-report", body));
  }

  // ---- settings ----
  toggle(t, id, on, label, action) {
    return h_flex().id(id).gap(8).items_center().cursor_pointer().on_click((_e, cx) => action(cx))
      .child(div().size(14).flex_none().border_1().border_color(on ? t.accent : t.input).when(on, (e) => e.bg(t.accent)))
      .child(div().flex_1().min_w(0).text_size(12.5).text_color(on ? t.foreground : t.muted).child(label));
  }

  choice(t, id, on, label, action) {
    return h_flex().id(id).h(26).px(10).flex_none().items_center().cursor_pointer().text_size(11.5)
      .border_1().border_color(on ? t.accent : t.border).text_color(on ? t.accent : t.muted).when(on, (e) => e.bg(t.selected))
      .hover((s) => s.border_color(t.accent)).on_click((_e, cx) => action(cx)).child(label);
  }

  field(t, id, state) {
    return div().id(id).h(30).px(8).flex().items_center().border_1().border_color(t.input).bg(t.background)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(Input.new(state).w_full().text_size(12).text_color(t.foreground));
  }

  label(t, s) { return div().text_size(12).text_color(t.muted).child(s); }

  group(t, title, note) {
    return v_flex().gap(8).pt(4)
      .child(div().text_size(11).font_bold().text_color(t.accent).child(title.toUpperCase()))
      .when(Boolean(note), (e) => e.child(div().text_size(11.5).text_color(t.dim).child(note)));
  }

  // A tracker's settings: what it reads, "Use …", and once on, its own fields.
  tracker(t, kind, note, fields) {
    const s = this.settings();
    return this.group(t, NAME[kind], note)
      .child(this.toggle(t, `su-${kind}`, s[kind].on, `Use ${NAME[kind]}`, () => this.set({ [kind]: { ...s[kind], on: !s[kind].on } })))
      .when(s[kind].on, (e) => e.children(fields(s[kind], (key, label) =>
        this.toggle(t, `su-${kind}-${key}`, s[kind][key], label, () => this.set({ [kind]: { ...s[kind], [key]: !s[kind][key] } })))));
  }

  // The token: kept (with Replace), or a masked field and Save, which checks it first.
  tokenRow(t, kind) {
    const k = this.tokens[kind];
    return v_flex().gap(6)
      .child(k.has && !k.replacing
        ? h_flex().gap(8).items_center()
          .child(div().text_size(12).text_color(t.ansi2).child(`Token kept in the ${this.platform === "macos" ? "macOS Keychain" : "keychain"}`))
          .child(this.choice(t, `su-replace-${kind}`, false, "Replace", (cx) => { k.replacing = true; cx.notify(); }))
        : h_flex().gap(8).items_center()
          .child(div().flex_1().child(this.field(t, `su-token-${kind}`, k.input)))
          .child(this.choice(t, `su-keep-${kind}`, false, k.saving ? "Checking…" : "Save", (cx) => this.keepToken(cx, kind))))
      .when(Boolean(k.note), (x) => x.child(div().text_size(11).text_color(t.blocked).child(k.note)));
  }

  settingsView(t) {
    const s = this.settings();
    const header = h_flex().h(42).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
      .child(svg(ICON("settings")).size(14).text_color(t.accent))
      .child(div().text_size(13).font_bold().text_color(t.foreground).child("Standup settings"))
      .child(div().flex_1())
      .child(h_flex().id("su-done").h(26).px(12).flex_none().items_center().cursor_pointer().text_size(10.5).font_bold()
        .bg(this.configured(s) ? t.solid : t.raised).text_color(this.configured(s) ? t.solid_foreground : t.dim)
        .tooltip(this.configured(s) ? "Write the standup" : "Add a repo or turn on a tracker first")
        .on_click((_e, cx) => { if (this.configured(this.settings())) this.done(cx); }).child("DONE"));

    const repos = this.group(t, "Repositories", "Your commits that reached each repo's main branch count. A folder of repos counts each repo in it. Branches: blank reads origin's default branch; or name them, like \"development, main\".")
      .children(s.repos.map((r, i) => h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(tilde(r.path)))
        .child(div().w(150).flex_none().child(this.field(t, `su-br-${i}`, this.branchInput(r))))
        .child(div().id(`su-rm-${i}`).p(4).flex_none().cursor_pointer().text_color(t.dim).hover((x) => x.text_color(t.blocked))
          .tooltip("Remove").on_click((_e, cx) => { this.set({ repos: this.settings().repos.filter((x) => x.path !== r.path) }); cx.notify(); })
          .child("×"))))
      .child(h_flex().child(this.choice(t, "su-add", false, "+ Add folder", (cx) => this.addFolder(cx))));

    const you = this.group(t, "Your commit emails", `git's user.email in each repo counts${this.mine?.length ? ` (${this.mine.join(", ")})` : ""}. Add any others you commit with:`)
      .child(this.field(t, "su-emails", this.emailsInput))
      .child(this.toggle(t, "su-fetch", s.fetch, "Fetch from origin first, so merged work is up to date", () => this.set({ fetch: !s.fetch })))
      .child(this.toggle(t, "su-unmerged", s.unmerged, "Also count commits not merged yet, on any branch", () => this.set({ unmerged: !s.unmerged })));

    const report = this.group(t, "The report")
      .child(this.label(t, "Yesterday means"))
      .child(h_flex().gap(6).flex_wrap()
        .child(this.choice(t, "su-workday", s.mode === "workday", "The previous workday (Monday: Friday)", () => this.set({ mode: "workday" })))
        .child(this.choice(t, "su-day", s.mode === "day", "The previous day", () => this.set({ mode: "day" }))))
      .child(this.label(t, "Today lists up to"))
      .child(h_flex().gap(6).children([3, 5, 8, 12].map((n) => this.choice(t, `su-max-${n}`, s.todayMax === n, String(n), () => this.set({ todayMax: n })))));

    const f = this.fields;
    const trackers = [
      this.tracker(t, "clickup", "Your open tasks, and the ones you finished, through a personal API token (ClickUp → avatar → Settings → Apps).",
        () => [this.tokenRow(t, "clickup"), this.label(t, "Workspace (its name or id)"), this.field(t, "su-team", f.team)]),
      this.tracker(t, "github", "Through the gh CLI's sign-in. Priority comes from labels (P1, priority: high); a due date from the milestone.",
        (_x, opt) => [opt("issues", "Issues assigned to you"), opt("prs", "Pull requests: yours, ones you reviewed, and reviews waiting on you"),
          this.label(t, "Only (a search filter)"), this.field(t, "su-filter", f.filter)]),
      this.tracker(t, "gitlab", "Through a personal access token with the read_api scope (GitLab → avatar → Preferences → Access tokens). Priority and progress come from labels.",
        (_x, opt) => [this.label(t, "Server (blank: gitlab.com)"), this.field(t, "su-host", f.host), this.tokenRow(t, "gitlab"),
          opt("issues", "Issues assigned to you"), opt("mrs", "Merge requests: yours, ones you approved or commented on, and reviews waiting on you")]),
      this.tracker(t, "linear", "Your open issues, and the ones you completed, through a personal API key (Linear → Settings → Security & access). Blocked: its state, a label, or an unfinished issue that blocks it.",
        () => [this.tokenRow(t, "linear")]),
      this.tracker(t, "jira", "Your open issues, and the ones that reached Done. Jira Cloud: your site, your email and an API token (id.atlassian.com → Security → API tokens). Data Center: its address and a personal access token, with no email.",
        () => [this.label(t, "Site"), this.field(t, "su-site", f.site), this.label(t, "Email"), this.field(t, "su-email", f.email),
          this.tokenRow(t, "jira"), this.label(t, "Only (a JQL condition)"), this.field(t, "su-jql", f.jql)]),
    ];

    const body = v_flex().p(14).gap(16).child(repos).child(you).child(report).children(trackers);
    return v_flex().size_full().min_h(0).child(header).child(this.scroller("su-settings", body));
  }

  render(cx) {
    const t = theme();
    const s = this.settings();
    // Reads when it first shows, and again on a new day while it shows.
    if (this.view === "report" && this.configured(s) && !this.busy && this.visible() && this.report?.day !== dayKey(Date.now())
      && this.tried !== dayKey(Date.now())) {
      this.tried = dayKey(Date.now());
      this.generate(cx, true);
    }
    return v_flex().id(this.block ?? "standup").size_full().min_h(0).overflow_hidden().bg(t.background)
      .border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(this.view === "settings" ? this.settingsView(t) : this.reportView(t));
  }
}
