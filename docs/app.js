/* DMEPUMP TCI - WebAssembly (Pyodide) front-end glue.
 * Loads the compiled TCI engine wheel (python/dist/dmepump_tci_core-*.whl,
 * into Pyodide and drives it from plain HTML form inputs + Chart.js.
 */

const PYODIDE_INDEX_URL = "https://cdn.jsdelivr.net/pyodide/v314.0.6/full/";
const ENGINE_WHEEL_URL = "python/dist/dmepump_tci_core-1.0.0-py3-none-any.whl";

let pyodide = null;
let coreTci = null;
let modelInfo = null;
let lastResult = null;
let concChart = null;
let rateChart = null;

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Crosshair + info tooltip (mirrors the mouse-motion cursor/tooltip in the
// original Tkinter/Matplotlib app: a vertical line synced across both charts
// plus a floating box with Cp/Ce/Rate/Dose/Effect/Time at the nearest sample).
// ---------------------------------------------------------------------------
const crosshairState = { xMin: null, active: false };

const crosshairPlugin = {
  id: "crosshair",
  afterDraw(chart) {
    if (!crosshairState.active || crosshairState.xMin === null) return;
    const { ctx, chartArea, scales } = chart;
    const xPixel = scales.x.getPixelForValue(crosshairState.xMin);
    if (xPixel < chartArea.left || xPixel > chartArea.right) return;
    ctx.save();
    ctx.beginPath();
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(150, 160, 170, 0.85)";
    ctx.moveTo(xPixel, chartArea.top);
    ctx.lineTo(xPixel, chartArea.bottom);
    ctx.stroke();
    ctx.restore();
  },
};
Chart.register(crosshairPlugin);

// Shared with the dataset colors below so the tooltip swatches match the legend.
const SERIES_COLORS = { target: "#93a4b8", cp: "#4fb3ff", ce: "#35d488", rate: "#ff9f43", dose: "#c792ea", effect: "#ffd166" };

function setLoadingStatus(text, pct) {
  $("loading-status").textContent = text;
  if (pct !== undefined) $("loading-bar").value = pct;
}

function showError(err) {
  const panel = $("error-panel");
  panel.textContent = "Error: " + (err && err.message ? err.message : String(err));
  panel.classList.remove("hidden");
}

function clearError() {
  const panel = $("error-panel");
  panel.textContent = "";
  panel.classList.add("hidden");
}

// ---------------------------------------------------------------------------
// Pyodide bootstrap
// ---------------------------------------------------------------------------

async function initPyodide() {
  setLoadingStatus("Downloading Pyodide runtime\u2026", 10);
  pyodide = await loadPyodide({ indexURL: PYODIDE_INDEX_URL });

  setLoadingStatus("Loading numpy/scipy\u2026", 40);
  await pyodide.loadPackage(["numpy", "scipy"]);

  setLoadingStatus("Loading TCI engine\u2026", 70);
  // Compiled wheel (bytecode only, see build/build_wheel.py) - no .py source is fetched.
  await pyodide.loadPackage([ENGINE_WHEEL_URL]);

  setLoadingStatus("Initializing\u2026", 90);
  coreTci = pyodide.pyimport("core_tci");
  modelInfo = JSON.parse(coreTci.get_model_info_json());

  setLoadingStatus("Ready", 100);
  $("loading-panel").classList.add("hidden");
  $("app-panel").classList.remove("hidden");

  populateDrugSelect();
  addTargetRow(0, 3.0);
  updateUnitLabels();
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((err) => console.warn("Service worker registration failed:", err));
  });
}

// ---------------------------------------------------------------------------
// UI population
// ---------------------------------------------------------------------------

function populateDrugSelect() {
  const drugSelect = $("drug-select");
  drugSelect.innerHTML = "";
  Object.keys(modelInfo.drug_models).forEach((drug) => {
    const opt = document.createElement("option");
    opt.value = drug;
    opt.textContent = drug;
    drugSelect.appendChild(opt);
  });
  drugSelect.value = "Propofol";
  populateModelSelect();
}

