// Color pickers beside hex code fields: picking a color fills in its hex code, and a
// valid hex code typed into the field moves the picker.
(() => {
  function normalize(value) {
    let digits = value.trim().replace(/^#/, "").toLowerCase();
    if (/^[0-9a-f]{3}$/.test(digits)) digits = digits.replace(/./g, "$&$&");
    return /^[0-9a-f]{6}$/.test(digits) ? `#${digits}` : null;
  }

  document.querySelectorAll("[data-color-picker]").forEach((picker) => {
    const field = document.getElementById(picker.dataset.colorPicker);
    if (!field) return;
    picker.addEventListener("input", () => {
      field.value = picker.value;
    });
    field.addEventListener("input", () => {
      const color = normalize(field.value);
      if (color && color !== picker.value) picker.value = color;
    });
  });
})();
