"use strict";
(() => {
  const config = JSON.parse(
    document.getElementById("portal-configuration").textContent,
  );
  const form = document.getElementById("claim-form");
  const details = document.getElementById("details-panel");
  const review = document.getElementById("review-panel");
  const expensesContainer = document.getElementById("expenses");
  const errorBox = document.getElementById("form-error");
  const csrf = form.querySelector("[name=csrfmiddlewaretoken]").value;
  const canvas = document.getElementById("signature-canvas");
  const context = canvas.getContext("2d");
  const signatureStatus = document.getElementById("signature-status");
  const rows = [];
  const tripFields = document.getElementById("trip-fields");
  const receiptTravel = document.getElementById("receipt-travel");
  let signatureViewBusy = false,
    hasInk = false,
    drawing = false,
    submitting = false,
    accepted = false;

  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  }
  // The named input, or the first radio button of a group.
  function fieldElement(name) {
    const element = form.elements.namedItem(name);
    return (element instanceof RadioNodeList ? element[0] : element) || document.getElementById(name);
  }
  function showError(message, fields = {}) {
    const messages = Object.values(fields)
      .flat()
      .map((error) => error.message);
    errorBox.textContent = [message, ...messages].join(" ");
    errorBox.hidden = false;
    for (const [name, errors] of Object.entries(fields)) {
      const target = document.getElementById(`error-${name}`);
      if (target)
        target.textContent = errors.map((error) => error.message).join(" ");
      fieldElement(name)?.setAttribute("aria-invalid", "true");
    }
    const invalid = form.querySelector('[aria-invalid="true"]');
    if (invalid && invalid.getClientRects().length) invalid.focus();
    else errorBox.focus();
  }
  function clearErrors() {
    errorBox.hidden = true;
    document
      .querySelectorAll(".field-error")
      .forEach((element) => (element.textContent = ""));
    document
      .querySelectorAll("[aria-invalid]")
      .forEach((element) => element.removeAttribute("aria-invalid"));
  }
  async function api(url, options = {}) {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 15000);
    let response, result;
    try {
      response = await fetch(url, {
        credentials: "same-origin",
        ...options,
        signal: controller.signal,
        headers: {
          "X-CSRFToken": csrf,
          "X-Draft-Token": config.token,
          ...options.headers,
        },
      });
      result = await response.json();
    } catch {
      if (response && !response.ok) {
        result = {
          error: [404, 410].includes(response.status)
            ? "Die Sitzung oder Datei ist nicht mehr verfügbar. Bitte öffne das Formular erneut."
            : "Die Anfrage konnte nicht verarbeitet werden.",
        };
      } else {
        const error = new Error(
          "Die Verbindung wurde unterbrochen. Bitte versuche es erneut.",
        );
        error.retryable = true;
        throw error;
      }
    } finally {
      clearTimeout(deadline);
    }
    if (!response.ok) {
      const error = new Error(
        result.error || "Die Anfrage ist fehlgeschlagen.",
      );
      error.fields = result.fields;
      error.status = response.status;
      error.retryable =
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 500;
      throw error;
    }
    return result;
  }
  const touched = new Set();
  let validationTimer, validationVersion = 0, validationRequest = 0;
  function fieldFeedback(element, message) {
    const target = document.getElementById(
      element.dataset.errorId || `error-${element.name}`,
    );
    if (target) target.textContent = message;
    if (message) element.setAttribute("aria-invalid", "true");
    else element.removeAttribute("aria-invalid");
  }
  function localFeedback(element) {
    if (element.disabled) return "";
    let message = element.validationMessage;
    if (element.required && element.type !== "radio" && !element.value.trim())
      message = "Bitte fülle dieses Feld aus.";
    if (element.dataset.field === "amount") {
      const amount = cents(element.value);
      if (amount === null || amount <= 0n)
        message = "Bitte gib einen positiven Betrag in Euro ein, z. B. 12,50.";
    }
    return message;
  }
  function detailData() {
    const data = {};
    for (const element of details.querySelectorAll("[name]")) {
      if (element.type === "radio" && !element.checked) continue;
      data[element.name] = element.value;
    }
    return {
      ...data,
      draft_id: config.draft_id,
      expenses: expenseData(),
      is_trip: Boolean(tripFields && !form.elements.trip_destination.disabled),
    };
  }
  function expenseData() {
    return rows.map((row) => ({
      id: row.id, kind: row.kind, ...rowData(row),
      uploads: row.files.filter((file) => file.id).map((file) => file.id),
    }));
  }
  async function validateDetails(all = false) {
    const version = validationVersion, request = ++validationRequest;
    let fields = {};
    if (!config.preview) {
      try {
        const result = await api(config.validate_url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(detailData()),
        });
        fields = result.fields;
      } catch (error) {
        // Background checks stay quiet on connection failures. Review must retry.
        if (all && version === validationVersion) showError(error.message);
        return false;
      }
    }
    if (version !== validationVersion || request !== validationRequest || details.hidden)
      return false;
    let valid = true;
    for (const element of details.querySelectorAll("input,textarea,select")) {
      if (["file", "hidden"].includes(element.type)) continue;
      if (!all && !touched.has(element.name || element.id)) continue;
      const message = element.disabled ? "" :
        fields[element.name || element.id]?.map((error) => error.message).join(" ") ||
        localFeedback(element);
      fieldFeedback(element, message);
      if (message) valid = false;
    }
    for (const row of rows) {
      const target = document.getElementById(`error-expense-${row.id}-__all__`);
      if (all || target.textContent)
        target.textContent = fields[`expense-${row.id}-__all__`]?.map((error) => error.message).join(" ") || "";
    }
    document.getElementById("error-__all__").textContent = rows.length
      ? fields.__all__?.map((error) => error.message).join(" ") || "" : "";
    if (all && Object.keys(fields).length) {
      showError("Bitte prüfe die markierten Angaben.", fields);
      valid = false;
    }
    return valid;
  }
  function scheduleValidation(event) {
    const element = event.target;
    if (!element.matches("input,textarea,select") || element.type === "file") return;
    touched.add(element.name || element.id);
    // Recheck fields whose rules depend on the changed value.
    const dependencies = {
      full_name: ["account_holder"], country: ["postal_code"],
      iban: ["bic"], trip_start: ["trip_end"],
    };
    for (const name of dependencies[element.name] || []) {
      if (name === "bic" || form.elements.namedItem(name)?.value) touched.add(name);
    }
    const row = element.closest(".expense-card");
    if (row && ["travel_date", "round_trip"].includes(element.dataset.field)) {
      touched.add(row.querySelector('[data-field="return_date"]').id);
    }
    validationVersion++;
    clearTimeout(validationTimer);
    validationTimer = setTimeout(() => validateDetails(), 650);
  }
  details.addEventListener("input", scheduleValidation);
  details.addEventListener("change", scheduleValidation);
  const amountFormat = new RegExp(`^(?:${config.amount_pattern})$`);
  function money(cents) {
    return new Intl.NumberFormat("de-DE", {
      style: "currency",
      currency: "EUR",
    }).format(Number(cents) / 100);
  }
  // An exact EUR amount in cents, or null when the server would reject it.
  function cents(value) {
    if (!amountFormat.test(value.trim())) return null;
    const [whole, fraction = ""] = value.trim().replace(",", ".").split(".");
    return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0") || "0");
  }
  const rateCents = config.mileage_rate ? cents(config.mileage_rate) : null;
  function rowData(row) {
    return Object.fromEntries(
      [...row.element.querySelectorAll("[data-field]")].map((element) => [
        element.dataset.field,
        element.type === "checkbox" ? element.checked : element.value,
      ]),
    );
  }
  function updateMileage(row) {
    if (row.kind !== "mileage") return;
    const data = rowData(row);
    const returnDate = row.element.querySelector('[data-field="return_date"]');
    row.element.querySelector(".return-date").hidden = !data.round_trip;
    returnDate.disabled = !data.round_trip;
    returnDate.required = data.round_trip;
    returnDate.min = data.travel_date;
    returnDate.setCustomValidity(
      data.round_trip && data.return_date && data.return_date < data.travel_date
        ? "Das Rückfahrtdatum darf nicht vor der Hinfahrt liegen."
        : "",
    );
  }
  // The row's amount in cents; mileage is distance × rate, as on the server.
  function rowAmount(row) {
    const data = rowData(row);
    if (row.kind !== "mileage") return cents(data.amount);
    const distance = data.distance_km.trim();
    if (!/^\d{1,5}$/.test(distance)) return null;
    const kilometres = BigInt(distance);
    if (kilometres < 1n || kilometres > BigInt(config.max_distance_km))
      return null;
    return kilometres * (data.round_trip ? 2n : 1n) * rateCents;
  }
  function updateTotals() {
    let total = 0n;
    const references = new Set();
    let duplicate = false;
    rows.forEach((row) => {
      const data = rowData(row),
        amount = rowAmount(row);
      if (amount !== null) total += amount;
      if (row.kind === "mileage") {
        row.element.querySelector(".mileage-amount").textContent =
          amount === null
            ? ""
            : `${data.round_trip ? Number(data.distance_km) * 2 : data.distance_km} km × ${money(rateCents)} = ${money(amount)}`;
        return;
      }
      const reference = data.receipt_reference
        .trim()
        .toLocaleLowerCase("de-DE");
      if (reference && references.has(reference)) duplicate = true;
      references.add(reference);
    });
    const target = document.getElementById("totals");
    target.replaceChildren();
    const line = node("div");
    line.append(node("span", "Summe", "total-caption"), node("span", money(total)));
    target.append(line);
    if (duplicate)
      target.append(
        node(
          "p",
          "Hinweis: Eine Belegreferenz wird mehrfach verwendet. Bitte prüfe die Zuordnung.",
          "muted",
        ),
      );
    return total;
  }
  function updateTravel() {
    if (!tripFields) return;
    const hasMileage = rows.some((row) => row.kind === "mileage");
    receiptTravel.hidden = !rows.length || hasMileage;
    const needed =
      !receiptTravel.hidden &&
      (config.travel === "required" || receiptTravel.open);
    for (const name of ["trip_destination", "trip_start", "trip_end"]) {
      const field = form.elements.namedItem(name);
      field.required = needed;
      field.disabled = !needed;
      if (!needed) fieldFeedback(field, "");
    }
  }
  receiptTravel?.addEventListener("toggle", () => {
    updateTravel();
    validationVersion++;
    clearTimeout(validationTimer);
    validationTimer = setTimeout(() => validateDetails(), 650);
  });
  const fullName = form.elements.namedItem("full_name");
  const accountHolder = form.elements.namedItem("account_holder");
  let accountHolderEdited = false;
  fullName.addEventListener("input", () => {
    if (!accountHolderEdited) accountHolder.value = fullName.value;
  });
  accountHolder.addEventListener("input", () => {
    accountHolderEdited = accountHolder.value !== "";
  });
  function arrangeRows() {
    validationVersion++;
    clearTimeout(validationTimer);
    if (touched.size) validationTimer = setTimeout(() => validateDetails(), 650);
    rows.forEach((row, index) => {
      expensesContainer.append(row.element);
      row.element.querySelector(".row-number").textContent = index + 1;
      row.element.querySelector('[data-action="up"]').disabled = index === 0;
      row.element.querySelector('[data-action="down"]').disabled =
        index === rows.length - 1;
    });
    for (const id of ["add-expense", "add-mileage"]) {
      const button = document.getElementById(id);
      if (button) button.disabled = rows.length >= config.limits.expenses;
    }
    const empty = document.getElementById("expenses-empty");
    empty.hidden = rows.length > 0;
    empty.textContent = config.mileage_rate
      ? "Lege eine Auslage mit Beleg oder eine Kilometererstattung an."
      : "Lege eine Auslage mit Beleg an.";
    updateTotals();
    updateTravel();
  }
  function renderFiles(row) {
    row.element.querySelector('[data-action="remove"]').disabled =
      row.uploading || row.removing;
    row.element.querySelector(".receipt-input").disabled =
      row.uploading || row.removing;
    const list = row.element.querySelector(".file-list");
    list.replaceChildren();
    row.files.forEach((file, index) => {
      const item = node("li");
      item.append(
        node("span", file.name, "file-name"),
        node(
          "span",
          file.message ||
            {
              ready: "Geprüft",
              pending: "Wird geprüft …",
              uploading: "Wird hochgeladen …",
              failed: "Prüfung fehlgeschlagen",
            }[file.state],
          `file-status ${file.state}`,
        ),
      );
      for (const [label, delta] of [
        ["↑", -1],
        ["↓", 1],
      ]) {
        const button = node("button", label);
        button.type = "button";
        button.setAttribute(
          "aria-label",
          `Beleg ${delta === -1 ? "nach oben" : "nach unten"} verschieben`,
        );
        button.disabled =
          row.removing || index + delta < 0 || index + delta >= row.files.length;
        button.addEventListener("click", () => {
          [row.files[index], row.files[index + delta]] = [
            row.files[index + delta],
            row.files[index],
          ];
          renderFiles(row);
        });
        item.append(button);
      }
      const remove = node("button", "Entfernen");
      remove.type = "button";
      remove.disabled = row.removing || file.state === "uploading";
      remove.addEventListener("click", async () => {
        if (row.removing) return;
        row.removing = true;
        renderFiles(row);
        try {
          await deleteFile(file);
          row.files.splice(row.files.indexOf(file), 1);
        } catch (error) {
          showError(error.message);
        } finally {
          row.removing = false;
          renderFiles(row);
        }
      });
      item.append(remove);
      if (file.state === "pending" && !file.polling) {
        const retry = node("button", "Status erneut prüfen");
        retry.type = "button";
        retry.disabled = row.removing;
        retry.addEventListener("click", async () => {
          file.polling = true;
          renderFiles(row);
          try {
            Object.assign(
              file,
              await pollUpload(file, (update) => {
                Object.assign(file, update);
                renderFiles(row);
              }),
            );
          } catch (error) {
            file.state = "failed";
            file.message = error.message;
          } finally {
            file.polling = false;
            renderFiles(row);
          }
        });
        item.append(retry);
      }
      list.append(item);
    });
  }
  async function deleteFile(file) {
    if (!file.delete_url) return;
    try {
      await api(file.delete_url, { method: "DELETE" });
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
  async function removeRow(row) {
    if (row.uploading || row.removing) return;
    row.removing = true;
    renderFiles(row);
    try {
      for (const file of [...row.files]) {
        await deleteFile(file);
        row.files.splice(row.files.indexOf(file), 1);
        renderFiles(row);
      }
      rows.splice(rows.indexOf(row), 1);
      row.element.remove();
      arrangeRows();
    } catch (error) {
      showError(error.message);
    } finally {
      row.removing = false;
      renderFiles(row);
    }
  }
  async function uploadFile(blob, kind, expenseId, onUpdate) {
    if (config.preview)
      throw new Error("Vorschau: Hochladen ist nicht möglich.");
    const data = new FormData();
    for (const [key, value] of Object.entries({
      draft_id: config.draft_id,
      token: config.token,
      kind,
      expense_id: expenseId || "",
    }))
      data.append(key, value);
    data.append("file", blob, blob.name || "signature.png");
    const result = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", config.upload_url);
      xhr.setRequestHeader("X-CSRFToken", csrf);
      xhr.timeout = 120000;
      xhr.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable)
          onUpdate?.({
            state: "uploading",
            message: `Upload ${Math.round((event.loaded / event.total) * 100)} %`,
          });
      });
      xhr.onload = () => {
        let value;
        try {
          value = JSON.parse(xhr.responseText);
        } catch {
          reject(
            new Error(
              "Der Upload ist fehlgeschlagen. Bitte versuche es erneut.",
            ),
          );
          return;
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(value);
        else reject(new Error(value.error || "Der Upload ist fehlgeschlagen."));
      };
      xhr.onerror = xhr.ontimeout = () =>
        reject(
          new Error("Der Upload wurde unterbrochen. Bitte versuche es erneut."),
        );
      xhr.send(data);
    });
    return pollUpload(result, onUpdate);
  }
  async function pollUpload(result, onUpdate) {
    onUpdate?.({ ...result, state: "pending", message: "Wird geprüft …" });
    for (let attempt = 0; attempt < 36; attempt++) {
      let status;
      try {
        status = await api(result.status_url);
      } catch (error) {
        if (!error.retryable) throw error;
        status = {
          state: "pending",
          message:
            "Die Verbindung ist verzögert. Die Prüfung bleibt gespeichert.",
        };
      }
      onUpdate?.(status);
      if (status.state === "ready") return { ...result, ...status };
      if (status.state === "failed") throw new Error(status.message);
      const delay = Math.min(10000, 2000 * 1.4 ** attempt);
      await new Promise((resolve) =>
        setTimeout(resolve, delay + Math.random() * delay * 0.2),
      );
    }
    const delayed = {
      ...result,
      state: "pending",
      message:
        "Die Prüfung dauert länger. Bitte prüfe den Status später erneut; die Datei bleibt gespeichert.",
    };
    onUpdate?.(delayed);
    return delayed;
  }
  function addRow(kind = "receipt") {
    if (rows.length >= config.limits.expenses) return;
    clearErrors();
    const element = document
      .getElementById(kind === "mileage" ? "mileage-template" : "expense-template")
      .content.firstElementChild.cloneNode(true);
    const row = { id: crypto.randomUUID(), kind, files: [], element };
    element.querySelectorAll("[data-field]").forEach((field) => {
      field.id = `expense-${row.id}-${field.dataset.field}`;
      const error = node("p", "", "field-error");
      error.id = `error-${field.id}`;
      error.setAttribute("aria-live", "polite");
      field.dataset.errorId = error.id;
      field.setAttribute("aria-describedby", error.id);
      field.closest(".field").append(error);
    });
    const rowError = node("p", "", "field-error");
    rowError.id = `error-expense-${row.id}-__all__`;
    rowError.setAttribute("aria-live", "polite");
    element.append(rowError);
    if (kind === "mileage") {
      element.querySelector('[data-field="travel_date"]').value = config.trip_start;
      element.querySelector('[data-field="return_date"]').value = config.trip_end;
      updateMileage(row);
    }
    element.addEventListener("input", () => {
      updateMileage(row);
      updateTotals();
    });
    element.querySelectorAll("[data-action]").forEach((button) =>
      button.addEventListener("click", () => {
        const index = rows.indexOf(row);
        if (button.dataset.action === "remove") {
          void removeRow(row);
          return;
        } else {
          const other = index + (button.dataset.action === "up" ? -1 : 1);
          if (other < 0 || other >= rows.length) return;
          [rows[index], rows[other]] = [rows[other], rows[index]];
        }
        arrangeRows();
      }),
    );
    element
      .querySelector(".receipt-input")
      .addEventListener("change", async (event) => {
        if (row.uploading || row.removing) return;
        const selected = [...event.target.files];
        event.target.value = "";
        if (
          selected.length + row.files.length >
          config.limits.files_per_expense
        ) {
          showError(config.messages.files_per_expense_exceeded);
          return;
        }
        const existingBytes = rows
          .flatMap((row) => row.files)
          .reduce((sum, file) => sum + file.size, 0);
        if (
          existingBytes + selected.reduce((sum, file) => sum + file.size, 0) >
          config.limits.submission_bytes
        ) {
          showError(config.messages.submission_too_large);
          return;
        }
        row.uploading = true;
        renderFiles(row);
        try {
          for (const selectedFile of selected) {
            if (
              !selectedFile.size ||
              selectedFile.size > config.limits.receipt_bytes
            ) {
              showError(config.messages.receipt_size);
              continue;
            }
            const file = {
              name: selectedFile.name,
              size: selectedFile.size,
              state: "uploading",
              polling: true,
            };
            row.files.push(file);
            renderFiles(row);
            try {
              Object.assign(
                file,
                await uploadFile(selectedFile, "receipt", row.id, (update) => {
                  Object.assign(file, update);
                  renderFiles(row);
                }),
              );
            } catch (error) {
              file.state = "failed";
              file.message = error.message;
            }
            file.polling = false;
            renderFiles(row);
          }
        } finally {
          row.uploading = false;
          renderFiles(row);
        }
      });
    rows.push(row);
    arrangeRows();
  }
  document
    .getElementById("add-expense")
    .addEventListener("click", () => addRow("receipt"));
  document
    .getElementById("add-mileage")
    ?.addEventListener("click", () => addRow("mileage"));
  arrangeRows();

  const signatureControls = [
    "signature-file", "clear-signature", "edit-button", "submit-button", "retry-signature",
  ];
  const signature = PortalSignature.createSignature({
    upload: (blob, update) => uploadFile(blob, "signature", null, update),
    poll: pollUpload,
    remove: (url) => api(url, { method: "DELETE" }),
    onChange(status) {
      document.getElementById("retry-signature").hidden = !status.canRetry;
      signatureControls.forEach((id) => {
        document.getElementById(id).disabled = status.busy || signatureViewBusy || submitting;
      });
      if (status.state === "replacing") {
        resetSignatureView();
        signatureStatus.textContent = "Unterschrift wird hochgeladen und geprüft …";
      } else if (status.state === "ready") signatureStatus.textContent = "Unterschrift geprüft.";
      else if (status.message) signatureStatus.textContent = status.message;
    },
  });
  function resetSignatureView() {
    context.clearRect(0, 0, canvas.width, canvas.height);
    hasInk = false;
    document.getElementById("signature-file").value = "";
    signatureStatus.textContent = config.messages.signature_hint;
  }
  async function clearSignature() {
    await signature.clear();
    resetSignatureView();
  }
  async function signatureAction(action) {
    if (signature.status().busy || signatureViewBusy || submitting) return false;
    clearErrors();
    signatureViewBusy = true;
    signatureControls.forEach((id) => (document.getElementById(id).disabled = true));
    try {
      await action();
      return true;
    } catch (error) {
      showError(error.message);
      signatureStatus.textContent = "Bitte lösche die Unterschrift oder versuche es erneut.";
      return false;
    } finally {
      signatureViewBusy = false;
      signatureControls.forEach((id) => {
        document.getElementById(id).disabled = signature.status().busy || submitting;
      });
    }
  }
  function position(event) {
    const bounds = canvas.getBoundingClientRect();
    return [
      ((event.clientX - bounds.left) * canvas.width) / bounds.width,
      ((event.clientY - bounds.top) * canvas.height) / bounds.height,
    ];
  }
  canvas.addEventListener("pointerdown", (event) => {
    if (submitting || signatureViewBusy || signature.status().busy) return;
    if (signature.status().state !== "empty" && !hasInk)
      context.clearRect(0, 0, canvas.width, canvas.height);
    signature.invalidate();
    canvas.setPointerCapture(event.pointerId);
    const [x, y] = position(event);
    context.beginPath();
    context.moveTo(x, y);
    context.lineWidth = 3;
    context.lineCap = "round";
    context.strokeStyle = "#134e4a";
    drawing = true;
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!drawing) return;
    const [x, y] = position(event);
    context.lineTo(x, y);
    context.stroke();
    hasInk = true;
    signatureStatus.textContent = "Unterschrift gezeichnet.";
  });
  canvas.addEventListener("pointerup", () => (drawing = false));
  canvas.addEventListener("pointercancel", () => (drawing = false));
  document.getElementById("retry-signature").addEventListener("click", () =>
    signatureAction(() => signature.retry()),
  );
  document
    .getElementById("clear-signature")
    .addEventListener("click", () => signatureAction(clearSignature));
  document
    .getElementById("signature-file")
    .addEventListener("change", async (event) => {
      const file = event.target.files[0];
      if (!file) return;
      if (file.size > config.limits.signature_bytes || !file.size) {
        showError(config.messages.signature_too_large);
        return;
      }
      await signatureAction(async () => {
        signatureStatus.textContent = "Unterschrift wird hochgeladen und geprüft …";
        await signature.replace(file);
        resetSignatureView();
        signatureStatus.textContent = signature.status().state === "ready"
          ? `Unterschrift geprüft: ${file.name}` : signature.status().message;
        const image = await createImageBitmap(file);
        const scale = Math.min(
          canvas.width / image.width,
          canvas.height / image.height,
        );
        context.drawImage(
          image,
          (canvas.width - image.width * scale) / 2,
          (canvas.height - image.height * scale) / 2,
          image.width * scale,
          image.height * scale,
        );
        image.close();
      });
    });
  document.getElementById("review-button").addEventListener("click", async () => {
    const button = document.getElementById("review-button");
    if (button.disabled) return;
    clearTimeout(validationTimer);
    clearErrors();
    if (!rows.length) {
      showError(config.messages.expense_count);
      document.getElementById("add-expense").focus();
      return;
    }
    button.disabled = true;
    let valid;
    try {
      valid = await validateDetails(true);
    } finally {
      button.disabled = false;
    }
    if (!valid) {
      const invalid = details.querySelector('[aria-invalid="true"]');
      if (invalid) invalid.focus();
      return;
    }
    if (
      rows.some(
        (row) =>
          row.uploading || row.removing ||
          (row.kind !== "mileage" && !row.files.length) ||
          row.files.some((file) => file.state !== "ready"),
      )
    ) {
      showError(
        "Jede Auslage benötigt mindestens einen Beleg, und alle Dateien müssen geprüft sein.",
      );
      return;
    }
    if (
      rows.some((row) => {
        const amount = rowAmount(row);
        return amount === null || amount <= 0n;
      })
    ) {
      showError(
        "Bitte gib für jede Position einen positiven Betrag in Euro bzw. eine Entfernung in ganzen Kilometern ein.",
      );
      return;
    }
    if (
      rows
        .flatMap((row) => row.files)
        .reduce((sum, file) => sum + (file.pages || 0), 0) >
      config.limits.claim_pages
    ) {
      showError(config.messages.claim_pages);
      return;
    }
    const content = document.getElementById("review-content");
    content.replaceChildren();
    const descriptions = node("dl");
    const travel = tripFields && !form.elements.trip_destination.disabled;
    for (const [name, label] of [
      ["full_name", "Name"],
      ["email", "E-Mail"],
      ["street", "Straße und Hausnummer"],
      ["postal_code", "PLZ"],
      ["city", "Ort"],
      ["country", "Land"],
      ["account_holder", "Kontoinhaber:in"],
      ["iban", "IBAN"],
      ["bic", "BIC"],
      ["purpose", "Anlass/Projektbezug"],
      ["purpose_details", "Ergänzung"],
      ["trip_destination", "Zielort"],
      ["trip_start", "Reisebeginn"],
      ["trip_end", "Reiseende"],
    ]) {
      if (name.startsWith("trip_") && !travel) continue;
      const element = form.elements.namedItem(name);
      const value =
        element instanceof HTMLSelectElement
          ? element.selectedOptions[0]?.text
          : element?.type === "date"
            ? element.value.split("-").reverse().join(".")
            : element?.value;
      if (value) descriptions.append(node("dt", label), node("dd", value));
    }
    content.append(descriptions);
    rows.forEach((row, index) => {
      const data = rowData(row),
        item = node("div", undefined, "review-expense");
      const amount = money(rowAmount(row));
      if (row.kind === "mileage")
        item.append(
          node(
            "p",
            `${index + 1}. Fahrt ${data.route_from} – ${data.route_to}${data.round_trip ? " und zurück" : ""} · ${amount}`,
            "review-title",
          ),
          node(
            "p",
            `Hinfahrt: ${data.travel_date.split("-").reverse().join(".")}${data.round_trip ? ` · Rückfahrt: ${data.return_date.split("-").reverse().join(".")}` : ""} · Kennzeichen: ${data.vehicle_registration}`,
          ),
        );
      else
        item.append(
          node("p", `${index + 1}. ${data.merchant} · ${amount}`, "review-title"),
          node(
            "p",
            data.receipt_reference.trim() ? `Referenz ${data.receipt_reference}` : "",
          ),
        );
      if (row.files.length)
        item.append(node("small", row.files.map((file) => file.name).join(" · ")));
      content.append(item);
    });
    content.append(node("p", `Summe: ${money(updateTotals())}`, "totals"));
    details.hidden = true;
    review.hidden = false;
    review.querySelector("h2").focus();
    document.getElementById("step-details").classList.remove("active");
    document.getElementById("step-details").removeAttribute("aria-current");
    document.getElementById("step-review").classList.add("active");
    document.getElementById("step-review").setAttribute("aria-current", "step");
    review.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  document.getElementById("edit-button").addEventListener("click", async () => {
    clearErrors();
    if (!(await signatureAction(clearSignature))) return;
    form.elements.declaration.checked = false;
    form.elements.privacy_acknowledged.checked = false;
    details.hidden = false;
    review.hidden = true;
    document.getElementById("step-details").classList.add("active");
    document
      .getElementById("step-details")
      .setAttribute("aria-current", "step");
    document.getElementById("step-review").classList.remove("active");
    document.getElementById("step-review").removeAttribute("aria-current");
    details.scrollIntoView({ behavior: "smooth" });
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submitting || signatureViewBusy || signature.status().busy || review.hidden) return;
    clearErrors();
    if (
      !form.elements.declaration.checked ||
      !form.elements.privacy_acknowledged.checked
    ) {
      showError("Bitte bestätige die Erklärung und den Datenschutzhinweis.");
      return;
    }
    if (!hasInk && !["ready", "pending"].includes(signature.status().state)) {
      showError("Bitte unterschreibe oder lade eine Unterschrift hoch.");
      return;
    }
    submitting = true;
    const button = document.getElementById("submit-button");
    button.textContent = "Wird eingereicht …";
    review
      .querySelectorAll("button,input")
      .forEach((element) => (element.disabled = true));
    try {
      const signatureId = await signature.ensureReady(() => new Promise((resolve) =>
        canvas.toBlob(resolve, "image/png"),
      ));
      const data = {
        ...detailData(),
        token: config.token,
        signature: signatureId,
        declaration: true,
        privacy_acknowledged: true,
        website: form.elements.website.value,
      };
      const result = await api(config.submit_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      accepted = true;
      window.location.assign(result.receipt_url);
    } catch (error) {
      if (error.fields && Object.keys(error.fields).length) {
        try {
          await clearSignature();
        } catch {
          signature.invalidate();
          resetSignatureView();
        }
        form.elements.declaration.checked = false;
        form.elements.privacy_acknowledged.checked = false;
        details.hidden = false;
        review.hidden = true;
        document.getElementById("step-details").classList.add("active");
        document
          .getElementById("step-details")
          .setAttribute("aria-current", "step");
        document.getElementById("step-review").classList.remove("active");
        document.getElementById("step-review").removeAttribute("aria-current");
      }
      showError(error.message, error.fields);
      submitting = false;
      review
        .querySelectorAll("button,input")
        .forEach((element) => (element.disabled = false));
      button.textContent = "Antrag einreichen →";
    }
  });
  window.addEventListener("beforeunload", (event) => {
    if (
      !accepted &&
      (rows.some((row) => row.files.length) || form.elements.full_name.value)
    ) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
})();