function populateModelSelect() {
  const drug = $("drug-select").value;
  const modelSelect = $("model-select");
  modelSelect.innerHTML = "";
  modelInfo.drug_models[drug].forEach((model) => {
    const opt = document.createElement("option");
    opt.value = model;
    opt.textContent = model;
    modelSelect.appendChild(opt);
  });
  applyDrugDefaults();
  updateModelDescription();
}

function applyDrugDefaults() {
  const drug = $("drug-select").value;
  const drugConc = modelInfo.default_concentration[drug];
  $("drug-conc-input").value = drugConc;
  $("max-rate-input").value = +((modelInfo.default_max_rate[drug] / drugConc) * 60).toFixed(1);
  updateUnitLabels();
  applyPatientDefaults();
}

function applyPatientDefaults() {
  const drug = $("drug-select").value;
  const model = $("model-select").value;
  const key = `${drug}|${model}`;
  const defaults = modelInfo.patient_defaults[key];
  if (defaults) {
    const [age, weight, height, sex] = defaults;
    $("age-input").value = age;
    $("weight-input").value = weight;
    $("height-input").value = height;
    $("sex-select").value = sex;
  }
}

function updateUnitLabels() {
  const drug = $("drug-select").value;
  $("syringe-unit-label").textContent = modelInfo.syringe_unit[drug] || "";
  $("rate-unit-label").textContent = "mL/hr";
  populateRateDisplaySelect();
}

function populateRateDisplaySelect() {
  const drug = $("drug-select").value;
  const nativeUnit = modelInfo.rate_unit[drug] || "mg/min";
  const select = $("rate-display-select");
  const previous = select.value;
  select.innerHTML = "";
  [nativeUnit, "mL/hr"].forEach((unit) => {
    const opt = document.createElement("option");
    opt.value = unit;
    opt.textContent = unit;
    select.appendChild(opt);
  });
  select.value = previous === "mL/hr" ? "mL/hr" : nativeUnit;
}

function isMlPerHrDisplay() {
  return $("rate-display-select").value === "mL/hr";
}

function convertRateValue(rate) {
  if (!isMlPerHrDisplay()) return rate;
  const drugConc = parseFloat($("drug-conc-input").value);
  return (rate / drugConc) * 60;
}

function convertDoseValue(dose) {
  if (!isMlPerHrDisplay()) return dose;
  const drugConc = parseFloat($("drug-conc-input").value);
  return dose / drugConc;
}

function maxRateToNative(mlPerHr) {
  const drugConc = parseFloat($("drug-conc-input").value);
  return (mlPerHr * drugConc) / 60;
}

function displayRateUnit() {
  return isMlPerHrDisplay() ? "mL/hr" : lastResult.rate_unit;
}

function displayDoseUnit() {
  return isMlPerHrDisplay() ? "mL" : lastResult.dose_unit;
}

function updateModelDescription() {
  const drug = $("drug-select").value;
  const model = $("model-select").value;
  const key = `${drug}|${model}`;
  const pk = modelInfo.model_descriptions[key] || "";
  const pd = modelInfo.pd_model_descriptions[key] || "";
  $("model-description").textContent = pd ? `PK: ${pk}  |  PD: ${pd}` : `PK: ${pk}`;
}

// ---------------------------------------------------------------------------
// Target profile table
// ---------------------------------------------------------------------------

function addTargetRow(timeMin, targetVal) {
  const tbody = document.querySelector("#target-table tbody");
  const row = document.createElement("tr");
  row.innerHTML = `
    <td><input type="number" class="target-time" value="${timeMin}" step="0.5" min="0"></td>
    <td><input type="number" class="target-value" value="${targetVal}" step="0.1" min="0"></td>
    <td><button type="button" class="remove-row">&times;</button></td>
  `;
  row.querySelector(".remove-row").addEventListener("click", () => row.remove());
  tbody.appendChild(row);
}

function readTargetProfile() {
  const rows = document.querySelectorAll("#target-table tbody tr");
  return Array.from(rows).map((row) => [
    parseFloat(row.querySelector(".target-time").value),
    parseFloat(row.querySelector(".target-value").value),
  ]);
}

// ---------------------------------------------------------------------------
// Simulation run
// ---------------------------------------------------------------------------

