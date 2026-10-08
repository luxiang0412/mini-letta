/** The Palace single-page UI (vanilla JS, no build step). */
export const PALACE_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Memory Palace</title>
<style>
:root {
  --bg: #f7f6f3; --panel: #ffffff; --ink: #1f2328; --muted: #6b7280; --line: #e5e2db;
  --accent: #5b4bdb; --accent-soft: #ece9fd; --core: #0f766e; --core-soft: #dff5f1;
  --deferred: #9a6700; --deferred-soft: #fdf3d8; --skill: #7c3aed; --warn: #b42318; --warn-soft: #fde8e7;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #15161a; --panel: #1d1f24; --ink: #e7e7ea; --muted: #9aa0aa; --line: #2c2f36;
    --accent: #a497ff; --accent-soft: #2a2550; --core: #5fd0c0; --core-soft: #12322e;
    --deferred: #e2b64b; --deferred-soft: #352a10; --skill: #c4a5ff; --warn: #ff8a80; --warn-soft: #3a1c1a;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.5 -apple-system, "PingFang SC", "Noto Sans SC", system-ui, sans-serif; }
header { display: flex; gap: 12px; align-items: center; padding: 12px 20px; border-bottom: 1px solid var(--line); background: var(--panel); flex-wrap: wrap; }
header h1 { font-size: 16px; margin: 0; letter-spacing: .2px; }
header .sub { color: var(--muted); font-size: 12px; }
select { font: inherit; padding: 4px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--ink); }
main { display: grid; grid-template-columns: 330px minmax(0, 1fr) 380px; gap: 16px; padding: 16px 20px; }
section { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px; min-width: 0; }
h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .6px; color: var(--muted); margin: 0 0 10px; }
.budget { height: 6px; background: var(--line); border-radius: 3px; overflow: hidden; margin: 4px 0 4px; }
.budget > div { height: 100%; background: var(--core); }
.small { font-size: 12px; color: var(--muted); }
ul.tree { list-style: none; margin: 10px 0 0; padding: 0; }
ul.tree li { display: flex; justify-content: space-between; gap: 8px; padding: 5px 8px; border-radius: 6px; cursor: pointer; }
ul.tree li:hover, ul.tree li.on { background: var(--accent-soft); }
.path { font-family: var(--mono); font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tag { font-size: 11px; border-radius: 4px; padding: 0 6px; white-space: nowrap; }
.t-core { color: var(--core); background: var(--core-soft); }
.t-index { color: var(--accent); background: var(--accent-soft); }
.t-deferred { color: var(--deferred); background: var(--deferred-soft); }
.t-skill { color: var(--skill); background: var(--accent-soft); }
.t-unindexed, .t-dirty { color: var(--warn); background: var(--warn-soft); }
pre { font-family: var(--mono); font-size: 12.5px; white-space: pre-wrap; word-break: break-word; margin: 0; }
.tabs { display: flex; gap: 4px; margin-bottom: 10px; }
.tabs button { font: inherit; font-size: 12px; border: 1px solid var(--line); background: var(--bg); color: var(--ink); padding: 3px 10px; border-radius: 999px; cursor: pointer; }
.tabs button.on { background: var(--accent); border-color: var(--accent); color: #fff; }
.commit { padding: 8px 0; border-bottom: 1px solid var(--line); cursor: pointer; }
.commit:last-child { border-bottom: 0; }
.commit .subj { font-weight: 500; }
.diff-add { color: var(--core); } .diff-del { color: var(--warn); }
.conv { padding: 8px 0; border-bottom: 1px solid var(--line); }
.kv { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; font-size: 12.5px; }
.kv span:nth-child(odd) { color: var(--muted); }
.empty { color: var(--muted); font-style: italic; }
@media (max-width: 1000px) { main { grid-template-columns: 1fr; padding: 12px 16px; } }
</style>
</head>
<body>
<header>
  <h1>🏛️ Memory Palace</h1><span class="sub">mini-letta · 只读视图 · 内容来自已提交的 HEAD</span>
  <span style="flex:1"></span>
  <label class="small">Agent <select id="agent"></select></label>
</header>
<main>
  <section>
    <h2>记忆文件</h2>
    <div class="small" id="budget-label"></div>
    <div class="budget"><div id="budget-bar" style="width:0"></div></div>
    <div id="dirty"></div>
    <ul class="tree" id="tree"></ul>
  </section>
  <section>
    <h2 id="viewer-title">选择一个文件或提交</h2>
    <pre id="viewer" class="empty">← 左侧点开文件；右侧点开提交看 diff</pre>
  </section>
  <section>
    <div class="tabs">
      <button data-tab="history" class="on">历史</button>
      <button data-tab="conversations">对话</button>
      <button data-tab="prompt">系统提示</button>
    </div>
    <div id="side"></div>
  </section>
</main>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const api = (path) => fetch(path).then((r) => r.json());
const KIND = { core: "core · 常驻", index: "索引", deferred: "deferred", skill: "skill", unindexed: "未索引", other: "其他" };
let agent = null, tab = "history";

async function loadAgents() {
  const agents = await api("/api/agents");
  $("agent").innerHTML = agents.map((a) => '<option value="' + esc(a.id) + '">' + esc(a.id) + " · " + a.commits + " commits</option>").join("");
  const fromHash = decodeURIComponent(location.hash.slice(1));
  agent = agents.some((a) => a.id === fromHash) ? fromHash : agents[0] && agents[0].id;
  if (agent) { $("agent").value = agent; await refresh(); }
}

async function refresh() {
  location.hash = encodeURIComponent(agent);
  const tree = await api("/api/agents/" + agent + "/tree");
  const pct = Math.min(100, (100 * tree.coreCharacters) / tree.coreBudget);
  $("budget-label").textContent = "常驻（core）记忆 " + tree.coreCharacters.toLocaleString() + " / " + tree.coreBudget.toLocaleString() + " 字符";
  $("budget-bar").style.width = pct.toFixed(1) + "%";
  $("dirty").innerHTML = tree.uncommitted.length
    ? '<p class="small"><span class="tag t-dirty">未提交 ' + tree.uncommitted.length + "</span> 这些改动不会进入系统提示</p>" : "";
  const order = { index: 0, core: 1, deferred: 2, skill: 3, unindexed: 4, other: 5 };
  tree.files.sort((a, b) => order[a.kind] - order[b.kind] || a.path.localeCompare(b.path));
  $("tree").innerHTML = tree.files.map((f) =>
    '<li data-path="' + esc(f.path) + '" title="' + esc(f.description) + '"><span class="path">' + esc(f.path) +
    '</span><span class="tag t-' + f.kind + '">' + KIND[f.kind] + " · " + f.characters + "</span></li>").join("");
  for (const li of $("tree").querySelectorAll("li")) li.onclick = () => openFile(li.dataset.path, li);
  await renderSide();
}

async function openFile(path, li) {
  for (const x of $("tree").querySelectorAll("li")) x.classList.toggle("on", x === li);
  const res = await api("/api/agents/" + agent + "/file?path=" + encodeURIComponent(path));
  $("viewer-title").textContent = path + " @ HEAD";
  $("viewer").className = "";
  $("viewer").textContent = res.content;
}

function colorDiff(text) {
  return esc(text).split("\\n").map((l) =>
    l.startsWith("+") && !l.startsWith("+++") ? '<span class="diff-add">' + l + "</span>" :
    l.startsWith("-") && !l.startsWith("---") ? '<span class="diff-del">' + l + "</span>" : l).join("\\n");
}

async function openCommit(sha) {
  const res = await api("/api/agents/" + agent + "/commit?sha=" + sha);
  $("viewer-title").textContent = "commit " + sha.slice(0, 7);
  $("viewer").className = "";
  $("viewer").innerHTML = colorDiff(res.diff);
}

async function renderSide() {
  for (const b of document.querySelectorAll(".tabs button")) b.classList.toggle("on", b.dataset.tab === tab);
  if (tab === "history") {
    const commits = await api("/api/agents/" + agent + "/history");
    $("side").innerHTML = commits.map((c) =>
      '<div class="commit" data-sha="' + c.sha + '"><div class="subj">' + (c.isReflection && !c.subject.includes("🔮") ? "🔮 " : c.isMerge ? "⑂ " : "") + esc(c.subject) +
      '</div><div class="small">' + esc(c.author) + " · " + new Date(c.date).toLocaleString() + " · " + esc(c.stat || "") + "</div></div>").join("");
    for (const el of $("side").querySelectorAll(".commit")) el.onclick = () => openCommit(el.dataset.sha);
  } else if (tab === "conversations") {
    const convs = await api("/api/agents/" + agent + "/conversations");
    $("side").innerHTML = convs.length ? convs.map((c) =>
      '<div class="conv"><div class="path">' + esc(c.id) + (c.updatePending ? ' <span class="tag t-deferred">待注入 memory_update</span>' : "") +
      '</div><div class="kv">' +
      "<span>消息（全部 / 在上下文）</span><span>" + c.messages + " / " + c.inContext + "</span>" +
      "<span>上下文估算</span><span>~" + c.contextTokens + " tokens</span>" +
      "<span>压缩次数</span><span>" + c.compactions + "</span>" +
      "<span>memory_update</span><span>" + c.memoryUpdates + "</span>" +
      "<span>距上次反思</span><span>" + c.stepsSinceReflection + " 步</span>" +
      "<span>上次反思成功</span><span>" + (c.lastReflectionSucceededAt ? new Date(c.lastReflectionSucceededAt).toLocaleString() : "—") + "</span>" +
      "</div></div>").join("") : '<p class="empty">还没有对话</p>';
  } else {
    const convs = await api("/api/agents/" + agent + "/conversations");
    const id = (convs[0] && convs[0].id) || "default";
    const p = await api("/api/agents/" + agent + "/prompt?conversation=" + encodeURIComponent(id));
    $("side").innerHTML = '<p class="small">对话 ' + esc(id) + " 正在使用的（缓存）提示" +
      (p.cached && p.cached !== p.fresh ? ' <span class="tag t-deferred">与最新编译不同</span>' : "") + "</p><pre>" + esc(p.cached || p.fresh) + "</pre>";
  }
}

$("agent").onchange = (e) => { agent = e.target.value; refresh(); };
for (const b of document.querySelectorAll(".tabs button")) b.onclick = () => { tab = b.dataset.tab; renderSide(); };
loadAgents();
</script>
</body>
</html>`;
