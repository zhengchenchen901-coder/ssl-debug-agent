// Shared navigation for the existing browser regression assets.
export async function openInstancePage(page, id, view = "overview") {
  await page.locator('[data-page="instances"]').click();
  await page.locator(`.instance-name-button[data-id="${id}"]`).click();
  if (view !== "overview") await page.locator(`[data-page="instance:${view}"]`).click();
}

export async function openInstanceMenu(page, id) {
  await page.locator('[data-page="instances"]').click();
  await page.locator(`tr[data-instance-id="${id}"] > td .row-menu > summary`).click();
}

export async function openAdministratorSettings(page) {
  await page.locator('[data-page="environment"]').click();
  await page.locator('[data-management-tab="admin"]').click();
}
