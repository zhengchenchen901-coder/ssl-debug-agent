(() => {
  "use strict";
  const byId = id => document.getElementById(id);
  const titles = { overview: "实例总览", tasks: "任务与输出", results: "最终交付物", memory: "实例记忆", storage: "存储与审计", settings: "实例设置" };
  const descriptions = {
    overview: "连接健康、运行事件与后端服务，按当前实例查看。",
    tasks: "跟踪任务进度、控制资源模式并查看过程输出。",
    results: "按任务归档报告、结果、导出与附件。",
    memory: "已记录的系统、服务与路径事实；当前状态以实际检查为准。",
    storage: "查看本机与远端记录，核对范围后清理过期任务。",
  };
  let controller, page = "instances", instanceId = "", instanceView = "overview";
  let settingsTab = "ssh", databaseTab = "auto", formEmbedded = false, formDirty = false;
  let outputMounted = false;
  const originalFormParent = byId("modalBackdrop")?.parentElement;
  const form = byId("instanceForm");

  function selected() { return controller?.state.instances.find(instance => instance.id === instanceId); }
  function canLeaveForm() { if (controller?.state.savingForm) { controller.notify("配置正在保存，请稍后再切换页面。"); return false; } return !formDirty || window.confirm("当前实例配置有未保存的修改，确认放弃这些修改？"); }
  function setPage(next) {
    page = next;
    for (const node of document.querySelectorAll("[data-workspace-page]")) node.hidden = node.dataset.workspacePage !== next;
    byId("instanceNav").hidden = next !== "instance";
    const label = next === "instances" ? "连接实例" : next === "global" ? "全局输出" : next === "environment" ? "环境与管理" : `${selected()?.name || instanceId} / ${titles[instanceView]}`;
    byId("breadcrumbs").textContent = `管理空间 / ${label}`;
    for (const node of document.querySelectorAll("button[data-page]")) {
      const active = node.dataset.page === (next === "instance" ? `instance:${instanceView}` : next);
      node.classList.toggle("active", active);
      if (active) node.setAttribute("aria-current", "page"); else node.removeAttribute("aria-current");
    }
  }
  function closeMounted() {
    if (outputMounted && instanceId) window.remoteDebugOutputPreview?.unmount(instanceId);
    outputMounted = false;
    controller?.closeDrawer(false);
  }
  function route(next, id = instanceId) {
    if (!controller || !canLeaveForm()) return;
    if (formEmbedded) controller.closeModal();
    closeMounted();
    if (next.startsWith("instance:")) {
      instanceId = id;
      instanceView = next.slice(9);
      if (!titles[instanceView] || !selected()) return route("instances");
      setPage("instance");
      if (instanceView === "settings") controller.openModal(selected());
      else controller.openDrawer(selected(), instanceView);
    } else {
      setPage(next);
      if (next === "global") window.remoteDebugOutputPreview?.toggle(null, true);
      else window.remoteDebugOutputPreview?.toggle(null, false);
    }
    updateContext();
  }
  function updateContext() {
    if (!controller) return;
    const instance = selected();
    byId("navInstanceName").textContent = instance?.name || "";
    const picker = byId("instancePicker");
    const previous = picker.value;
    // Avoid replacing a focused select on every background status update.
    const signature = JSON.stringify(controller.state.instances.map(item => [item.id, item.name]));
    if (picker.dataset.signature !== signature) {
      picker.replaceChildren(...controller.state.instances.map(item => {
        const option = document.createElement("option"); option.value = item.id; option.textContent = `${item.name} · ${item.id}`; return option;
      }));
      picker.dataset.signature = signature;
    }
    picker.value = instanceId || previous;
    byId("instanceTarget").textContent = instance ? `${instance.username}@${instance.host}:${instance.port || 22}` : "";
    byId("instanceSnapshot").textContent = controller.state.online ? (instanceView === "tasks" ? "任务状态自动刷新" : "详情为打开时快照") : "主进程不可用 · 显示上次状态";
    picker.disabled = !controller.state.instances.length;
  }
  function update() {
    if (!controller) return;
    updateContext();
    if (page === "instance" && !selected()) { formDirty = false; route("instances"); }
    if (!byId("environmentPanel").hidden) byId("environmentEmpty").hidden = true;
    document.querySelectorAll("button[data-page]").forEach(button => { button.disabled = !controller.isUnlocked(); });
  }
  function visibleInstances(instances) {
    const query = (byId("instanceSearch")?.value || "").trim().toLowerCase();
    const filter = byId("instanceFilter")?.value || "all";
    return instances.filter(instance => {
      const status = instance.runtime?.status || "stopped";
      return `${instance.name} ${instance.id} ${instance.host} ${instance.username}`.toLowerCase().includes(query) &&
        (filter === "all" || filter === "unhealthy" && ["unhealthy", "failed"].includes(status) || status === filter);
    });
  }
  function showInstance(instance, view) {
    closeMounted();
    instanceId = instance.id;
    instanceView = view;
    setPage("instance");
    byId("drawerTitle").textContent = titles[view];
    byId("instancePageDescription").textContent = descriptions[view] || "";
    const actions = byId("instanceActions"); actions.replaceChildren();
    if (view !== "tasks") {
      const refresh = document.createElement("button"); refresh.type = "button"; refresh.className = "button subtle"; refresh.textContent = "刷新详情";
      refresh.addEventListener("click", async () => { await controller.loadInstances(); if (page === "instance" && instanceView === view && selected()?.id === instance.id) route(`instance:${view}`); });
      actions.append(refresh);
    }
    for (const [label, action] of view === "overview" ? [["手动工作台", "manual"], ["实例设置", "edit"]] : []) {
      const button = document.createElement("button"); button.type = "button"; button.className = "button" + (action === "manual" ? " primary" : ""); button.textContent = label;
      button.disabled = !controller.state.online || action === "manual" && !instance.enabled;
      button.addEventListener("click", () => controller.runAction(action, instance.id)); actions.append(button);
    }
    byId("instanceSettingsMount").hidden = true;
    updateContext();
  }
  function attachOutput(instance, container) {
    const section = document.createElement("section"); section.className = "instance-output";
    container.append(section);
    outputMounted = Boolean(window.remoteDebugOutputPreview?.mount(instance.id, section));
  }

  function buildFormGroups() {
    if (!form || form.dataset.grouped) return;
    form.dataset.grouped = "true";
    form.noValidate = true;
    const groups = {};
    for (const tab of Object.keys({ ssh: 1, database: 1, services: 1, permissions: 1 })) {
      const section = document.createElement("div"); section.className = "settings-group"; section.id = `settings-${tab}-panel`;
      section.setAttribute("role", "tabpanel"); section.setAttribute("aria-labelledby", `settings-${tab}-tab`);
      section.dataset.settingsGroup = tab; groups[tab] = section;
    }
    // Keep one form and one payload. Hidden groups retain values and permission scopes.
    for (const node of [...form.children]) {
      if (["settingsTabs", "databaseTabs", "formMessage"].includes(node.id) || node.classList.contains("modal-actions")) continue;
      const name = node.querySelector("[name]")?.name || "";
      let tab = "ssh", connection = "";
      if (["serviceProfiles", "logProjects"].includes(name)) tab = "services";
      else if (node.id === "mongodbPermissions" || name === "approvedCommandsEnabled") tab = "permissions";
      else if (name.startsWith("sandbox")) { tab = "database"; connection = "sandbox"; }
      else if (name.startsWith("manualMongo")) { tab = "database"; connection = "manual"; }
      else if (name.startsWith("mongodb")) { tab = "database"; connection = "auto"; }
      node.dataset.databaseGroup = connection;
      groups[tab].append(node);
    }
    const before = byId("formMessage");
    for (const section of Object.values(groups)) form.insertBefore(section, before);
    form.addEventListener("input", () => { formDirty = true; });
    form.addEventListener("change", () => { formDirty = true; });
  }
  function showSettingsTab(tab = settingsTab, connection = databaseTab) {
    settingsTab = tab; databaseTab = connection;
    document.querySelectorAll("[data-settings-group]").forEach(node => { node.hidden = node.dataset.settingsGroup !== tab; });
    document.querySelectorAll("[data-settings-tab]").forEach(node => node.setAttribute("aria-selected", String(node.dataset.settingsTab === tab)));
    byId("databaseTabs").hidden = tab !== "database";
    document.querySelectorAll("[data-database-group]").forEach(node => { if (node.dataset.databaseGroup) node.hidden = node.dataset.databaseGroup !== connection; });
    document.querySelectorAll("[data-database-tab]").forEach(node => node.setAttribute("aria-pressed", String(node.dataset.databaseTab === connection)));
    byId("saveSandboxButton").hidden = tab !== "database" || connection !== "sandbox";
  }
  function presentForm(instance) {
    formDirty = false;
    settingsTab = "ssh"; databaseTab = "auto";
    const backdrop = byId("modalBackdrop"), modal = backdrop.querySelector(".modal");
    formEmbedded = Boolean(instance);
    if (instance) {
      closeMounted(); instanceId = instance.id; instanceView = "settings"; setPage("instance"); updateContext();
      const mount = byId("instanceSettingsMount"); mount.hidden = false; mount.append(backdrop);
      backdrop.classList.add("embedded-settings"); modal.removeAttribute("role"); modal.removeAttribute("aria-modal");
      byId("modalTitle").textContent = "实例设置";
    } else {
      originalFormParent.append(backdrop); backdrop.classList.remove("embedded-settings");
      modal.setAttribute("role", "dialog"); modal.setAttribute("aria-modal", "true");
    }
    showSettingsTab();
  }
  function formClosed() {
    const wasEmbedded = formEmbedded; formEmbedded = false; formDirty = false;
    const backdrop = byId("modalBackdrop");
    if (wasEmbedded) { originalFormParent.append(backdrop); backdrop.classList.remove("embedded-settings"); byId("instanceSettingsMount").hidden = true; }
  }
  function validateForm() {
    const invalid = [...form.elements].find(field => field.willValidate && !field.checkValidity());
    if (!invalid) return true;
    const group = invalid.closest("[data-settings-group]")?.dataset.settingsGroup;
    const connection = invalid.closest("[data-database-group]")?.dataset.databaseGroup;
    showSettingsTab(group || settingsTab, connection || databaseTab);
    invalid.focus(); invalid.reportValidity(); return false;
  }
  function authVisibility(unlocked) {
    byId("dashboardContent").hidden = !unlocked;
    document.querySelectorAll("button[data-page]").forEach(button => { button.disabled = !unlocked; });
    if (!unlocked) { formDirty = false; closeMounted(); formClosed(); setPage("instances"); }
  }
  function showManagementTab(tab) {
    for (const key of ["environment", "admin", "manager"]) {
      byId(`${key}Section`).hidden = tab !== key;
      byId(`${key}Tab`).setAttribute("aria-selected", String(tab === key));
    }
  }
  function diagnostic() {
    document.body.classList.add("diagnostic-mode");
    byId("dashboardContent").hidden = false; byId("authPanel").hidden = true;
    setPage("environment"); showManagementTab("environment"); byId("environmentEmpty").hidden = true;
    document.querySelectorAll("button[data-page], [data-management-tab]").forEach(button => { button.disabled = true; });
  }
  document.addEventListener("click", event => {
    const nav = event.target.closest("button[data-page]");
    if (nav && !nav.disabled) route(nav.dataset.page);
    const setting = event.target.closest("[data-settings-tab]");
    if (setting) showSettingsTab(setting.dataset.settingsTab);
    const connection = event.target.closest("[data-database-tab]");
    if (connection) showSettingsTab("database", connection.dataset.databaseTab);
    const management = event.target.closest("[data-management-tab]");
    if (management) showManagementTab(management.dataset.managementTab);
    if (!event.target.closest(".row-menu")) document.querySelectorAll(".row-menu[open]").forEach(menu => { menu.open = false; });
  });
  byId("instancePicker")?.addEventListener("change", event => {
    const id = event.target.value;
    if (!canLeaveForm()) { event.target.value = instanceId; return; }
    formDirty = false; route(`instance:${instanceView}`, id);
  });
  for (const id of ["instanceSearch", "instanceFilter"]) byId(id)?.addEventListener(id === "instanceSearch" ? "input" : "change", () => controller?.render());
  window.addEventListener("beforeunload", event => { if (formDirty) { event.preventDefault(); event.returnValue = ""; } });
  window.addEventListener("keydown", event => { if (event.key === "Escape") document.querySelectorAll(".row-menu[open]").forEach(menu => { menu.open = false; }); });
  window.remoteDebugWorkspace = {
    init(options) { controller = options; buildFormGroups(); authVisibility(controller.isUnlocked()); update(); },
    route, update, visibleInstances, showInstance, attachOutput, presentForm, formClosed, validateForm, authVisibility, diagnostic,
    confirmDiscard: canLeaveForm,
    saved(id) { formDirty = false; route("instance:overview", id); },
    cancelled() { if (!canLeaveForm()) return false; const embedded = formEmbedded; formDirty = false; controller.closeModal(); if (embedded) route("instance:overview"); return true; },
    refreshInstance(id) { if (page === "instance" && instanceId === id && instanceView === "overview") route("instance:overview", id); },
    get view() { return instanceView; },
  };
})();
