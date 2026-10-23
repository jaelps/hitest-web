(() => {
  "use strict";

  const categoryNames = {
    machine_modules: "Módulo de máquina",
    air_sensors: "Sensor de ar",
    online_dosers: "Dosador online",
  };
  const categoryIcons = { machine_modules: "▦", air_sensors: "◉", online_dosers: "◌" };
  const state = {
    devices: [],
    category: "all",
    screen: "overview",
    token: sessionStorage.getItem("hitest-api-token") || "",
    events: [],
    busy: false,
  };

  const $ = (selector) => document.querySelector(selector);
  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
  let toastTimer;

  function notify(message, isError = false) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.classList.toggle("error", isError);
    toast.classList.add("visible");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 3400);
  }

  async function request(path, options = {}) {
    if (!state.token) throw new Error("Configure o token de acesso à API.");
    const response = await fetch(`/api${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${state.token}`, "Content-Type": "application/json", ...options.headers },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.detail || `Falha na conexão (HTTP ${response.status}).`);
    return body;
  }

  function setConnection(connected, caption) {
    $("#connection-dot").classList.toggle("connected", connected);
    $("#gateway-caption").textContent = caption;
  }

  function filteredDevices() {
    const term = $("#search-input").value.trim().toLowerCase();
    const devices = state.devices.filter((device) => {
      const matchesCategory = state.category === "all" || device.category === state.category;
      const matchesSearch = !term || `${device.id} ${device.endpoint} ${categoryNames[device.category]}`.toLowerCase().includes(term);
      return matchesCategory && matchesSearch;
    });
    return state.screen === "overview" ? devices.slice(0, 5) : devices;
  }

  function render() {
    const devices = filteredDevices();
    const onlineCount = state.devices.filter((device) => device.status === "online").length;
    const offlineCount = state.devices.filter((device) => device.status === "offline").length;
    const total = state.devices.length;
    $("#total-metric").textContent = total;
    $("#online-metric").textContent = onlineCount;
    $("#offline-metric").textContent = offlineCount;
    $("#availability-metric").innerHTML = `${total ? Math.round((onlineCount / total) * 100) : "—"}<span class="percent">%</span>`;
    $("#all-count").textContent = total;
    $("#machine-count").textContent = state.devices.filter((device) => device.category === "machine_modules").length;
    $("#sensor-count").textContent = state.devices.filter((device) => device.category === "air_sensors").length;
    $("#doser-count").textContent = state.devices.filter((device) => device.category === "online_dosers").length;
    const rows = $("#device-rows");
    rows.innerHTML = devices.map((device) => {
      const status = device.status || "unknown";
      const statusLabel = status === "online" ? "Online" : status === "offline" ? "Offline" : "Aguardando";
      const canCommand = device.category !== "air_sensors";
      let endpointHost = "—";
      try { endpointHost = new URL(device.endpoint).host; } catch { /* Invalid imported data is rejected by the API. */ }
      return `<tr>
        <td data-label="Dispositivo"><div class="device-name"><span class="device-avatar">${categoryIcons[device.category]}</span><span>${escapeHtml(device.id)}<span class="device-id">HITEST DEVICE</span></span></div></td>
        <td data-label="Categoria"><span class="category-tag">${categoryNames[device.category]}</span></td>
        <td data-label="Endpoint HTTPS"><span class="ip-address">${escapeHtml(endpointHost)}</span></td>
        <td data-label="Status"><span class="status-pill ${status}">${statusLabel}</span></td>
        <td data-label="Versão"><span class="device-version">${escapeHtml(device.version || "—")}</span></td>
        <td data-label="Tempo ativo"><span class="uptime">${escapeHtml(device.uptime || "—")}</span></td>
        <td data-label="Ações"><div class="row-actions">
          ${canCommand ? `<button class="row-action command" data-action="command" data-id="${escapeHtml(device.id)}" title="Executar ação /lb" aria-label="Executar ação em ${escapeHtml(device.id)}">▶</button>` : ""}
          <button class="row-action" data-action="edit" data-id="${escapeHtml(device.id)}" title="Editar dispositivo" aria-label="Editar ${escapeHtml(device.id)}">✎</button>
          <button class="row-action delete" data-action="delete" data-id="${escapeHtml(device.id)}" title="Remover dispositivo" aria-label="Remover ${escapeHtml(device.id)}">×</button>
        </div></td>
      </tr>`;
    }).join("");
    const empty = devices.length === 0;
    $("#empty-state").classList.toggle("visible", empty);
    $("#device-rows").parentElement.style.display = empty ? "none" : "";
    $("#result-count").textContent = `${devices.length} ${devices.length === 1 ? "dispositivo" : "dispositivos"}`;
    const categoryTitle = state.category === "all" ? "" : ` · ${categoryNames[state.category]}`;
    $("#breadcrumb-current").textContent = state.screen === "overview" ? `Visão geral${categoryTitle}` : state.screen === "devices" ? `Dispositivos${categoryTitle}` : state.screen === "activity" ? "Atividade" : "Configurações";
    $("#page-title").textContent = state.screen === "devices"
      ? (state.category === "all" ? "Dispositivos" : categoryNames[state.category])
      : (state.category === "all" ? "Visão geral" : categoryNames[state.category]);
    document.querySelectorAll("[data-category]").forEach((button) => button.classList.toggle("active", button.dataset.category === state.category));
    document.querySelectorAll("[data-screen]").forEach((button) => button.classList.toggle("active", button.dataset.screen === state.screen));
    document.querySelectorAll(".screen-dashboard").forEach((element) => {
      element.hidden = state.screen === "activity" || state.screen === "settings"
        || (state.screen === "devices" && element.classList.contains("metrics-grid"));
    });
    $("#activity-screen").hidden = state.screen !== "activity";
    $("#settings-screen").hidden = state.screen !== "settings";
    $("#settings-auth-state").textContent = state.token ? "Conectado nesta sessão" : "Token não configurado";
    $("#settings-api-state").textContent = state.token ? "Autenticada" : "Aguardando autenticação";
    $("#device-subtitle").textContent = state.screen === "overview"
      ? "Resumo dos equipamentos monitorados"
      : "Todos os equipamentos cadastrados";
    $("#last-update").textContent = state.lastChecked ? `Atualizado às ${state.lastChecked}` : "Aguardando conexão";
  }

  async function refresh(showFeedback = false) {
    if (state.busy || !state.token) return;
    state.busy = true;
    $("#refresh-button").disabled = true;
    try {
      const result = await request("/status");
      state.devices = result.devices;
      state.lastChecked = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      setConnection(true, "API Vercel conectada.");
      render();
      if (showFeedback) notify("Dispositivos atualizados.");
    } catch (error) {
      setConnection(false, error.message);
      if (showFeedback) notify(error.message, true);
      else $("#last-update").textContent = "Gateway indisponível";
    } finally {
      state.busy = false;
      $("#refresh-button").disabled = false;
    }
  }

  async function loadDevices() {
    try {
      const result = await request("/devices");
      state.devices = result.devices.map((device) => ({ ...device, status: "unknown" }));
      setConnection(true, "API Vercel conectada.");
      render();
      await refresh();
    } catch (error) {
      state.devices = [];
      setConnection(false, error.message);
      render();
      throw error;
    }
  }

  function openSettings() {
    $("#gateway-token").value = state.token;
    $("#settings-error").textContent = "";
    $("#settings-dialog").showModal();
  }

  function openDevice(device) {
    $("#device-error").textContent = "";
    $("#device-dialog-title").textContent = device ? "Editar dispositivo" : "Adicionar dispositivo";
    $("#device-original-id").value = device ? device.id : "";
    $("#device-id").value = device ? device.id : "";
    $("#device-category").value = device ? device.category : "machine_modules";
    $("#device-endpoint").value = device ? device.endpoint : "";
    $("#device-dialog").showModal();
  }

  async function saveDevices(devices) {
    const result = await request("/devices", { method: "PUT", body: JSON.stringify({ devices }) });
    state.devices = result.devices.map((device) => ({ ...device, status: "unknown" }));
    render();
  }

  document.querySelectorAll("[data-screen]").forEach((button) => button.addEventListener("click", () => {
    state.screen = button.dataset.screen;
    render();
    if (state.screen === "activity") loadEvents();
  }));
  document.querySelectorAll("[data-category]").forEach((button) => button.addEventListener("click", () => {
    state.category = button.dataset.category;
    if (state.screen === "activity" || state.screen === "settings") state.screen = "devices";
    render();
  }));
  $("#open-settings").addEventListener("click", openSettings);
  $("#footer-settings").addEventListener("click", () => {
    state.screen = "settings";
    render();
  });
  $("#settings-connect").addEventListener("click", openSettings);
  $("#refresh-events").addEventListener("click", loadEvents);
  $("#refresh-button").addEventListener("click", () => refresh(true));
  $("#add-device").addEventListener("click", () => openDevice(null));
  $("#empty-add-device").addEventListener("click", () => openDevice(null));
  $("#search-input").addEventListener("input", render);
  document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => $(`#${button.dataset.close}`).close()));

  $("#settings-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const token = $("#gateway-token").value.trim();
    try {
      if (token.length < 32) throw new Error("O token deve ter pelo menos 32 caracteres.");
      state.token = token;
      sessionStorage.setItem("hitest-api-token", token);
      await loadDevices();
      $("#settings-dialog").close();
      notify("Conexão autenticada.");
    } catch (error) {
      state.token = "";
      sessionStorage.removeItem("hitest-api-token");
      $("#settings-error").textContent = error.message;
    }
  });

  $("#clear-token").addEventListener("click", () => {
    state.token = "";
    state.devices = [];
    sessionStorage.removeItem("hitest-api-token");
    setConnection(false, "Token removido.");
    render();
    $("#settings-error").textContent = "Token removido desta sessão.";
  });

  $("#device-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const originalId = $("#device-original-id").value;
    const device = {
      id: $("#device-id").value.trim(),
      category: $("#device-category").value,
      endpoint: $("#device-endpoint").value.trim(),
    };
    const devices = state.devices.filter((item) => item.id !== originalId);
    devices.push(device);
    try {
      await saveDevices(devices);
      $("#device-dialog").close();
      await refresh();
      notify("Dispositivo salvo.");
    } catch (error) {
      $("#device-error").textContent = error.message;
    }
  });

  $("#device-rows").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const device = state.devices.find((item) => item.id === button.dataset.id);
    if (!device) return;
    if (button.dataset.action === "edit") openDevice(device);
    if (button.dataset.action === "delete") {
      if (!window.confirm(`Remover o dispositivo "${device.id}"?`)) return;
      try {
        await saveDevices(state.devices.filter((item) => item.id !== device.id));
        notify("Dispositivo removido.");
      } catch (error) { notify(error.message, true); }
    }
    if (button.dataset.action === "command") {
      try {
        await request(`/devices/${encodeURIComponent(device.id)}/command`, { method: "POST" });
        notify(`Ação enviada para ${device.id}.`);
      } catch (error) { notify(error.message, true); }
    }
  });

  $("#export-button").addEventListener("click", () => {
    const data = JSON.stringify({ devices: state.devices.map(({ id, endpoint, category }) => ({ id, endpoint, category })) }, null, 2);
    const url = URL.createObjectURL(new Blob([data], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "hitest-devices.json";
    anchor.click();
    URL.revokeObjectURL(url);
  });

  $("#import-file").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const devices = Array.isArray(data) ? data : data.devices;
      if (!Array.isArray(devices)) throw new Error("O arquivo deve conter uma lista 'devices'.");
      await saveDevices(devices);
      await refresh();
      notify("Configuração importada.");
    } catch (error) { notify(`Não foi possível importar: ${error.message}`, true); }
  });

  async function loadEvents() {
    if (!state.token) {
      $("#activity-list").innerHTML = '<div class="activity-empty">Configure o token de acesso para consultar os eventos.</div>';
      return;
    }
    try {
      const result = await request("/events");
      state.events = result.events;
      $("#activity-list").innerHTML = state.events.length ? state.events.map((item) => `
        <article class="activity-row">
          <span class="activity-marker ${item.type === "command_failed" ? "failed" : ""}">${item.type === "command_sent" ? "▶" : item.type === "command_failed" ? "!" : "↻"}</span>
          <div class="activity-copy"><strong>${escapeHtml(item.description)}</strong><span>${escapeHtml(item.device || "Sistema")}</span></div>
          <time>${escapeHtml(new Date(item.timestamp).toLocaleString("pt-BR"))}</time>
        </article>`).join("") : '<div class="activity-empty">Ainda não há eventos registrados.</div>';
    } catch (error) {
      $("#activity-list").innerHTML = `<div class="activity-empty">${escapeHtml(error.message)}</div>`;
    }
  }

  if (state.token) loadDevices().catch(() => {});
  else {
    setConnection(false, "Configure o token de acesso para começar.");
    render();
  }
  window.setInterval(() => refresh(), 15000);
})();
