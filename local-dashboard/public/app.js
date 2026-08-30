const state = {
  accounts: [],
  proxies: [],
  pointChecks: [],
  pointCheckerError: "",
  filtered: [],
  selected: new Set(),
  page: 1,
  pageSize: 25,
  search: "",
  status: "all",
  health: null,
  activeView: "accounts",
};

const checkingPoints = new Set();

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function escapeHtml(value) {
  const node = document.createElement("span");
  node.textContent = value == null ? "" : String(value);
  return node.innerHTML;
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

async function call(method, path, body) {
  const options = { method, headers: { Accept: "application/json" } };
  if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(path, options);
  } catch {
    throw new Error("Không kết nối được dashboard local.");
  }
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  if (!response.ok) {
    const error = new Error(data.error || `Request thất bại (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

const api = {
  health: () => call("GET", "/api/health"),
  accounts: () => call("GET", "/api/accounts"),
  proxies: () => call("GET", "/api/proxies"),
  createProxy: (proxy) => call("POST", "/api/proxies", proxy),
  setProxyStatus: (id, status) => call("PATCH", `/api/proxies/${encodeURIComponent(id)}/status`, { status }),
  deleteProxy: (id) => call("DELETE", `/api/proxies/${encodeURIComponent(id)}`),
  pointChecks: () => call("GET", "/api/point-checks"),
  startPointCheck: (accountId) => call("POST", "/api/point-checks", { accountId }),
  importAccounts: (bundle) => call("POST", "/api/accounts/import", bundle),
  assignProxy: (email, body) => call("PATCH", `/api/accounts/${encodeURIComponent(email)}/proxy`, body),
  setStatus: (email, status) => call("PATCH", `/api/accounts/${encodeURIComponent(email)}/status`, { status }),
  deleteAccount: (email) => call("DELETE", `/api/accounts/${encodeURIComponent(email)}`),
  deleteAccounts: (emails) => call("DELETE", "/api/accounts", { emails }),
  logs: () => call("GET", "/api/logs"),
  control: (action) => call("POST", `/api/control/${action}`, {}),
};

function statusLabel(status) {
  return ({ ready: "Sẵn sàng", active: "Đang chạy", disabled: "Đã vô hiệu", error: "Lỗi", cooldown: "Cooldown" })[status] || status || "Chưa rõ";
}

function statusClass(status) {
  return ["ready", "active", "disabled", "error", "cooldown"].includes(status) ? status : "unknown";
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("vi-VN", { dateStyle: "short", timeStyle: "short" });
}

function formatPoints(value) {
  return value == null ? "—" : new Intl.NumberFormat("vi-VN").format(Number(value));
}

function pointCheckFor(account) {
  return state.pointChecks.find((item) => item.id === account.id)?.lastCheck || null;
}

function pointCheckCell(account) {
  const check = pointCheckFor(account);
  const busy = checkingPoints.has(account.id) || ["queued", "pending", "running"].includes(check?.status);
  let value = "Chưa check";
  let detail = "Chưa có lần kiểm tra điểm";
  if (check?.status === "success") {
    value = formatPoints(check.points);
    detail = check.checkedAt ? `Lần cuối: ${formatDate(check.checkedAt)}` : "Đã kiểm tra";
  } else if (busy) {
    value = "Đang check…";
    detail = "Points checker đang xử lý account này";
  } else if (check?.status === "error") {
    value = "Lỗi check";
    detail = check.errorMessage || "Không đọc được số dư Microsoft Rewards";
  }

  const button = account.id
    ? `<button class="point-check-button" data-check-points="${escapeAttr(account.id)}" ${busy ? "disabled" : ""}>${busy ? "Đang check…" : "Check điểm"}</button>`
    : "";
  return `<div class="point-check-cell"><strong class="point-check-value ${check?.status || "unchecked"}">${escapeHtml(value)}</strong><small title="${escapeAttr(detail)}">${escapeHtml(detail)}</small>${button}</div>`;
}

function showToast(message, type = "success") {
  const toast = $("#toast");
  toast.textContent = message;
  toast.className = `toast visible ${type}`;
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => { toast.className = "toast"; }, 3500);
}

function showNotice(message, type = "warning") {
  const notice = $("#notice");
  notice.hidden = !message;
  notice.className = `notice ${type}`;
  notice.textContent = message || "";
}

function refreshFiltered() {
  const query = state.search.trim().toLowerCase();
  state.filtered = state.accounts.filter((account) => {
    const haystack = [account.email, account.status, account.proxy?.label, account.proxy?.url, account.geoLocale, account.langCode].filter(Boolean).join(" ").toLowerCase();
    return (!query || haystack.includes(query)) && (state.status === "all" || account.status === state.status);
  });
  const maxPage = Math.max(1, Math.ceil(state.filtered.length / state.pageSize));
  state.page = Math.min(state.page, maxPage);
}

function renderStats() {
  const total = state.accounts.length;
  const ready = state.accounts.filter((account) => ["ready", "active"].includes(account.status)).length;
  const configured = state.accounts.filter((account) => account.email).length;
  const proxy = state.accounts.filter((account) => account.proxy && account.useProxy !== false).length;
  const issues = state.accounts.filter((account) => ["disabled", "error", "cooldown"].includes(account.status)).length;
  $("#statTotal").textContent = total;
  $("#statReady").textContent = ready;
  $("#statConfigured").textContent = configured;
  $("#statProxy").textContent = proxy;
  $("#statIssues").textContent = issues;
}

function proxyOptions(currentId) {
  return [
    `<option value="__direct"${!currentId ? " selected" : ""}>Không dùng proxy</option>`,
    ...state.proxies.map((proxy) => `<option value="${escapeAttr(proxy.id)}"${proxy.id === currentId ? " selected" : ""}>${escapeHtml(proxy.label)} · ${escapeHtml(proxy.url || "")}:${escapeHtml(proxy.port || "")}</option>`),
  ].join("");
}

function renderProxyRows() {
  const host = $("#proxyRows");
  if (!host) return;
  const proxies = state.proxies || [];
  $("#proxyMeta").textContent = `${proxies.length} proxy`;
  if (!proxies.length) {
    host.innerHTML = '<tr><td colspan="7" class="empty-cell">Chưa có proxy trên VPS.</td></tr>';
    return;
  }
  host.innerHTML = proxies.map((proxy) => {
    const nextStatus = proxy.status === "disabled" ? "active" : "disabled";
    const statusText = proxy.status === "active" ? "Đang hoạt động" : proxy.status;
    return `<tr>
      <td><strong>${escapeHtml(proxy.label)}</strong>${proxy.egressIp ? `<small class="proxy-subtext">Egress ${escapeHtml(proxy.egressIp)}</small>` : ""}</td>
      <td class="mono">${escapeHtml(proxy.url || "")} : ${escapeHtml(proxy.port || "")}</td>
      <td><span class="auth-state ${proxy.hasCredentials ? "ok" : "pending"}">${proxy.hasCredentials ? "Đã lưu" : "Không"}</span></td>
      <td>${escapeHtml(proxy.accountCount || 0)}</td>
      <td>${escapeHtml(proxy.accountCapacity || 1)}</td>
      <td><span class="status-pill ${statusClass(proxy.status)}">${escapeHtml(statusText)}</span></td>
      <td class="col-actions proxy-actions"><button class="detail-button" data-proxy-status="${escapeAttr(proxy.id)}" data-next-proxy-status="${nextStatus}">${nextStatus === "disabled" ? "Tắt" : "Bật"}</button><button class="detail-button danger" data-delete-proxy="${escapeAttr(proxy.id)}" data-proxy-label="${escapeAttr(proxy.label)}">Xóa</button></td>
    </tr>`;
  }).join("");
  host.querySelectorAll("button[data-proxy-status]").forEach((button) => button.addEventListener("click", async () => {
    try {
      await api.setProxyStatus(button.dataset.proxyStatus, button.dataset.nextProxyStatus);
      showToast("Đã cập nhật trạng thái proxy.");
      await loadData();
    } catch (error) { showToast(error.message, "error"); }
  }));
  host.querySelectorAll("button[data-delete-proxy]").forEach((button) => button.addEventListener("click", async () => {
    const label = button.dataset.proxyLabel;
    const usage = Number(button.closest("tr")?.children[3]?.textContent || 0);
    const warning = usage ? `\n\n${usage} account sẽ tự chuyển sang direct mode.` : "";
    if (!window.confirm(`Xóa proxy ${label}?${warning}`)) return;
    try {
      const result = await api.deleteProxy(button.dataset.deleteProxy);
      showToast(result.detached ? `Đã xóa proxy ${label}, gỡ ${result.detached} account.` : `Đã xóa proxy ${label}.`);
      await loadData();
    } catch (error) { showToast(error.message, "error"); }
  }));
}

function setView(view) {
  state.activeView = view;
  $("#accountWorkspace").hidden = view !== "accounts";
  $("#proxyWorkspace").hidden = view !== "proxies";
  $(".stats-grid").hidden = view !== "accounts";
  $(".topbar h1").textContent = view === "proxies" ? "Quản lý proxy" : "Quản lý account";
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.action === view));
  if (view === "proxies") renderProxyRows();
}

function renderRows() {
  refreshFiltered();
  const start = (state.page - 1) * state.pageSize;
  const visible = state.filtered.slice(start, start + state.pageSize);
  const tbody = $("#accountRows");
  if (!visible.length) {
    tbody.innerHTML = `<tr><td colspan="10" class="empty-cell">${state.accounts.length ? "Không có account phù hợp bộ lọc." : "Chưa có account trên VPS."}</td></tr>`;
  } else {
    tbody.innerHTML = visible.map((account, offset) => {
      const identity = account.index ? `ACC_${account.index}` : String(account.id || `ACC_${start + offset + 1}`).slice(-12);
      const selected = state.selected.has(account.email);
      const proxyText = account.proxy ? `${account.proxy.label}` : "Direct";
      return `<tr class="${selected ? "selected" : ""}">
        <td class="mono muted">${escapeHtml(identity)}</td>
        <td><input type="checkbox" data-select-email="${escapeAttr(account.email)}"${selected ? " checked" : ""} aria-label="Chọn ${escapeAttr(account.email)}" /></td>
        <td><div class="email-cell"><span class="avatar">${escapeHtml((account.email || "?")[0].toUpperCase())}</span><div><strong>${escapeHtml(account.email)}</strong><small>${account.hasRecoveryEmail ? "Recovery đã lưu" : "Không có recovery"}</small></div></div></td>
        <td><span class="soft-tag">Free</span></td>
        <td>${escapeHtml(account.geoLocale || "auto")}</td>
        <td><span class="proxy-text ${account.proxy ? "has-proxy" : "direct"}">${escapeHtml(proxyText)}</span></td>
        <td><span class="status-pill ${statusClass(account.status)}"><span class="status-dot"></span>${escapeHtml(statusLabel(account.status))}</span></td>
        <td><span class="auth-state ${account.hasTotp ? "ok" : "pending"}">${account.hasTotp ? "Đã lưu" : "Chưa có"}</span></td>
        <td>${pointCheckCell(account)}</td>
        <td class="muted">${escapeHtml(formatDate(account.updatedAt || account.updated_at))}</td>
        <td class="col-actions"><button class="detail-button" data-detail-email="${escapeAttr(account.email)}">◉ Xem</button><button class="detail-button danger" data-delete-email="${escapeAttr(account.email)}">Xóa</button></td>
      </tr>`;
    }).join("");
  }
  const emptyCell = tbody.querySelector(".empty-cell");
  if (emptyCell) emptyCell.colSpan = 11;
  $("#tableMeta").textContent = `${state.filtered.length} / ${state.accounts.length} account`;
  $("#pageLabel").textContent = `Trang ${state.page} / ${Math.max(1, Math.ceil(state.filtered.length / state.pageSize))}`;
  $("#selectedCount").textContent = `${state.selected.size} đã chọn`;
  $("#prevPage").disabled = state.page <= 1;
  $("#nextPage").disabled = state.page >= Math.max(1, Math.ceil(state.filtered.length / state.pageSize));
  $("#selectAll").checked = visible.length > 0 && visible.every((account) => state.selected.has(account.email));
  $("#selectAll").indeterminate = visible.some((account) => state.selected.has(account.email)) && !$("#selectAll").checked;
  renderStats();
}

function renderHealth(health) {
  state.health = health;
  const reachable = Boolean(health?.reachable);
  const control = health?.controlApi || {};
  const workerState = control.state || (reachable ? "idle" : "offline");
  const running = ["starting", "running", "stopping"].includes(workerState);
  $("#connectionDot").className = `status-dot ${reachable ? "online" : "offline"}`;
  $("#connectionText").textContent = reachable ? "VPS đã kết nối" : "VPS offline";
  $("#apiUrlLabel").textContent = health?.controlApiUrl || "Control API";
  $("#workerBadge").className = `worker-badge ${reachable ? (running ? "running" : "idle") : "unknown"}`;
  $("#workerState").textContent = reachable ? (workerState === "idle" ? "Worker đang chờ" : `Worker: ${workerState}`) : "Không kết nối VPS";
  $("#taskSummary").innerHTML = reachable
    ? `<span class="task-icon ${running ? "running" : ""}">${running ? "↻" : "✓"}</span><div><strong>${running ? "Worker đang chạy trên VPS" : "Worker đang chờ"}</strong><small>${control.run?.startedAt ? `Bắt đầu ${formatDate(control.run.startedAt)}` : "Account sẽ được chạy ở VPS, không chạy trên máy local."}</small></div>`
    : `<span class="task-icon error">!</span><div><strong>Chưa kết nối được VPS</strong><small>${escapeHtml(health?.error || "Kiểm tra CONTROL_API_URL và CONTROL_API_TOKEN.")}</small></div>`;
}

function renderLogs(payload) {
  const entries = payload?.entries || payload?.logs || [];
  if (!entries.length) return;
  $("#logOutput").textContent = entries.slice(-80).map((entry) => {
    if (typeof entry === "string") return entry;
    return `[${entry.receivedAt || entry.ts || "--:--:--"}] ${entry.raw || entry.message || entry.title || JSON.stringify(entry)}`;
  }).join("\n");
  const output = $("#logOutput");
  output.scrollTop = output.scrollHeight;
}

async function loadData(showLoading = false) {
  if (showLoading) showNotice("Đang đồng bộ account từ VPS…", "info");
  const results = await Promise.allSettled([api.accounts(), api.proxies(), api.health(), api.pointChecks()]);
  const [accounts, proxies, health, pointChecks] = results;
  if (accounts.status === "fulfilled") {
    state.accounts = accounts.value.accounts || [];
    state.selected = new Set([...state.selected].filter((email) => state.accounts.some((account) => account.email === email)));
    showNotice("");
  } else {
    showNotice(accounts.reason.message, "error");
  }
  if (proxies.status === "fulfilled") state.proxies = proxies.value.proxies || [];
  if (health.status === "fulfilled") renderHealth(health.value);
  else renderHealth({ reachable: false, error: health.reason.message });
  if (pointChecks.status === "fulfilled") {
    state.pointChecks = pointChecks.value.accounts || [];
    state.pointCheckerError = "";
  } else {
    state.pointChecks = [];
    state.pointCheckerError = pointChecks.reason.message;
  }
  renderRows();
  if (state.activeView === "proxies") renderProxyRows();
}

async function refreshPointChecks() {
  const payload = await api.pointChecks();
  state.pointChecks = payload.accounts || [];
  state.pointCheckerError = "";
  renderRows();
  return state.pointChecks;
}

async function checkAccountPoints(accountId) {
  const account = state.accounts.find((item) => item.id === accountId);
  if (!account || checkingPoints.has(accountId)) return;
  checkingPoints.add(accountId);
  renderRows();
  try {
    await api.startPointCheck(accountId);
    showToast(`Đã bắt đầu check điểm cho ${account.email}.`);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 2000));
      const rows = await refreshPointChecks();
      const current = rows.find((item) => item.id === accountId)?.lastCheck;
      if (current && !["queued", "pending", "running"].includes(current.status)) break;
    }
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    checkingPoints.delete(accountId);
    renderRows();
  }
}

async function loadLogs() {
  try { renderLogs(await api.logs()); } catch { /* The table remains usable when logs are unavailable. */ }
}

function openDialog(id) { const dialog = $(id); if (!dialog.open) dialog.showModal(); }
function closeDialogs() { $$('dialog[open]').forEach((dialog) => dialog.close()); }

function accountFromForm(form) {
  const values = Object.fromEntries(new FormData(form).entries());
  const account = { email: values.email.trim().toLowerCase(), status: values.status || "ready" };
  for (const key of ["password", "recoveryEmail", "totpSecret"]) if (values[key]?.trim()) account[key] = values[key].trim();
  const proxy = { label: values.proxyLabel?.trim(), url: values.proxyUrl?.trim(), port: Number(values.proxyPort), username: values.proxyUsername?.trim(), password: values.proxyPassword?.trim() };
  if (proxy.label && proxy.url && proxy.port) account.proxy = proxy;
  else account.useProxy = false;
  return { accounts: [account], allowDirectAccounts: true };
}

function parseBulkInput(raw) {
  const text = raw.trim();
  if (!text) throw new Error("Chưa nhập dữ liệu account.");
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return { accounts: parsed, allowDirectAccounts: true };
    if (!parsed || typeof parsed !== "object") throw new Error("JSON phải là object hoặc array.");
    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) {
      const accounts = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#")).map((line) => {
        const fields = (line.includes("|") ? line.split("|") : line.split(",")).map((field) => field.trim());
        let [email, password, recoveryEmail, totpSecret, proxyLabel] = fields;
        if (!email || !email.includes("@")) throw new Error(`Email không hợp lệ: ${email}`);

        // Tự động nhận diện định dạng Hotmail Token (email|pass|refreshToken|clientId|recoveryEmail)
        if (fields.length === 5 && (fields[2]?.startsWith("M.") || fields[2]?.length > 40) && fields[4]?.includes("@")) {
          recoveryEmail = fields[4];
          totpSecret = undefined;
          proxyLabel = undefined;
        }

        return { email: email.toLowerCase(), password, recoveryEmail, totpSecret, proxyLabel, useProxy: Boolean(proxyLabel) };
      });
      if (!accounts.length) throw new Error("Không tìm thấy account hợp lệ.");
      return { accounts, allowDirectAccounts: true };
    }
    throw error;
  }
}

async function submitAccount(event) {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await api.importAccounts(accountFromForm(form));
    form.reset();
    closeDialogs();
    showToast("Đã lưu account lên VPS.");
    await loadData();
  } catch (error) { showToast(error.message, "error"); }
}

async function submitBulk(event) {
  event.preventDefault();
  try {
    await api.importAccounts(parseBulkInput($("#bulkInput").value));
    $("#bulkInput").value = "";
    closeDialogs();
    showToast("Đã import account lên VPS.");
    await loadData();
  } catch (error) { showToast(error.message, "error"); }
}

async function submitProxy(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form).entries());
  const proxy = {
    label: values.label.trim(),
    url: values.url.trim(),
    port: Number(values.port),
    accountCapacity: Number(values.accountCapacity || 1),
    cooldownSeconds: Number(values.cooldownSeconds || 0),
    proxyHttp: form.elements.proxyHttp.checked,
  };
  for (const key of ["username", "password"]) if (values[key]?.trim()) proxy[key] = values[key].trim();
  try {
    await api.createProxy(proxy);
    form.reset();
    showToast(`Đã lưu proxy ${proxy.label}.`);
    await loadData();
  } catch (error) { showToast(error.message, "error"); }
}

function showAccountDetail(email) {
  const account = state.accounts.find((item) => item.email === email);
  if (!account) return;
  $("#detailTitle").textContent = account.email;
  $("#detailBody").innerHTML = `<div class="detail-grid">
    <div><span>ID</span><strong>${escapeHtml(account.id || "—")}</strong></div><div><span>Trạng thái</span><strong><span class="status-pill ${statusClass(account.status)}">${escapeHtml(statusLabel(account.status))}</span></strong></div>
    <div><span>Recovery</span><strong>${account.hasRecoveryEmail ? "Đã lưu" : "Chưa có"}</strong></div><div><span>TOTP</span><strong>${account.hasTotp ? "Đã lưu" : "Chưa có"}</strong></div>
    <div><span>Khu vực</span><strong>${escapeHtml(account.geoLocale || "auto")}</strong></div><div><span>Ngôn ngữ</span><strong>${escapeHtml(account.langCode || "en")}</strong></div>
  </div>
  <label class="detail-proxy">Proxy account<select id="detailProxy">${proxyOptions(account.proxy?.id)}</select></label>
  <div class="detail-actions"><button class="button ghost" id="saveDetailProxy">Lưu proxy</button><button class="button ghost" id="toggleDetailStatus">${account.status === "disabled" ? "Bật lại" : "Vô hiệu hóa"}</button><button class="button danger" id="deleteDetailAccount">Xóa account</button></div>`;
  openDialog("#detailDialog");
  $("#saveDetailProxy").onclick = async () => {
    try { const value = $("#detailProxy").value; await api.assignProxy(email, value === "__direct" ? { useProxy: false } : { proxyId: value }); showToast("Đã cập nhật proxy."); closeDialogs(); await loadData(); } catch (error) { showToast(error.message, "error"); }
  };
  $("#toggleDetailStatus").onclick = async () => {
    try { await api.setStatus(email, account.status === "disabled" ? "ready" : "disabled"); showToast("Đã cập nhật trạng thái."); closeDialogs(); await loadData(); } catch (error) { showToast(error.message, "error"); }
  };
  $("#deleteDetailAccount").onclick = async () => {
    if (!window.confirm(`Xóa vĩnh viễn ${email}?`)) return;
    try { await api.deleteAccount(email); showToast("Đã xóa account."); closeDialogs(); await loadData(); } catch (error) { showToast(error.message, "error"); }
  };
}

async function runControl(action) {
  try { await api.control(action); showToast(action === "stop" ? "Đã gửi lệnh dừng tới VPS." : "Đã gửi lệnh chạy tới VPS."); await loadData(); } catch (error) { showToast(error.message, "error"); }
}

function handleAction(action) {
  if (action === "accounts") { setView("accounts"); loadData(true); return; }
  if (action === "proxies") { setView("proxies"); loadData(true); return; }
  if (action === "add" || action === "bulk") setView("accounts");
  if (action === "add") openDialog("#accountDialog");
  else if (action === "bulk") openDialog("#bulkDialog");
  else if (action === "run") runControl("start");
  else if (action === "stop") runControl("stop");
  else if (action === "refresh" || action === "accounts") loadData(true);
  else if (action === "proxies") {
    const rows = state.proxies.map((proxy) => `<tr><td>${escapeHtml(proxy.label)}</td><td>${escapeHtml(proxy.url || "")} : ${escapeHtml(proxy.port || "")}</td><td>${escapeHtml(proxy.accountCount ?? proxy.account_count ?? 0)}</td><td>${escapeHtml(proxy.status || "active")}</td></tr>`).join("");
    $("#detailTitle").textContent = "Proxy trên VPS";
    $("#detailBody").innerHTML = `<div class="proxy-table-wrap"><table><thead><tr><th>Label</th><th>Endpoint</th><th>Account</th><th>Trạng thái</th></tr></thead><tbody>${rows || `<tr><td colspan="4" class="empty-cell">Chưa có proxy.</td></tr>`}</tbody></table></div>`;
    openDialog("#detailDialog");
  }
}

async function deleteSelected() {
  const emails = [...state.selected];
  if (!emails.length) return showToast("Chưa chọn account.", "warning");
  if (!window.confirm(`Xóa vĩnh viễn ${emails.length} account đã chọn?`)) return;
  try { await api.deleteAccounts(emails); state.selected.clear(); showToast(`Đã xóa ${emails.length} account.`); await loadData(); } catch (error) { showToast(error.message, "error"); }
}

async function deleteSingleAccount(email) {
  if (!email || !window.confirm(`Xóa vĩnh viễn ${email}?`)) return;
  try {
    await api.deleteAccount(email);
    state.selected.delete(email);
    showToast(`Đã xóa ${email}.`);
    await loadData();
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function disableSelected() {
  const emails = [...state.selected];
  if (!emails.length) return showToast("Chưa chọn account.", "warning");
  try { for (const email of emails) await api.setStatus(email, "disabled"); showToast(`Đã vô hiệu hóa ${emails.length} account.`); await loadData(); } catch (error) { showToast(error.message, "error"); }
}

function bindEvents() {
  document.addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action) handleAction(action);
    const detailEmail = event.target.closest("[data-detail-email]")?.dataset.detailEmail;
    if (detailEmail) showAccountDetail(detailEmail);
    if (event.target.matches("[data-close-dialog]")) closeDialogs();
  });
  $("#accountForm").addEventListener("submit", submitAccount);
  $("#bulkForm").addEventListener("submit", submitBulk);
  $("#proxyForm").addEventListener("submit", submitProxy);
  $("#refreshButton").addEventListener("click", () => loadData(true));
  $("#searchInput").addEventListener("input", (event) => { state.search = event.target.value; state.page = 1; renderRows(); });
  $("#statusFilter").addEventListener("change", (event) => { state.status = event.target.value; state.page = 1; renderRows(); });
  $("#pageSize").addEventListener("change", (event) => { state.pageSize = Number(event.target.value); state.page = 1; renderRows(); });
  $("#prevPage").addEventListener("click", () => { state.page -= 1; renderRows(); });
  $("#nextPage").addEventListener("click", () => { state.page += 1; renderRows(); });
  $("#selectAll").addEventListener("change", (event) => {
    const start = (state.page - 1) * state.pageSize;
    state.filtered.slice(start, start + state.pageSize).forEach((account) => event.target.checked ? state.selected.add(account.email) : state.selected.delete(account.email));
    renderRows();
  });
  $("#accountRows").addEventListener("change", (event) => { const email = event.target.dataset.selectEmail; if (!email) return; event.target.checked ? state.selected.add(email) : state.selected.delete(email); renderRows(); });
  $("#accountRows").addEventListener("click", (event) => {
    const deleteEmail = event.target.closest("[data-delete-email]")?.dataset.deleteEmail;
    if (deleteEmail) {
      void deleteSingleAccount(deleteEmail);
      return;
    }
    const accountId = event.target.closest("[data-check-points]")?.dataset.checkPoints;
    if (accountId) checkAccountPoints(accountId);
  });
  $("#deleteSelected").addEventListener("click", deleteSelected);
  $("#disableSelected").addEventListener("click", disableSelected);
  $("#clearLog").addEventListener("click", () => { $("#logOutput").textContent = "Chưa có log mới."; });
  $$('dialog').forEach((dialog) => dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); }));
}

bindEvents();
loadData(true);
loadLogs();
window.setInterval(() => loadData(false), 8000);
window.setInterval(loadLogs, 8000);
