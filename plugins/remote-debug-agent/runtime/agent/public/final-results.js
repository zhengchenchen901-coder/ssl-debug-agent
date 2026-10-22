(() => {
  const categories = { results: "最终结果", reports: "报告", exports: "导出", attachments: "附件" };
  const statuses = { completed: "已完成", partial: "部分结果", failed: "失败摘要", cancelled: "取消摘要" };
  function el(tag, className = "", text = "") { const node = document.createElement(tag); node.className = className; node.textContent = text; return node; }
  function button(text, click) { const node = el("button", "button", text); node.type = "button"; node.onclick = click; return node; }
  function bytes(value) { return value >= 1048576 ? `${(value / 1048576).toFixed(1)} MiB` : `${(value / 1024).toFixed(1)} KiB`; }

  function create({ instanceId, api, notify }) {
    const element = el("section", "final-results"); element.setAttribute("aria-label", instanceId === null ? "Manager 最终结果" : "任务最终结果");
    const heading = el("div", "task-heading"), title = el("h2", "", instanceId === null ? "Manager 最终结果" : "任务最终结果");
    const summary = el("p", "muted", "只保存任务最终交付物。"), location = el("p", "muted final-result-location");
    const message = el("p", "task-message"); message.setAttribute("role", "status");
    const list = el("div", "task-list"), pager = el("div", "task-actions");
    const abort = new AbortController();
    let disposed = false, loading = false, offset = 0;
    const scope = instanceId === null ? "scope=manager" : `instanceId=${encodeURIComponent(instanceId)}`;
    const route = (task, file) => `/api/final-results/${task.taskId}${file ? `/artifacts/${file.artifactId}` : ""}?${scope}`;

    async function preview(task, file, body) {
      try {
        const result = await api(route(task, file), { signal: abort.signal });
        if (!disposed) { body.hidden = false; body.textContent = result.content + (result.truncated ? "\n\n预览已截断，请下载完整文件。" : ""); }
      } catch (error) { if (!disposed) { message.textContent = error.message; notify(error.message); } }
    }
    async function download(task, file) {
      try {
        const response = await fetch(`${route(task, file)}&download=1`, { headers: window.remoteDebugAuthHeaders(), signal: abort.signal });
        if (response.status === 401) window.dispatchEvent(new Event("remote-debug-auth-expired"));
        if (!response.ok) throw new Error("下载失败，请刷新后重试。");
        const blob = await response.blob();
        if (disposed) return;
        const url = URL.createObjectURL(blob), link = el("a");
        link.href = url; link.download = file.format === "binary" ? file.name : `${file.name}.${{ markdown: "md", text: "txt" }[file.format] || file.format}`;
        document.body.append(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (error) { if (!disposed) { message.textContent = error.message; notify(error.message); } }
    }
    async function remove(task) {
      if (!window.confirm(`删除“${task.title}”的最终交付文件？此操作不影响远端任务或回滚记录。`)) return;
      try {
        await api(route(task), { method: "DELETE", signal: abort.signal });
        if (!disposed) { notify("最终结果已删除"); await load(); }
      } catch (error) { if (!disposed) { message.textContent = error.message; notify(error.message); } }
    }
    function render(data) {
      summary.textContent = `${data.total} 个任务 · ${bytes(data.totalBytes || 0)} · 仅最终交付物${data.unavailable ? ` · ${data.unavailable} 项不可用` : ""}`;
      location.textContent = `输出目录：${data.outputDirectory}`;
      list.replaceChildren();
      for (const task of data.results) {
        const card = el("article", "task-card final-result-card");
        card.dataset.taskId = task.taskId;
        card.append(el("strong", "", task.title), el("p", "muted", `${statuses[task.status] || task.status} · ${new Date(task.publishedAt).toLocaleString()} · ${task.files.length} 个文件 · ${bytes(task.totalBytes)}`));
        for (const category of Object.keys(categories)) {
          const files = task.files.filter((file) => file.category === category);
          if (!files.length) continue;
          const group = el("div", "final-result-group");
          group.append(el("strong", "", categories[category]));
          for (const file of files) {
            const row = el("div", "final-result-file"), body = el("pre", "sandbox-output final-result-preview"); body.hidden = true;
            const format = file.encoding === "binary" ? file.name.split(".").pop().toUpperCase() : { markdown: "Markdown", text: "文本" }[file.format] || file.format.toUpperCase();
            row.append(el("span", "", `${file.name} · ${format} · ${bytes(file.bytes)}`));
            if (file.encoding !== "binary") row.append(button("预览", () => preview(task, file, body)));
            row.append(button("下载", () => download(task, file)));
            group.append(row, body);
          }
          card.append(group);
        }
        card.append(button("删除最终结果", () => remove(task))); list.append(card);
      }
      if (!data.results.length) list.append(el("p", "muted", "暂无最终结果。任务收尾并发布交付物后显示在这里。"));
      pager.replaceChildren();
      if (offset > 0) pager.append(button("上一页", () => { offset = Math.max(0, offset - 10); load(); }));
      if (data.nextOffset !== null) pager.append(button("下一页", () => { offset = data.nextOffset; load(); }));
    }
    async function load() {
      if (disposed || loading) return;
      loading = true;
      try {
        const data = await api(`/api/final-results?${scope}&offset=${offset}&limit=10`, { signal: abort.signal });
        if (!disposed && offset > 0 && !data.results.length) { offset = Math.max(0, offset - 10); loading = false; return load(); }
        if (!disposed) { message.textContent = ""; render(data); }
      } catch (error) { if (!disposed) message.textContent = `最终结果暂不可用：${error.message}`; }
      finally { loading = false; }
    }
    heading.append(title, button("刷新最终结果", load));
    element.append(heading, summary, location, message, list, pager);
    load();
    return { element, destroy() { disposed = true; abort.abort(); } };
  }
  window.remoteDebugFinalResults = { create };
})();
