// Optional offline page/assets for fault tests. Normal runs still use BASE_URL.
const fs = require("node:fs");
const path = require("node:path");
module.exports = async function offline(page, base) {
  if (!process.env.FORM_HTML) return;
  await page.route(`${base}/f/demo/`, (route) => route.fulfill({
    contentType: "text/html", body: fs.readFileSync(process.env.FORM_HTML, "utf8"),
  }));
  await page.route("**/static/**", (route) => {
    const filename = path.basename(new URL(route.request().url()).pathname);
    const script = ["form.js", "signature.js"].includes(filename);
    return route.fulfill({
      contentType: script ? "text/javascript" : "text/css",
      body: script ? fs.readFileSync(path.join(__dirname, "../../portal/static/portal", filename), "utf8") : "",
    });
  });
  // Each test can override this route when it exercises validation feedback.
  await page.route("**/f/demo/validate/", (route) => route.fulfill({ json: { fields: {} } }));
};
