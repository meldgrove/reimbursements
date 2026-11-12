/* Synthetic upload fixtures, drawn by the browser: a receipt image (train.png), a
 * two-page receipt PDF (hotel.pdf) and a signature (signature.png).
 * Run `node fixtures.cjs DIRECTORY` to write them for the scripts that read FIXTURES_DIR.
 */
const fs = require("node:fs");
const path = require("node:path");

const RECEIPT = `
  <body style="margin:0">
    <main style="width:1000px;height:1400px;padding:60px;box-sizing:border-box;
                 background:white;font:36px sans-serif">
      <p>SYNTHETIC RECEIPT - TEST ONLY</p>
      <p>Rail ticket Hamburg - Berlin</p>
      <p>Total EUR 10.10</p>
    </main>
  </body>`;
const HOTEL = `
  <body style="font:24px sans-serif">
    <section style="break-after:page">
      <p>SYNTHETIC HOTEL INVOICE - TEST ONLY</p>
      <p>Page 1 of 2: one night, EUR 20.20</p>
    </section>
    <section><p>Page 2 of 2: payment confirmation</p></section>
  </body>`;
const SIGNATURE = `
  <body style="margin:0">
    <svg xmlns="http://www.w3.org/2000/svg" width="800" height="240"
         style="display:block;background:white">
      <polyline points="80,160 150,60 210,170 300,80 440,150 600,100"
                fill="none" stroke="#134e4a" stroke-width="5" />
    </svg>
  </body>`;

async function createFixtures(browser, directory) {
  fs.mkdirSync(directory, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 1400 } });
  try {
    await page.setContent(RECEIPT);
    await page.locator("main").screenshot({ path: path.join(directory, "train.png") });
    await page.setContent(HOTEL);
    await page.pdf({ path: path.join(directory, "hotel.pdf"), format: "A4" });
    await page.setContent(SIGNATURE);
    await page.locator("svg").screenshot({ path: path.join(directory, "signature.png") });
  } finally {
    await page.close();
  }
  return directory;
}

module.exports = { createFixtures };

if (require.main === module) {
  const directory = process.argv[2];
  if (!directory) throw new Error("Usage: node fixtures.cjs DIRECTORY");
  const { chromium } = require("playwright");
  (async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      console.log(`Wrote fixtures to ${await createFixtures(browser, directory)}`);
    } finally {
      await browser.close();
    }
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