function gatherParams() {
  const drug = $("drug-select").value;
  const model = $("model-select").value;
  return {
    drug, model,
    age: parseFloat($("age-input").value),
    weight: parseFloat($("weight-input").value),
    height: parseFloat($("height-input").value),
    sex: $("sex-select").value,
    conc_unit: modelInfo.conc_unit[drug],
    rate_unit: modelInfo.rate_unit[drug],
    drug_concentration: parseFloat($("drug-conc-input").value),
    max_rate: maxRateToNative(parseFloat($("max-rate-input").value)),
    dt_seconds: parseFloat($("dt-input").value),
    prediction_window_min: parseFloat($("pred-window-input").value),
    convergence_method: $("convergence-select").value,
    targeting_mode: $("targeting-mode-select").value,
    ke0_mode: $("ke0-mode-select").value,
    rsi_mode: $("rsi-checkbox").checked,
    rsi_bolus_time_sec: parseFloat($("rsi-time-input").value),
    duration_min: parseFloat($("duration-input").value),
    target_profile: readTargetProfile(),
  };
}

async function runSimulation() {
  clearError();
  $("run-btn").disabled = true;
  $("run-btn").textContent = "Running\u2026";
  try {
    const params = gatherParams();
    const resultJson = coreTci.run_simulation_json(JSON.stringify(params));
    const result = JSON.parse(resultJson);
    lastResult = result;
    renderResults(result);
    $("csv-btn").disabled = false;
  } catch (err) {
    console.error(err);
    showError(err);
  } finally {
    $("run-btn").disabled = false;
    $("run-btn").textContent = "Run Simulation";
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderResults(result) {
  $("results").classList.remove("hidden");
  $("chart-placeholder").classList.add("hidden");

  const pk = result.pk_summary;
  $("pk-summary").textContent =
    `V1=${pk.V1.toFixed(2)} L, ke0=${pk.ke0.toFixed(4)} /min` +
    (result.used_fixed_tpeak ? `  (ke0 recalibrated for fixed initial tpeak = ${result.target_tpeak_sec}s)` : "") +
    (result.capped_steps ? "  \u2014 NOTE: simulation length capped for performance" : "");

  renderParamList($("pk-params"), [
    ["V1", `${pk.V1.toFixed(3)} L`],
    ["k10", `${pk.k10.toFixed(5)} /min`],
    ["k12", `${pk.k12.toFixed(5)} /min`],
    ["k21", `${pk.k21.toFixed(5)} /min`],
    ...(pk.k13 || pk.k31 ? [["k13", `${pk.k13.toFixed(5)} /min`], ["k31", `${pk.k31.toFixed(5)} /min`]] : []),
    ["ke0", `${pk.ke0.toFixed(4)} /min`],
    ["Initial tpeak", `${result.initial_tpeak_sec.toFixed(1)} s`],
    ["Target tpeak", `${result.target_tpeak_sec.toFixed(1)} s`],
    ["Loading dose", `${result.loading_dose.toFixed(3)} ${result.dose_unit}`],
  ]);

  const pd = result.pd_summary;
  renderParamList($("pd-params"), [
    ["Effect type", pd.Effect_type],
    [pd.Effect50_type, `${pd.Effect50.toFixed(3)} ${result.conc_unit}`],
    ["gamma", pd.gamma.toFixed(3)],
  ]);

  const timeMin = result.time_sec.map((t) => t / 60);
  const asPoints = (arr) => arr.map((v, i) => ({ x: timeMin[i], y: v }));

  if (concChart) concChart.destroy();
  concChart = new Chart($("conc-chart"), {
    type: "line",
    data: {
      datasets: [
        { label: `Target (${result.conc_unit})`, data: asPoints(result.target), borderColor: SERIES_COLORS.target, borderDash: [4, 3], pointRadius: 0 },
        { label: `Cp (${result.conc_unit})`, data: asPoints(result.cp), borderColor: SERIES_COLORS.cp, pointRadius: 0 },
        { label: `Ce (${result.conc_unit})`, data: asPoints(result.ce), borderColor: SERIES_COLORS.ce, pointRadius: 0 },
      ],
    },
    options: chartOptions("Time (min)", "Concentration"),
  });

  const rateUnit = displayRateUnit();
  const rateDisplayData = result.rate.map(convertRateValue);

  if (rateChart) rateChart.destroy();
  rateChart = new Chart($("rate-chart"), {
    type: "line",
    data: {
      datasets: [
        { label: `Infusion rate (${rateUnit})`, data: asPoints(rateDisplayData), borderColor: SERIES_COLORS.rate, stepped: true, pointRadius: 0 },
      ],
    },
    options: chartOptions("Time (min)", `Rate (${rateUnit})`),
  });

  renderTable(result);
}

function chartOptions(xLabel, yLabel) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    scales: {
      x: {
        type: "linear",
        title: { display: true, text: xLabel },
        ticks: { color: "#93a4b8", callback: (v) => Number(v).toFixed(1) },
        grid: { color: "#2c3b4c" },
      },
      y: { title: { display: true, text: yLabel }, ticks: { color: "#93a4b8" }, grid: { color: "#2c3b4c" } },
    },
    // built-in tooltip disabled: the crosshair box (see attachChartHover) replaces it
    plugins: { legend: { labels: { color: "#e6edf3" } }, tooltip: { enabled: false } },
  };
}

