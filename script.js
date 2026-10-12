(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const fileInput = $("file-input");
  const dropZone = $("drop-zone");
  const extractButton = $("extract-btn");
  const status = $("status");
  const results = $("results");
  let selectedFile = null;
  let htmlOutput = "";
  let cssOutput = "";

  function setStatus(message, kind = "") {
    status.textContent = message;
    status.className = "status" + (kind ? " " + kind : "");
  }

  function chooseFile(file) {
    if (!file) return;
    if (!/\.(mhtml?|mht)$/i.test(file.name) && !/mhtml|mimearchive|rfc822/i.test(file.type)) {
      selectedFile = null;
      extractButton.disabled = true;
      $("file-name").textContent = "Formato no admitido. Selecciona un archivo .mhtml o .mht.";
      setStatus("El archivo debe tener extensión .mhtml o .mht.", "error");
      return;
    }
    selectedFile = file;
    $("file-name").textContent = file.name + " · " + formatBytes(file.size);
    extractButton.disabled = false;
    results.hidden = true;
    setStatus("Archivo listo para procesar.");
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(2) + " MB";
  }

  function parseHeaders(raw) {
    const normalized = raw.replace(/\r?\n[ \t]+/g, " ");
    const lines = normalized.split(/\r?\n/);
    const headers = {};
    for (const line of lines) {
      const colon = line.indexOf(":");
      if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
    return headers;
  }

  function decodeQuotedPrintable(input, charset) {
    const cleaned = input.replace(/=\r?\n/g, "");
    const bytes = [];
    for (let i = 0; i < cleaned.length; i++) {
      if (cleaned[i] === "=" && /^[0-9a-f]{2}$/i.test(cleaned.slice(i + 1, i + 3))) {
        bytes.push(parseInt(cleaned.slice(i + 1, i + 3), 16));
        i += 2;
      } else {
        const code = cleaned.charCodeAt(i);
        if (code <= 255) bytes.push(code);
        else bytes.push(...new TextEncoder().encode(cleaned[i]));
      }
    }
    try { return new TextDecoder(charset || "utf-8").decode(new Uint8Array(bytes)); }
    catch (_) { return new TextDecoder("utf-8").decode(new Uint8Array(bytes)); }
  }

  function decodeBody(body, headers) {
    const transfer = (headers["content-transfer-encoding"] || "").toLowerCase();
    const type = headers["content-type"] || "";
    const charsetMatch = type.match(/charset\s*=\s*["']?([^;"'\s]+)/i);
    const charset = charsetMatch ? charsetMatch[1] : "utf-8";
    if (transfer.includes("base64")) {
      const compact = body.replace(/[\r\n\t ]/g, "");
      const binary = atob(compact);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      try { return new TextDecoder(charset).decode(bytes); }
      catch (_) { return new TextDecoder("utf-8").decode(bytes); }
    }
    if (transfer.includes("quoted-printable")) return decodeQuotedPrintable(body, charset);
    return body;
  }

  function splitMimeParts(source) {
    const firstBreak = source.search(/\r?\n\r?\n/);
    if (firstBreak < 0) throw new Error("El archivo no parece contener encabezados MIME válidos.");
    const topHeaders = parseHeaders(source.slice(0, firstBreak));
    const boundaryMatch = (topHeaders["content-type"] || "").match(/boundary\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s]+))/i);
    if (!boundaryMatch) {
      if (/<html[\s>]/i.test(source)) return [{ headers: { "content-type": "text/html; charset=utf-8" }, body: source }];
      throw new Error("No se encontró el límite MIME (boundary) en el archivo.");
    }
    const boundary = boundaryMatch[1] || boundaryMatch[2] || boundaryMatch[3];
    const chunks = source.split("--" + boundary);
    const parts = [];
    for (let chunk of chunks.slice(1)) {
      chunk = chunk.replace(/^\r?\n/, "").replace(/\r?\n?--\s*$/, "");
      const separator = chunk.search(/\r?\n\r?\n/);
      if (separator < 0) continue;
      const headers = parseHeaders(chunk.slice(0, separator));
      let body = chunk.slice(separator).replace(/^\r?\n\r?\n/, "");
      body = body.replace(/\r?\n$/, "");
      if (body.trim()) parts.push({ headers, body: decodeBody(body, headers) });
    }
    return parts;
  }

  function extractDocument(parts, original) {
    const htmlPart = parts.find((part) => (part.headers["content-type"] || "").toLowerCase().includes("text/html"));
    let html = htmlPart ? htmlPart.body : "";
    if (!html && /<html[\s>]/i.test(original)) html = original;
    if (!html) throw new Error("No se encontró una parte HTML en el archivo MHTML.");

    const styles = [];
    if ($("extract-inline").checked) {
      html = html.replace(/<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi, (_, attrs, content) => {
        styles.push(content.trim());
        return "";
      });
      for (const part of parts) {
        const type = (part.headers["content-type"] || "").toLowerCase();
        if (type.includes("text/css")) styles.push(part.body.trim());
      }
    }
    const css = styles.filter(Boolean).join("\n\n/* Hoja de estilos extraída */\n\n");
    if (!$("keep-html").checked) {
      html = "<!doctype html><html lang=\"es\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Documento extraído</title></head><body></body></html>";
    } else {
      if (!/<head\b/i.test(html)) html = "<!doctype html><html><head><meta charset=\"utf-8\"></head><body>" + html + "</body></html>";
      if (css) {
        if (/<\/head\s*>/i.test(html)) html = html.replace(/<\/head\s*>/i, '<link rel="stylesheet" href="style.css">\n</head>');
        else html = '<link rel="stylesheet" href="style.css">\n' + html;
      }
    }
    return { html, css };
  }

  function download(name, content, type) {
    const blob = new Blob([content], { type: type + ";charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  fileInput.addEventListener("change", () => chooseFile(fileInput.files[0]));
  dropZone.addEventListener("dragover", (event) => { event.preventDefault(); dropZone.classList.add("dragging"); });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragging"));
  dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropZone.classList.remove("dragging");
    chooseFile(event.dataTransfer.files[0]);
  });

  extractButton.addEventListener("click", async () => {
    if (!selectedFile) return;
    extractButton.disabled = true;
    setStatus("Leyendo y analizando el archivo…");
    try {
      const source = await selectedFile.text();
      const parts = splitMimeParts(source);
      const output = extractDocument(parts, source);
      htmlOutput = output.html;
      cssOutput = output.css;
      $("html-info").textContent = formatBytes(new Blob([htmlOutput]).size);
      $("css-info").textContent = cssOutput ? formatBytes(new Blob([cssOutput]).size) : "No se encontraron estilos CSS; se descargará un archivo vacío.";
      $("summary").textContent = parts.length + " partes MIME";
      $("preview").srcdoc = htmlOutput.replace(/<link\b[^>]*href=["']style\.css["'][^>]*>/i, "<style>" + cssOutput.replace(/<\/style/gi, "<\\/style") + "</style>");
      results.hidden = false;
      setStatus("Extracción completada. Descarga ambos archivos y guárdalos en la misma carpeta.", "success");
    } catch (error) {
      console.error(error);
      setStatus(error && error.message ? error.message : "No se pudo procesar el archivo.", "error");
    } finally {
      extractButton.disabled = !selectedFile;
    }
  });

  $("download-html").addEventListener("click", () => download("index.html", htmlOutput, "text/html"));
  $("download-css").addEventListener("click", () => download("style.css", cssOutput, "text/css"));
})();