// Admin > Email: show only the settings of the chosen provider. Without this script every
// section shows; the server checks only the settings of the chosen provider.
(() => {
  const provider = document.getElementById("id_provider");
  if (!provider) return;
  const sections = document.querySelectorAll("fieldset[class*='provider-']");

  function update() {
    sections.forEach((section) => {
      const name = [...section.classList].find((item) => item.startsWith("provider-"));
      section.hidden = Boolean(name) && name.slice("provider-".length) !== provider.value;
    });
  }

  provider.addEventListener("change", update);
  update();
})();
