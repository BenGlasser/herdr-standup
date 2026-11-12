// Where the standup's commits come from (your git repos: what reached each one's main branch), and
// this computer's parts: the keychain the trackers' tokens live in, the clipboard, the browser.
// The trackers themselves are in trackers.js.
import { exec } from "herdr";

const SEP = "\x1f", END = "\x1e";
const base = (path) => path.replace(/\/+$/, "").split("/").pop();

// ---- git ------------------------------------------------------------------------------------------
const git = (cwd, args, timeout = 20000) => exec("git", ["--no-optional-locks", ...args], { cwd, timeout });

async function repoAt(path) {
  const r = await git(path, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"]).catch(() => null);
  if (!r || r.code !== 0) return null;
  const [top, common] = r.stdout.trim().split("\n");
  return top && common ? { top, common } : null;
}

// The repos the settings name: each folder that is a repo, else the repos one level inside it.
// Worktrees of one repo count once (by their shared .git), read through the main checkout.
export async function findRepos(entries) {
  const out = new Map();
  for (const e of entries) {
    const found = [];
    const self = await repoAt(e.path);
    if (self) found.push(self);
    else {
      const r = await exec("find", [e.path, "-mindepth", "2", "-maxdepth", "2", "-name", ".git"], { timeout: 20000 }).catch(() => null);
      for (const line of (r?.stdout ?? "").split("\n").filter(Boolean)) {
        const repo = await repoAt(line.slice(0, -"/.git".length));
        if (repo) found.push(repo);
      }
    }
    for (const f of found) {
      const main = f.common === `${f.top}/.git`, prev = out.get(f.common);
      if (prev && (prev.main || !main)) continue;
      out.set(f.common, { ...f, main, branches: e.branches ?? "", name: base(f.common.replace(/\/\.git$/, "")).replace(/\.git$/, "") });
    }
  }
  return [...out.values()];
}

// Your commit email(s): git's user.email in each repo (so per-repo ones count), plus the extra ones.
export async function emails(repos, extra) {
  const set = new Set(String(extra ?? "").split(/[,\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean));
  for (const r of repos) {
    const e = await git(r.top, ["config", "user.email"]).catch(() => null);
    if (e?.code === 0 && e.stdout.trim()) set.add(e.stdout.trim().toLowerCase());
  }
  return [...set];
}

const exists = async (top, ref) => (await git(top, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).catch(() => null))?.code === 0;

// The branches a repo's work lands on: the ones named in its settings ("development, main"), each
// as origin's copy when there is one; else origin's default branch (origin/HEAD), else main or master.
// With `fetch`, origin's copies are brought up to date first.
export async function mainRefs(repo, fetch) {
  const named = repo.branches.split(",").map((s) => s.trim()).filter(Boolean);
  const get = (b) => git(repo.top, ["fetch", "--quiet", "origin", b], 60000).catch(() => null);
  const refs = [];
  if (named.length) {
    if (fetch) await Promise.all(named.map(get));
    for (const b of named) {
      if (await exists(repo.top, `origin/${b}`)) refs.push(`origin/${b}`);
      else if (await exists(repo.top, b)) refs.push(b);
    }
    return refs;
  }
  const head = await git(repo.top, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).catch(() => null);
  for (const ref of [head?.code === 0 ? head.stdout.trim() : null, "origin/main", "origin/master", "main", "master"].filter(Boolean)) {
    if (!(await exists(repo.top, ref))) continue;
    if (fetch && ref.startsWith("origin/")) await get(ref.slice("origin/".length));
    return [ref];
  }
  return [];
}

// A link to a commit on GitHub or GitLab, from the repo's origin URL; null for other hosts.
async function commitLink(repo) {
  const r = await git(repo.top, ["remote", "get-url", "origin"]).catch(() => null);
  const m = /^(?:https?:\/\/|git@|ssh:\/\/git@)([^/:]+)[/:](.+?)(?:\.git)?\/?$/.exec(r?.code === 0 ? r.stdout.trim() : "");
  if (!m || !/github|gitlab/i.test(m[1])) return null;
  return (sha) => `https://${m[1]}/${m[2]}${/gitlab/i.test(m[1]) ? "/-" : ""}/commit/${sha}`;
}

const parse = (out, fields) => out.split(END).map((rec) => rec.replace(/^\n/, "")).filter(Boolean)
  .map((rec) => Object.fromEntries(rec.split(SEP).map((v, i) => [fields[i], v ?? ""])));

// Your work that reached `refs` in the span: each commit on their first-parent line that you wrote,
// and each merge that brought in a commit of yours (a pull request merged with a merge commit; it
// reads as the pull request's title). With `unmerged`, also your commits in the span on any other
// branch, local or origin's, that haven't reached them yet.
export async function commits(repo, refs, mine, span, unmerged) {
  const me = new Set(mine);
  const since = `--since=${new Date(span.from).toISOString()}`, until = `--until=${new Date(span.to).toISOString()}`;
  const link = await commitLink(repo), out = [], seen = new Set();
  for (const ref of refs) {
    const r = await git(repo.top, ["log", ref, "--first-parent", since, until, `--format=%H${SEP}%P${SEP}%ae${SEP}%ct${SEP}%s${SEP}%b${END}`]);
    if (r.code !== 0) continue;
    for (const c of parse(r.stdout, ["sha", "parents", "email", "at", "subject", "body"])) {
      if (seen.has(c.sha)) continue;
      seen.add(c.sha);
      const parents = c.parents.split(" ").filter(Boolean);
      let ours = me.has(c.email.toLowerCase()), subject = c.subject;
      if (parents.length > 1) {
        const inside = await git(repo.top, ["log", `${parents[0]}..${c.sha}`, "--format=%ae"]);
        ours = inside.stdout.split("\n").some((e) => me.has(e.trim().toLowerCase()));
        // GitHub: "Merge pull request #12 from …", the title in the body; GitLab: "Merge branch 'x'
        // into 'main'", the title first in the body and "See merge request group/api!12" last.
        const title = c.body.split("\n").map((l) => l.trim()).find(Boolean);
        const gh = /^Merge pull request (#\d+)/.exec(c.subject), gl = /See merge request \S*?(!\d+)/.exec(c.body);
        if (gh) subject = `${title ?? c.subject} (${gh[1]})`;
        else if (gl && /^Merge branch /.test(c.subject) && title && !title.startsWith("See merge request")) subject = `${title} (${gl[1]})`;
      }
      if (ours) out.push({ repo: repo.name, sha: c.sha, subject, at: Number(c.at) * 1000, url: link?.(c.sha) ?? null, branch: null });
    }
  }
  if (unmerged && refs.length && mine.length) {
    const r = await git(repo.top, ["log", "--branches", "--remotes", "--no-merges", since, until, ...mine.map((e) => `--author=${e}`),
      "--source", `--format=%H${SEP}%S${SEP}%ct${SEP}%s${END}`, "--not", ...refs]);
    for (const c of r.code === 0 ? parse(r.stdout, ["sha", "source", "at", "subject"]) : []) {
      if (seen.has(c.sha)) continue;
      seen.add(c.sha);
      const branch = c.source.replace(/^refs\/(heads|remotes\/[^/]+)\//, "");
      out.push({ repo: repo.name, sha: c.sha, subject: c.subject, at: Number(c.at) * 1000, url: link?.(c.sha) ?? null, branch });
    }
  }
  return out;
}

// ---- this computer --------------------------------------------------------------------------------
// The trackers' tokens live in the system's keychain, one item per tracker (account "clickup",
// "gitlab", "linear", "jira"): macOS Keychain (security), or the Secret Service on Linux (secret-tool).
const SERVICE = "herdr-standup";
const LABEL = { clickup: "ClickUp", gitlab: "GitLab", linear: "Linear", jira: "Jira" };

export async function readToken(platform, account) {
  const r = platform === "macos" ? await exec("security", ["find-generic-password", "-s", SERVICE, "-a", account, "-w"], { timeout: 8000 }).catch(() => null)
    : platform === "linux" ? await exec("secret-tool", ["lookup", "service", SERVICE, "account", account], { timeout: 8000 }).catch(() => null) : null;
  return r?.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

export async function saveToken(platform, account, token) {
  const label = `Herdr standup: ${LABEL[account] ?? account} token`;
  const r = platform === "macos"
    ? await exec("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", account, "-l", label, "-w", token], { timeout: 8000 })
    : platform === "linux"
      ? await exec("sh", ["-c", `printf %s "$1" | secret-tool store --label="$2" service ${SERVICE} account "$3"`, "sh", token, label, account], { timeout: 8000 })
      : { code: 1, stderr: "keeping the token isn't supported on this system yet" };
  if (r.code !== 0) throw new Error((r.stderr || "couldn't keep the token").trim());
}

export async function copy(platform, textToCopy) {
  const cmd = platform === "macos" ? `printf %s "$1" | pbcopy`
    : platform === "windows" ? null
    : `if command -v wl-copy >/dev/null; then printf %s "$1" | wl-copy; else printf %s "$1" | xclip -selection clipboard; fi`;
  const r = cmd ? await exec("sh", ["-c", cmd, "sh", textToCopy], { timeout: 8000 })
    : await exec("powershell", ["-NoProfile", "-Command", "Set-Clipboard -Value $args[0]", textToCopy], { timeout: 8000 });
  if (r.code !== 0) throw new Error((r.stderr || "couldn't copy").trim());
}

export function browse(platform, url) {
  if (!url) return;
  const [cmd, args] = platform === "macos" ? ["open", [url]] : platform === "windows" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  exec(cmd, args).catch(() => {});
}
