const adminBackdrop = document.getElementById("adminBackdrop");
const adminForm = document.getElementById("adminForm");
const adminMessage = document.getElementById("adminMessage");
const saveAdminButton = document.getElementById("saveAdminButton");
const existingFields = document.getElementById("existingAdminFields");
let busy = false;
let resetting = false, adminCount = 0;
function updateMode() {
  document.getElementById("adminTitle").textContent = resetting ? "重置管理员密码" : "注册管理员";
  saveAdminButton.textContent = resetting ? "验证本机身份并重置" : "验证本机身份并注册";
  existingFields.hidden = resetting || adminCount === 0;
  for (const name of ["existingUsername", "existingPassword"]) adminForm.elements[name].required = !resetting && adminCount > 0;
  document.getElementById("adminResetMode").hidden = adminCount === 0;
  document.getElementById("adminResetMode").textContent = resetting ? "返回注册管理员" : "忘记密码？通过本机身份验证重置";
}
async function adminApi(route, body) {
  const response = await fetch(route, { method: body ? "POST" : "GET", headers: {
    ...window.remoteDebugAuthHeaders(), ...(body ? { "Content-Type": "application/json" } : {}),
  }, ...(body ? { body: JSON.stringify(body) } : {}), cache: "no-store", redirect: "error" });
  const value = await response.json();
  if (!response.ok || !value.ok) throw new Error(value.error?.message || "请求失败。");
  return value;
}
function closeAdmin() {
  if (busy) return;
  adminBackdrop.hidden = true;
  adminForm.reset();
  resetting = false;
  document.getElementById("registerAdminButton").focus();
}
document.getElementById("registerAdminButton").addEventListener("click", async () => {
  adminForm.reset();
  adminBackdrop.hidden = false;
  saveAdminButton.disabled = true;
  adminMessage.textContent = "正在检查管理员状态…";
  try {
    const status = await adminApi("/api/manual/status");
    adminCount = status.adminCount;
    updateMode();
    document.getElementById("adminOwnerHint").textContent = status.ownerVerification.message;
    if (status.ownerVerification.supported) {
      adminMessage.textContent = "正在准备并检查系统认证组件，首次使用可能需要约一分钟…";
      await adminApi("/api/manual/prepare-owner", {});
      saveAdminButton.disabled = false;
    }
    adminMessage.textContent = status.ownerVerification.supported ? "系统认证组件已就绪。" : "";
    adminForm.elements.username.focus();
  } catch (error) { adminMessage.textContent = error.message; }
});
adminForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy || saveAdminButton.disabled) return;
  const fields = adminForm.elements;
  if (fields.password.value !== fields.confirmPassword.value) { adminMessage.textContent = "两次输入的新密码不一致。"; return; }
  const body = { username: fields.username.value.trim(), password: fields.password.value,
    ...(!resetting && !existingFields.hidden ? { existingUsername: fields.existingUsername.value.trim(), existingPassword: fields.existingPassword.value } : {}) };
  fields.password.value = ""; fields.confirmPassword.value = ""; fields.existingPassword.value = "";
  busy = true;
  saveAdminButton.disabled = true;
  adminMessage.textContent = "请在系统窗口中完成身份验证。";
  try {
    await adminApi(resetting ? "/api/manual/reset" : "/api/manual/register", body);
    adminForm.reset();
    if (!resetting) adminCount++;
    adminMessage.textContent = resetting ? "管理员密码已重置，该账号的旧会话已退出。" : "管理员注册成功。现在可以关闭此窗口，在实例工作区点击“手动工作台”。";
    updateMode();
  } catch (error) { adminMessage.textContent = error.message; }
  finally { busy = false; saveAdminButton.disabled = false; }
});
document.getElementById("closeAdminButton").addEventListener("click", closeAdmin);
document.getElementById("cancelAdminButton").addEventListener("click", closeAdmin);
adminBackdrop.addEventListener("click", (event) => { if (event.target === adminBackdrop) closeAdmin(); });
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !adminBackdrop.hidden) closeAdmin(); });
window.addEventListener("remote-debug-locked", () => { adminBackdrop.hidden = true; adminForm.reset(); });
document.getElementById("adminResetMode").addEventListener("click", () => {
  if (busy) return;
  resetting = !resetting;
  adminForm.reset();
  adminMessage.textContent = resetting ? "输入需要恢复的管理员账号及新密码。完成系统验证后，该账号的所有旧会话都会退出。" : "";
  updateMode();
});