function renderParamList(container, rows) {
  container.innerHTML = rows
    .map(([label, value]) => `<span class="param-label">${label}</span><span class="param-value">${value}</span>`)
    .join("");
}

function renderTable(result) {
  $("th-effect").textContent = `Effect(${result.effect_type})`;
  $("th-rate").textContent = `Rate(${displayRateUnit()})`;
  $("th-dose").textContent = `Dose(${displayDoseUnit()})`;

  const tbody = document.querySelector("#data-table tbody");
  tbody.innerHTML = "";
  const frag = document.createDocumentFragment();
  const n = result.time_sec.length;
  const stride = Math.max(1, Math.floor(n / 500)); // keep the DOM table light for long runs
  for (let i = 0; i < n; i += stride) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${formatTime(result.time_sec[i])}</td>
      <td>${result.target[i].toFixed(3)}</td>
      <td>${result.cp[i].toFixed(3)}</td>
      <td>${result.ce[i].toFixed(3)}</td>
      <td>${convertRateValue(result.rate[i]).toFixed(3)}</td>
      <td>${convertDoseValue(result.dose[i]).toFixed(3)}</td>
      <td>${result.effect[i].toFixed(0)}</td>
    `;
    frag.appendChild(tr);
  }
  tbody.appendChild(frag);
}

function formatTime(t) {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function nearestIndexForTimeMin(xMin) {
  const t = lastResult.time_sec;
  let lo = 0, hi = t.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid] / 60 < xMin) lo = mid + 1; else hi = mid;
  }
  if (lo > 0 && Math.abs(t[lo - 1] / 60 - xMin) < Math.abs(t[lo] / 60 - xMin)) lo -= 1;
  return lo;
}

function swatch(color) {
  return `<span class="tooltip-swatch" style="background:${color}"></span>`;
}

function buildTooltipHtml(idx) {
  const r = lastResult;
  return (
    `${swatch(SERIES_COLORS.target)}Target: ${r.target[idx].toFixed(3)} ${r.conc_unit}<br>` +
    `${swatch(SERIES_COLORS.cp)}Cp: ${r.cp[idx].toFixed(3)} ${r.conc_unit}<br>` +
    `${swatch(SERIES_COLORS.ce)}Ce: ${r.ce[idx].toFixed(3)} ${r.conc_unit}<br>` +
    `${swatch(SERIES_COLORS.rate)}Rate: ${convertRateValue(r.rate[idx]).toFixed(2)} ${displayRateUnit()}<br>` +
    `${swatch(SERIES_COLORS.dose)}Dose: ${convertDoseValue(r.dose[idx]).toFixed(3)} ${displayDoseUnit()}<br>` +
    `${swatch(SERIES_COLORS.effect)}Effect(${r.effect_type}): ${r.effect[idx].toFixed(0)}<br>` +
    `Time: ${formatTime(r.time_sec[idx])}`
  );
}

function attachChartHover(canvas, tooltipEl, getChart) {
  canvas.addEventListener("mousemove", (evt) => {
    const chart = getChart();
    if (!chart || !lastResult) return;
    const rect = canvas.getBoundingClientRect();
    const xScale = chart.scales.x;
    const xValue = xScale.getValueForPixel(evt.clientX - rect.left);
    if (xValue === null || xValue === undefined) return;
    const clamped = Math.min(Math.max(xValue, xScale.min), xScale.max);
    const idx = nearestIndexForTimeMin(clamped);
    const xMin = lastResult.time_sec[idx] / 60;

    crosshairState.xMin = xMin;
    crosshairState.active = true;
    if (concChart) concChart.draw();
    if (rateChart) rateChart.draw();

    tooltipEl.innerHTML = buildTooltipHtml(idx);
    tooltipEl.style.display = "block";
    const xPixel = xScale.getPixelForValue(xMin);
    const wrapWidth = canvas.parentElement.clientWidth;
    const tooltipWidth = tooltipEl.offsetWidth;
    let left = xPixel + 10;
    if (left + tooltipWidth > wrapWidth - 8) left = xPixel - tooltipWidth - 10;
    tooltipEl.style.left = `${Math.max(4, left)}px`;
  });

  canvas.addEventListener("mouseleave", () => {
    crosshairState.active = false;
    crosshairState.xMin = null;
    if (concChart) concChart.draw();
    if (rateChart) rateChart.draw();
    $("conc-chart-tooltip").style.display = "none";
    $("rate-chart-tooltip").style.display = "none";
  });
}

function downloadCsv() {
  if (!lastResult) return;
  const r = lastResult;
  const header = `Time(s),Target(${r.conc_unit}),Cp(${r.conc_unit}),Ce(${r.conc_unit}),Rate(${displayRateUnit()}),Dose(${displayDoseUnit()}),Effect(${r.effect_type})\n`;
  const lines = r.time_sec.map((t, i) =>
    [t, r.target[i], r.cp[i], r.ce[i], convertRateValue(r.rate[i]), convertDoseValue(r.dose[i]), r.effect[i]].join(",")
  );
  const blob = new Blob([header + lines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `dmepump_tci_${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function initTabs() {
  document.querySelectorAll(".tab-group").forEach((group) => {
    const tabButtons = group.querySelectorAll(":scope > .tabs > .tab-btn");
    tabButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        tabButtons.forEach((b) => { b.classList.remove("active"); b.setAttribute("aria-selected", "false"); });
        group.querySelectorAll(":scope > .tab-panel").forEach((p) => p.classList.remove("active"));
        btn.classList.add("active");
        btn.setAttribute("aria-selected", "true");
        const panel = group.querySelector(`:scope > .tab-panel[data-panel="${btn.dataset.tab}"]`);
        panel.classList.add("active");
        // ensure the clicked tab and its panel are fully visible (no manual scrolling needed)
        btn.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
        panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
        // Chart.js sizes canvases at creation time; re-measure if they were hidden (display:none)
        if (btn.dataset.tab === "charts") {
          if (concChart) concChart.resize();
          if (rateChart) rateChart.resize();
        }
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------------------

window.addEventListener("DOMContentLoaded", () => {
  $("drug-select").addEventListener("change", populateModelSelect);
  $("model-select").addEventListener("change", () => { applyPatientDefaults(); updateModelDescription(); });
  $("add-target-row-btn").addEventListener("click", () => addTargetRow(0, 0));
  $("run-btn").addEventListener("click", runSimulation);
  $("csv-btn").addEventListener("click", downloadCsv);

  $("rate-display-select").addEventListener("change", () => { if (lastResult) renderResults(lastResult); });
  $("drug-conc-input").addEventListener("input", () => { if (lastResult && isMlPerHrDisplay()) renderResults(lastResult); });

  initTabs();

  Object.entries(SERIES_COLORS).forEach(([key, color]) => {
    const th = $(`th-${key}`);
    if (th) th.style.color = color;
  });

  attachChartHover($("conc-chart"), $("conc-chart-tooltip"), () => concChart);
  attachChartHover($("rate-chart"), $("rate-chart-tooltip"), () => rateChart);

  initPyodide().catch((err) => {
    console.error(err);
    setLoadingStatus("Failed to load Pyodide runtime. See browser console for details.");
    showError(err);
  });
});
