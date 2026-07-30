(function () {
  "use strict";

  const parser = window.RfidParser;
  const TAG_COLORS = [
    "#087f83", "#d2762b", "#b34374", "#4f8a45", "#5369a8",
    "#9a6a31", "#7a5aa6", "#c04f3d", "#2f7692"
  ];
  const METRIC_CONFIG = {
    rssi: { label: "RSSI", unit: "dBm", decimals: 1 },
    phase: { label: "相位", unit: "rad", decimals: 3 },
    df: { label: "Doppler", unit: "Hz", decimals: 3 },
    channel: { label: "信道", unit: "MHz", decimals: 2 }
  };
  const SVG_NS = "http://www.w3.org/2000/svg";

  const state = {
    files: [],
    activeId: null,
    axis: "time",
    phaseMode: "raw",
    zoomDomain: null,
    zoomFrame: null,
    compareMode: false,
    compareIds: [null, null],
    compareLayout: "side-by-side",
    chartContexts: [],
    dragDepth: 0,
    resizeTimer: null
  };

  const refs = {
    appShell: document.getElementById("appShell"),
    fileInput: document.getElementById("fileInput"),
    clearButton: document.getElementById("clearButton"),
    compareButton: document.getElementById("compareButton"),
    zoomResetButton: document.getElementById("zoomResetButton"),
    fileStrip: document.getElementById("fileStrip"),
    metadataList: document.getElementById("metadataList"),
    tagList: document.getElementById("tagList"),
    toggleAllTags: document.getElementById("toggleAllTags"),
    parseSection: document.getElementById("parseSection"),
    parseMessages: document.getElementById("parseMessages"),
    emptyState: document.getElementById("emptyState"),
    dropTarget: document.getElementById("dropTarget"),
    sidebarDropTarget: document.getElementById("sidebarDropTarget"),
    viewer: document.getElementById("viewer"),
    compareViewer: document.getElementById("compareViewer"),
    compareSelectA: document.getElementById("compareSelectA"),
    compareSelectB: document.getElementById("compareSelectB"),
    sideBySideButton: document.getElementById("sideBySideButton"),
    overlayButton: document.getElementById("overlayButton"),
    compareLineKey: document.getElementById("compareLineKey"),
    compareSummary: document.getElementById("compareSummary"),
    compareChartStack: document.getElementById("compareChartStack"),
    formatKicker: document.getElementById("formatKicker"),
    sampleTitle: document.getElementById("sampleTitle"),
    sampleStats: document.getElementById("sampleStats"),
    chartStack: document.getElementById("chartStack"),
    dropOverlay: document.getElementById("dropOverlay"),
    chartTooltip: document.getElementById("chartTooltip"),
    toastRegion: document.getElementById("toastRegion")
  };

  function sampleById(id) {
    return state.files.find((sample) => sample.id === id) || null;
  }

  function currentSample() {
    return sampleById(state.activeId);
  }

  function comparisonSamples() {
    return state.compareIds.map(sampleById).filter(Boolean);
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function svgElement(name, attributes) {
    const element = document.createElementNS(SVG_NS, name);
    Object.entries(attributes || {}).forEach(([key, value]) => {
      element.setAttribute(key, String(value));
    });
    return element;
  }

  function formatValue(value, decimals) {
    if (value === null || value === undefined || !Number.isFinite(value)) {
      return "—";
    }
    return Number(value).toFixed(decimals);
  }

  function formatDuration(value) {
    if (value === null || value === undefined || !Number.isFinite(value)) {
      return "—";
    }
    if (value < 1) {
      return (value * 1000).toFixed(0) + " ms";
    }
    return value.toFixed(value < 10 ? 3 : 2) + " s";
  }

  function compactList(values, formatter) {
    if (!values.length) {
      return null;
    }
    const formatted = values.map((value) => (formatter ? formatter(value) : value));
    if (formatted.length <= 3) {
      return formatted.join(", ");
    }
    return formatted.slice(0, 3).join(", ") + " 等 " + formatted.length + " 项";
  }

  function showToast(message, isError) {
    const toast = document.createElement("div");
    toast.className = "toast" + (isError ? " is-error" : "");
    toast.textContent = message;
    refs.toastRegion.appendChild(toast);
    window.setTimeout(() => toast.remove(), 4200);
  }

  function buildSample(file, result) {
    const recordsByTag = new Map();
    const tagCounts = new Map();

    result.tags.forEach((tag) => {
      recordsByTag.set(tag, []);
      tagCounts.set(tag, 0);
    });
    result.records.forEach((record) => {
      recordsByTag.get(record.tagId).push(record);
      tagCounts.set(record.tagId, tagCounts.get(record.tagId) + 1);
    });
    recordsByTag.forEach((records) => {
      const unwrapped = parser.unwrapPhaseValues(records.map((record) => record.phase));
      records.forEach((record, index) => {
        record.phaseUnwrapped = unwrapped[index];
      });
    });

    return {
      id: String(Date.now()) + "-" + Math.random().toString(36).slice(2),
      fileName: file.name,
      result: result,
      recordsByTag: recordsByTag,
      tagCounts: tagCounts,
      visibleTags: new Set(result.tags),
      colorByTag: new Map(result.tags.map((tag, index) => [tag, TAG_COLORS[index % TAG_COLORS.length]]))
    };
  }

  async function loadFiles(fileList) {
    const files = Array.from(fileList || []).filter((file) => file && typeof file.text === "function");
    if (!files.length) {
      return;
    }

    const loaded = [];
    for (const file of files) {
      try {
        const text = await file.text();
        const result = parser.parseRfidText(text, file.name);
        loaded.push(buildSample(file, result));
      } catch (error) {
        showToast(file.name + "：" + error.message, true);
      }
    }

    if (!loaded.length) {
      return;
    }

    state.files.push.apply(state.files, loaded);
    state.activeId = loaded[0].id;
    state.zoomDomain = null;
    refs.fileInput.value = "";
    render();
    showToast("已读取 " + loaded.length + " 个样本", false);
  }

  function ensureComparisonSelection() {
    if (state.files.length < 2) {
      state.compareMode = false;
      state.compareIds = [null, null];
      return false;
    }

    const validIds = new Set(state.files.map((sample) => sample.id));
    let firstId = validIds.has(state.compareIds[0]) ? state.compareIds[0] : state.activeId;
    if (!validIds.has(firstId)) {
      firstId = state.files[0].id;
    }
    let secondId = validIds.has(state.compareIds[1]) && state.compareIds[1] !== firstId
      ? state.compareIds[1]
      : null;
    if (!secondId) {
      const second = state.files.find((sample) => sample.id !== firstId);
      secondId = second ? second.id : null;
    }

    state.compareIds = [firstId, secondId];
    return Boolean(firstId && secondId);
  }

  function setCompareMode(enabled) {
    if (enabled && !ensureComparisonSelection()) {
      return;
    }
    state.compareMode = Boolean(enabled);
    state.zoomDomain = null;
    render();
  }

  function setComparisonLayout(layout) {
    if (layout !== "side-by-side" && layout !== "overlay") {
      return;
    }
    state.compareLayout = layout;
    render();
  }

  function setComparisonSample(index, id) {
    if (!state.compareMode || (index !== 0 && index !== 1) || !sampleById(id)) {
      return;
    }
    const otherIndex = index === 0 ? 1 : 0;
    const previousId = state.compareIds[index];
    if (id === state.compareIds[otherIndex]) {
      state.compareIds[otherIndex] = previousId;
    }
    state.compareIds[index] = id;
    state.activeId = state.compareIds[0];
    state.zoomDomain = null;
    render();
  }

  function removeSample(id) {
    const index = state.files.findIndex((sample) => sample.id === id);
    if (index === -1) {
      return;
    }

    const wasActive = state.activeId === id;
    state.files.splice(index, 1);
    if (wasActive) {
      const fallback = state.files[index] || state.files[index - 1] || null;
      state.activeId = fallback ? fallback.id : null;
    }
    state.zoomDomain = null;
    ensureComparisonSelection();
    render();
  }

  function clearSamples() {
    state.files = [];
    state.activeId = null;
    state.compareMode = false;
    state.compareIds = [null, null];
    state.zoomDomain = null;
    render();
  }

  function renderTabs() {
    refs.fileStrip.replaceChildren();
    state.files.forEach((sample) => {
      const tab = document.createElement("div");
      tab.className = "file-tab" + (sample.id === state.activeId ? " is-active" : "");
      if (state.compareMode && sample.id === state.compareIds[0]) {
        tab.classList.add("is-compare-a");
      }
      if (state.compareMode && sample.id === state.compareIds[1]) {
        tab.classList.add("is-compare-b");
      }
      tab.setAttribute("role", "presentation");

      const select = document.createElement("button");
      select.type = "button";
      select.className = "file-tab-select";
      select.textContent = sample.fileName;
      select.title = sample.fileName;
      select.setAttribute("role", "tab");
      select.setAttribute("aria-selected", sample.id === state.activeId ? "true" : "false");
      select.addEventListener("click", () => {
        if (state.compareMode) {
          setComparisonSample(0, sample.id);
          return;
        }
        state.activeId = sample.id;
        state.zoomDomain = null;
        render();
      });

      const close = document.createElement("button");
      close.type = "button";
      close.className = "file-tab-close";
      close.textContent = "×";
      close.title = "关闭 " + sample.fileName;
      close.setAttribute("aria-label", "关闭 " + sample.fileName);
      close.addEventListener("click", () => removeSample(sample.id));

      tab.append(select, close);
      refs.fileStrip.appendChild(tab);
    });
  }

  function addMetadata(label, value) {
    if (value === null || value === undefined || value === "") {
      return;
    }
    const row = document.createElement("div");
    row.className = "metadata-row";
    const term = document.createElement("dt");
    term.textContent = label;
    const description = document.createElement("dd");
    description.textContent = value;
    row.append(term, description);
    refs.metadataList.appendChild(row);
  }

  function renderMetadata(sample) {
    const result = sample.result;
    const metadata = result.metadata;
    refs.metadataList.replaceChildren();

    addMetadata("采集格式", result.formatLabel);
    addMetadata(result.format === "rfui" ? "用户代号" : "受试者", metadata.user || compactList(result.sampleIds));
    addMetadata("Trial", metadata.trial);
    addMetadata("样本编号", metadata.sampleIndex);
    if (metadata.speed) {
      addMetadata("速度", metadata.speed + " · " + metadata.speedLabel);
    }
    if (metadata.gait) {
      addMetadata("步态", metadata.gait + " · " + metadata.gaitLabel);
    }
    addMetadata("动作标签", metadata.label || compactList(result.labels));
    addMetadata("天线端口", compactList(result.antennas));
    addMetadata("信道", compactList(result.channels, (value) => Number(value).toFixed(2) + " MHz"));
    if (result.durationSec !== null) {
      addMetadata("时间范围", formatDuration(result.durationSec));
    } else {
      addMetadata("采集序号", result.pointIndexMin + "–" + result.pointIndexMax);
    }
  }

  function renderTags(sample) {
    refs.tagList.replaceChildren();
    sample.result.tags.forEach((tag) => {
      const label = document.createElement("label");
      label.className = "tag-option";
      label.style.setProperty("--tag-color", sample.colorByTag.get(tag));

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = sample.visibleTags.has(tag);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          sample.visibleTags.add(tag);
        } else {
          sample.visibleTags.delete(tag);
        }
        updateToggleAllLabel(sample);
        window.requestAnimationFrame(() => renderCharts(sample));
      });

      const swatch = document.createElement("span");
      swatch.className = "tag-swatch";
      const name = document.createElement("span");
      name.className = "tag-name";
      name.textContent = tag;
      name.title = tag;
      const count = document.createElement("span");
      count.className = "tag-count";
      count.textContent = sample.tagCounts.get(tag) + " 点";

      label.append(checkbox, swatch, name, count);
      refs.tagList.appendChild(label);
    });
    updateToggleAllLabel(sample);
  }

  function updateToggleAllLabel(sample) {
    refs.toggleAllTags.textContent = sample.visibleTags.size ? "全部隐藏" : "全部显示";
  }

  function renderParseMessages(sample) {
    const result = sample.result;
    refs.parseMessages.replaceChildren();
    refs.parseSection.hidden = result.invalidLines === 0 && result.ignoredLines === 0;
    if (!result.invalidLines && !result.ignoredLines) {
      return;
    }

    if (result.ignoredLines) {
      const ignored = document.createElement("div");
      ignored.textContent = "已过滤 " + result.ignoredLines + " 行杂散标签 1021。";
      refs.parseMessages.appendChild(ignored);
    }
    if (result.invalidLines) {
      const summary = document.createElement("div");
      summary.textContent = "已跳过 " + result.invalidLines + " 行无效数据。";
      refs.parseMessages.appendChild(summary);
    }
    result.errors.forEach((error) => {
      const item = document.createElement("div");
      item.textContent = "第 " + error.line + " 行：" + error.message;
      refs.parseMessages.appendChild(item);
    });
  }

  function renderHeader(sample) {
    const result = sample.result;
    refs.formatKicker.textContent = result.formatLabel;
    refs.sampleTitle.textContent = sample.fileName;
    refs.sampleTitle.title = sample.fileName;
    refs.sampleStats.replaceChildren();

    const stats = [
      [result.records.length.toLocaleString("zh-CN"), "有效记录"],
      [String(result.tags.length), "RFID 标签"],
      result.durationSec === null
        ? [result.pointIndexMin + "–" + result.pointIndexMax, "采集序号"]
        : [formatDuration(result.durationSec), "样本时长"]
    ];
    stats.forEach(([value, label]) => {
      const item = document.createElement("div");
      item.className = "sample-stat";
      const strong = document.createElement("strong");
      strong.textContent = value;
      const span = document.createElement("span");
      span.textContent = label;
      item.append(strong, span);
      refs.sampleStats.appendChild(item);
    });
  }

  function populateComparisonSelect(select, selectedId) {
    select.replaceChildren();
    state.files.forEach((sample) => {
      const option = document.createElement("option");
      option.value = sample.id;
      option.textContent = sample.fileName;
      option.selected = sample.id === selectedId;
      select.appendChild(option);
    });
  }

  function comparisonColorMap(samples) {
    const tags = [];
    const seen = new Set();
    samples.forEach((sample) => {
      sample.result.tags.forEach((tag) => {
        if (!seen.has(tag)) {
          seen.add(tag);
          tags.push(tag);
        }
      });
    });
    return new Map(tags.map((tag, index) => [tag, TAG_COLORS[index % TAG_COLORS.length]]));
  }

  function renderComparisonSummary(samples, colorByTag) {
    refs.compareSummary.replaceChildren();
    samples.forEach((sample, sampleIndex) => {
      const result = sample.result;
      const section = document.createElement("section");
      section.className = "compare-sample";
      section.style.setProperty("--sample-accent", sampleIndex === 0 ? "#087f83" : "#d2762b");

      const heading = document.createElement("div");
      heading.className = "compare-sample-heading";
      const titleWrap = document.createElement("div");
      titleWrap.className = "compare-sample-title";
      const title = document.createElement("strong");
      title.textContent = sample.fileName;
      title.title = sample.fileName;
      const format = document.createElement("span");
      format.textContent = result.formatLabel;
      titleWrap.append(title, format);

      const badge = document.createElement("span");
      badge.className = "compare-sample-badge";
      badge.textContent = sampleIndex === 0 ? "A" : "B";
      heading.append(titleWrap, badge);

      const stats = document.createElement("div");
      stats.className = "compare-sample-stats";
      const range = result.durationSec === null
        ? "采集序号 " + result.pointIndexMin + "–" + result.pointIndexMax
        : "时长 " + formatDuration(result.durationSec);
      stats.textContent = result.records.length.toLocaleString("zh-CN") + " 条记录 · " +
        result.tags.length + " 个标签 · " + range;

      const tagList = document.createElement("div");
      tagList.className = "compare-tag-list";
      result.tags.forEach((tag) => {
        const label = document.createElement("label");
        label.className = "compare-tag-option";
        label.style.setProperty("--tag-color", colorByTag.get(tag));

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = sample.visibleTags.has(tag);
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) {
            sample.visibleTags.add(tag);
          } else {
            sample.visibleTags.delete(tag);
          }
          window.requestAnimationFrame(renderComparisonCharts);
        });

        const swatch = document.createElement("span");
        swatch.className = "tag-swatch";
        const name = document.createElement("span");
        name.className = "tag-name";
        name.textContent = tag;
        name.title = tag;
        label.append(checkbox, swatch, name);
        tagList.appendChild(label);
      });

      section.append(heading, stats, tagList);
      refs.compareSummary.appendChild(section);
    });
  }

  function renderComparison() {
    const samples = comparisonSamples();
    if (samples.length !== 2) {
      return;
    }
    populateComparisonSelect(refs.compareSelectA, samples[0].id);
    populateComparisonSelect(refs.compareSelectB, samples[1].id);
    const overlayActive = state.compareLayout === "overlay";
    refs.sideBySideButton.classList.toggle("is-active", !overlayActive);
    refs.sideBySideButton.setAttribute("aria-pressed", overlayActive ? "false" : "true");
    refs.overlayButton.classList.toggle("is-active", overlayActive);
    refs.overlayButton.setAttribute("aria-pressed", overlayActive ? "true" : "false");
    refs.compareLineKey.hidden = !overlayActive;
    renderComparisonSummary(samples, comparisonColorMap(samples));
    window.requestAnimationFrame(renderComparisonCharts);
  }

  function render() {
    const sample = currentSample();
    refs.appShell.dataset.state = sample ? "loaded" : "empty";
    refs.appShell.dataset.mode = state.compareMode ? "compare" : "single";
    refs.clearButton.disabled = state.files.length === 0;
    refs.compareButton.disabled = state.files.length < 2;
    refs.compareButton.textContent = state.compareMode ? "退出对比" : "对比样本";
    refs.compareButton.setAttribute("aria-pressed", state.compareMode ? "true" : "false");
    refs.emptyState.hidden = Boolean(sample);
    refs.viewer.hidden = !sample || state.compareMode;
    refs.compareViewer.hidden = !sample || !state.compareMode;
    hideHover();
    renderTabs();
    updateAxisControl();
    updateZoomControl();

    if (!sample) {
      refs.chartStack.replaceChildren();
      refs.compareChartStack.replaceChildren();
      refs.compareSummary.replaceChildren();
      refs.metadataList.replaceChildren();
      refs.tagList.replaceChildren();
      return;
    }

    if (state.compareMode) {
      renderComparison();
      return;
    }

    renderMetadata(sample);
    renderTags(sample);
    renderParseMessages(sample);
    renderHeader(sample);
    window.requestAnimationFrame(() => renderCharts(sample));
  }

  function xValueFor(record) {
    return state.axis === "time" ? record.elapsedSec : record.pointIndex;
  }

  function visibleRecordsFor(sample) {
    return sample.result.records.filter((record) => sample.visibleTags.has(record.tagId));
  }

  function getXDomainForSamples(samples) {
    const records = samples.flatMap(visibleRecordsFor);
    if (!records.length) {
      return [0, 1];
    }
    const values = records.map(xValueFor);
    let min = Math.min.apply(null, values);
    let max = Math.max.apply(null, values);
    if (min === max) {
      max = min + 1;
    }
    if (state.axis === "point") {
      min = Math.min(1, min);
    }
    return [min, max];
  }

  function currentViewSamples() {
    return state.compareMode ? comparisonSamples() : [currentSample()].filter(Boolean);
  }

  function clampZoomDomain(domain, fullDomain) {
    if (!domain) {
      return fullDomain;
    }
    const start = Math.max(fullDomain[0], Math.min(domain[0], domain[1]));
    const end = Math.min(fullDomain[1], Math.max(domain[0], domain[1]));
    return end > start ? [start, end] : fullDomain;
  }

  function getDisplayedXDomainForSamples(samples) {
    const fullDomain = getXDomainForSamples(samples);
    return clampZoomDomain(state.zoomDomain, fullDomain);
  }

  function getXDomain(sample) {
    return getDisplayedXDomainForSamples([sample]);
  }

  function metricValue(record, metric) {
    if (metric === "phase" && state.phaseMode === "unwrapped") {
      return record.phaseUnwrapped;
    }
    return record[metric];
  }

  function metricDisplayLabel(metric) {
    if (metric === "phase" && state.phaseMode === "unwrapped") {
      return "相位（解缠）";
    }
    return METRIC_CONFIG[metric].label;
  }

  function getYDomain(records, metric) {
    const values = records
      .map((record) => metricValue(record, metric))
      .filter((value) => value !== null && Number.isFinite(value));
    if (!values.length) {
      return null;
    }

    let min = Math.min.apply(null, values);
    let max = Math.max.apply(null, values);
    if (min === max) {
      const padding = Math.abs(min) > 0 ? Math.abs(min) * 0.01 : 1;
      min -= padding;
      max += padding;
    } else {
      const padding = (max - min) * 0.08;
      min -= padding;
      max += padding;
    }
    return [min, max];
  }

  function linePath(records, metric, xScale, yScale) {
    const parts = [];
    records.forEach((record) => {
      const value = metricValue(record, metric);
      if (value === null || !Number.isFinite(value)) {
        return;
      }
      parts.push((parts.length ? "L" : "M") + xScale(xValueFor(record)).toFixed(2) + "," + yScale(value).toFixed(2));
    });
    return parts.join(" ");
  }

  function axisLabel(value, axis) {
    if (axis === "time") {
      if (value >= 10) {
        return value.toFixed(1);
      }
      return value.toFixed(2);
    }
    return Math.round(value).toString();
  }

  function createPhaseModeControl() {
    const control = document.createElement("div");
    control.className = "phase-mode-control";
    control.setAttribute("role", "group");
    control.setAttribute("aria-label", "相位显示方式");

    [
      { mode: "raw", label: "原始" },
      { mode: "unwrapped", label: "解缠" }
    ].forEach((item) => {
      const button = document.createElement("button");
      const active = state.phaseMode === item.mode;
      button.type = "button";
      button.className = "phase-mode-button";
      button.textContent = item.label;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
      button.addEventListener("click", () => setPhaseMode(item.mode));
      control.appendChild(button);
    });

    return control;
  }

  function drawMetricChart(sample, metric, xDomain, options) {
    const chartOptions = options || {};
    const chartSamples = chartOptions.samples || [sample];
    const config = METRIC_CONFIG[metric];
    const panel = document.createElement("section");
    panel.className = "chart-panel";

    const panelHeader = document.createElement("header");
    panelHeader.className = "chart-panel-header";
    const titleWrap = document.createElement("div");
    titleWrap.className = "chart-panel-title";
    const title = document.createElement("h3");
    title.textContent = chartOptions.title || config.label;
    title.title = chartOptions.title || "";
    const unit = document.createElement("span");
    unit.textContent = chartOptions.subtitle !== undefined
      ? chartOptions.subtitle
      : metric === "df" && chartSamples.some((chartSample) => chartSample.result.format === "rfui")
        ? "单位未确认"
        : config.unit;
    titleWrap.append(title, unit);
    const rangeLabel = document.createElement("span");
    rangeLabel.className = "chart-range";
    rangeLabel.hidden = Boolean(chartOptions.hideRange);
    const panelActions = document.createElement("div");
    panelActions.className = "chart-panel-actions";
    if (metric === "phase" && !chartOptions.hidePhaseControl) {
      panelActions.appendChild(createPhaseModeControl());
    }
    panelActions.appendChild(rangeLabel);
    panelHeader.append(titleWrap, panelActions);

    const frame = document.createElement("div");
    frame.className = "chart-frame";
    panel.append(panelHeader, frame);
    (chartOptions.container || refs.chartStack).appendChild(panel);

    const visibleRecords = chartSamples.flatMap(visibleRecordsFor);
    const sampleYDomain = getYDomain(visibleRecords, metric);
    const yDomain = chartOptions.yDomain || sampleYDomain;
    if (!sampleYDomain || !yDomain) {
      const empty = document.createElement("div");
      empty.className = "chart-empty";
      empty.textContent = chartSamples.some((chartSample) => chartSample.visibleTags.size)
        ? "当前指标没有有效数据"
        : "至少选择一个标签以显示曲线";
      frame.appendChild(empty);
      return;
    }

    rangeLabel.textContent = formatValue(yDomain[0], config.decimals) + " — " + formatValue(yDomain[1], config.decimals);

    const width = Math.max(frame.clientWidth, 320);
    const height = frame.clientHeight || 242;
    const padding = { top: 14, right: 18, bottom: 34, left: 58 };
    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;
    const xScale = (value) => padding.left + ((value - xDomain[0]) / (xDomain[1] - xDomain[0])) * plotWidth;
    const yScale = (value) => padding.top + (1 - (value - yDomain[0]) / (yDomain[1] - yDomain[0])) * plotHeight;
    const svg = svgElement("svg", {
      viewBox: "0 0 " + width + " " + height,
      role: "img",
      "aria-label": metricDisplayLabel(metric) + " 波形图"
    });

    for (let index = 0; index <= 4; index += 1) {
      const value = yDomain[0] + ((yDomain[1] - yDomain[0]) * index) / 4;
      const y = yScale(value);
      svg.appendChild(svgElement("line", {
        x1: padding.left,
        x2: width - padding.right,
        y1: y,
        y2: y,
        class: "chart-grid-line"
      }));
      const label = svgElement("text", {
        x: padding.left - 9,
        y: y + 3,
        "text-anchor": "end",
        class: "chart-axis-label"
      });
      label.textContent = formatValue(value, config.decimals);
      svg.appendChild(label);
    }

    for (let index = 0; index <= 5; index += 1) {
      const value = xDomain[0] + ((xDomain[1] - xDomain[0]) * index) / 5;
      const x = xScale(value);
      svg.appendChild(svgElement("line", {
        x1: x,
        x2: x,
        y1: padding.top,
        y2: height - padding.bottom,
        class: "chart-grid-line"
      }));
      const label = svgElement("text", {
        x: x,
        y: height - 12,
        "text-anchor": index === 0 ? "start" : index === 5 ? "end" : "middle",
        class: "chart-axis-label"
      });
      label.textContent = axisLabel(value, state.axis);
      svg.appendChild(label);
    }

    if (metric === "df" && yDomain[0] < 0 && yDomain[1] > 0) {
      const zeroY = yScale(0);
      svg.appendChild(svgElement("line", {
        x1: padding.left,
        x2: width - padding.right,
        y1: zeroY,
        y2: zeroY,
        class: "chart-zero-line"
      }));
    }

    const seriesSamples = chartSamples.map((chartSample, sampleIndex) => ({
      sample: chartSample,
      sampleIndex: sampleIndex
    }));
    if (chartOptions.overlay) {
      seriesSamples.reverse();
    }

    seriesSamples.forEach((series) => {
      const chartSample = series.sample;
      chartSample.result.tags.forEach((tag) => {
        if (!chartSample.visibleTags.has(tag)) {
          return;
        }
        const pathData = linePath(chartSample.recordsByTag.get(tag), metric, xScale, yScale);
        if (!pathData) {
          return;
        }
        const attributes = {
          d: pathData,
          stroke: chartOptions.colorByTag
            ? chartOptions.colorByTag.get(tag)
            : chartSample.colorByTag.get(tag),
          class: "chart-series" + (chartOptions.overlay
            ? series.sampleIndex === 0 ? " is-sample-a" : " is-sample-b"
            : "")
        };
        svg.appendChild(svgElement("path", attributes));
      });
    });

    const cursor = svgElement("line", {
      x1: padding.left,
      x2: padding.left,
      y1: padding.top,
      y2: height - padding.bottom,
      class: "chart-cursor",
      visibility: "hidden"
    });
    svg.appendChild(cursor);

    const dots = [];
    seriesSamples.forEach((series) => {
      const chartSample = series.sample;
      chartSample.result.tags.forEach((tag) => {
        if (!chartSample.visibleTags.has(tag)) {
          return;
        }
        const dot = svgElement("circle", {
          r: chartOptions.overlay && series.sampleIndex === 1 ? 5 : 4,
          fill: chartOptions.colorByTag
            ? chartOptions.colorByTag.get(tag)
            : chartSample.colorByTag.get(tag),
          class: "chart-hover-dot" + (chartOptions.overlay
            ? series.sampleIndex === 0 ? " is-sample-a" : " is-sample-b"
            : ""),
          visibility: "hidden"
        });
        dots.push({ dot: dot, sample: chartSample, tag: tag });
        svg.appendChild(dot);
      });
    });

    const overlay = svgElement("rect", {
      x: padding.left,
      y: padding.top,
      width: plotWidth,
      height: plotHeight,
      fill: "transparent",
      cursor: "crosshair"
    });
    svg.appendChild(overlay);
    frame.appendChild(svg);

    const context = { samples: chartSamples, metric, svg, cursor, dots, xScale, yScale, xDomain, padding, width, height };
    state.chartContexts.push(context);

    overlay.addEventListener("pointermove", (event) => {
      const rect = svg.getBoundingClientRect();
      const viewX = ((event.clientX - rect.left) / rect.width) * width;
      const boundedX = Math.max(padding.left, Math.min(width - padding.right, viewX));
      const xValue = xDomain[0] + ((boundedX - padding.left) / plotWidth) * (xDomain[1] - xDomain[0]);
      showHover(
        chartSamples,
        xValue,
        event.clientX,
        event.clientY,
        chartOptions.overlay ? metric : null,
        chartOptions.colorByTag
      );
    });
    overlay.addEventListener("wheel", (event) => {
      const deltaMultiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 120 : 1;
      const delta = event.deltaY * deltaMultiplier;
      if (!delta || (delta > 0 && !state.zoomDomain)) {
        return;
      }

      event.preventDefault();
      const rect = svg.getBoundingClientRect();
      const viewX = ((event.clientX - rect.left) / rect.width) * width;
      const boundedX = Math.max(padding.left, Math.min(width - padding.right, viewX));
      const xValue = xDomain[0] +
        ((boundedX - padding.left) / plotWidth) * (xDomain[1] - xDomain[0]);
      const limitedDelta = Math.max(-240, Math.min(240, delta));
      zoomAt(xValue, Math.exp(limitedDelta * 0.0015));
    }, { passive: false });
    overlay.addEventListener("pointerleave", hideHover);
  }

  function renderCharts(sample) {
    if (state.compareMode || !sample || sample.id !== state.activeId) {
      return;
    }
    updateZoomControl();
    refs.chartStack.replaceChildren();
    state.chartContexts = [];
    hideHover();
    const xDomain = getXDomain(sample);
    sample.result.metrics.forEach((metric) => drawMetricChart(sample, metric, xDomain));
  }

  function renderComparisonCharts() {
    if (!state.compareMode) {
      return;
    }
    updateZoomControl();
    const samples = comparisonSamples();
    if (samples.length !== 2) {
      return;
    }

    refs.compareChartStack.replaceChildren();
    state.chartContexts = [];
    hideHover();

    const commonMetrics = samples[0].result.metrics.filter((metric) =>
      samples[1].result.metrics.includes(metric)
    );
    if (!commonMetrics.length) {
      const empty = document.createElement("div");
      empty.className = "compare-empty";
      empty.textContent = "这两个样本没有可共同对比的指标";
      refs.compareChartStack.appendChild(empty);
      return;
    }

    const xDomain = getDisplayedXDomainForSamples(samples);
    const colorByTag = comparisonColorMap(samples);
    const overlayActive = state.compareLayout === "overlay";
    commonMetrics.forEach((metric) => {
      const config = METRIC_CONFIG[metric];
      const yDomain = getYDomain(samples.flatMap(visibleRecordsFor), metric);
      const section = document.createElement("section");
      section.className = "compare-metric";

      const header = document.createElement("header");
      header.className = "compare-metric-header";
      const title = document.createElement("h3");
      title.textContent = metricDisplayLabel(metric);
      const range = document.createElement("span");
      const unit = metric === "df" && samples.some((sample) => sample.result.format === "rfui")
        ? "单位未确认"
        : config.unit;
      range.textContent = yDomain
        ? formatValue(yDomain[0], config.decimals) + " — " +
          formatValue(yDomain[1], config.decimals) + " " + unit
        : "没有可见数据";
      const actions = document.createElement("div");
      actions.className = "compare-metric-actions";
      if (metric === "phase") {
        actions.appendChild(createPhaseModeControl());
      }
      actions.appendChild(range);
      header.append(title, actions);

      const grid = document.createElement("div");
      grid.className = "compare-chart-grid";
      grid.classList.toggle("is-overlay", overlayActive);
      section.append(header, grid);
      refs.compareChartStack.appendChild(section);

      if (overlayActive) {
        drawMetricChart(samples[0], metric, xDomain, {
          container: grid,
          yDomain: yDomain,
          samples: samples,
          colorByTag: colorByTag,
          overlay: true,
          title: "A 与 B 重叠曲线",
          subtitle: "相同标签同色",
          hideRange: true,
          hidePhaseControl: true
        });
      } else {
        samples.forEach((sample, sampleIndex) => {
          drawMetricChart(sample, metric, xDomain, {
            container: grid,
            yDomain: yDomain,
            colorByTag: colorByTag,
            title: (sampleIndex === 0 ? "A · " : "B · ") + sample.fileName,
            subtitle: sample.result.formatLabel,
            hideRange: true,
            hidePhaseControl: true
          });
        });
      }
    });
  }

  function renderVisibleCharts() {
    updateZoomControl();
    if (state.compareMode) {
      renderComparisonCharts();
      return;
    }
    renderCharts(currentSample());
  }

  function scheduleZoomRender() {
    if (state.zoomFrame !== null) {
      window.cancelAnimationFrame(state.zoomFrame);
    }
    state.zoomFrame = window.requestAnimationFrame(() => {
      state.zoomFrame = null;
      renderVisibleCharts();
    });
  }

  function setZoomDomain(domain) {
    const samples = currentViewSamples();
    if (!samples.length) {
      return;
    }
    const fullDomain = getXDomainForSamples(samples);
    const nextDomain = clampZoomDomain(domain, fullDomain);
    const fullSpan = fullDomain[1] - fullDomain[0];
    const nextSpan = nextDomain[1] - nextDomain[0];
    if (fullSpan <= 0 || nextSpan <= 0) {
      return;
    }
    state.zoomDomain = nextSpan >= fullSpan * 0.999 ? null : nextDomain;
    updateZoomControl();
    scheduleZoomRender();
  }

  function zoomAt(xValue, factor) {
    const samples = currentViewSamples();
    const records = samples.flatMap(visibleRecordsFor);
    if (!records.length || !Number.isFinite(xValue) || !Number.isFinite(factor)) {
      return;
    }

    const fullDomain = getXDomainForSamples(samples);
    const currentDomain = getDisplayedXDomainForSamples(samples);
    const fullSpan = fullDomain[1] - fullDomain[0];
    const currentSpan = currentDomain[1] - currentDomain[0];
    const minimumSpan = state.axis === "point"
      ? Math.max(1, fullSpan / 1000)
      : Math.max(0.001, fullSpan / 1000);
    const nextSpan = Math.max(minimumSpan, Math.min(fullSpan, currentSpan * factor));
    const anchor = Math.max(0, Math.min(1, (xValue - currentDomain[0]) / currentSpan));
    let start = xValue - nextSpan * anchor;
    let end = start + nextSpan;

    if (start < fullDomain[0]) {
      end += fullDomain[0] - start;
      start = fullDomain[0];
    }
    if (end > fullDomain[1]) {
      start -= end - fullDomain[1];
      end = fullDomain[1];
    }
    setZoomDomain([start, end]);
  }

  function resetZoom() {
    if (!state.zoomDomain) {
      return;
    }
    state.zoomDomain = null;
    updateZoomControl();
    scheduleZoomRender();
  }

  function updateZoomControl() {
    const hasData = currentViewSamples().flatMap(visibleRecordsFor).length > 0;
    const active = Boolean(state.zoomDomain);
    refs.zoomResetButton.disabled = !hasData || !active;
    refs.zoomResetButton.classList.toggle("is-active", active);
  }

  function nearestRecord(records, target) {
    if (!records || !records.length) {
      return null;
    }
    let low = 0;
    let high = records.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (xValueFor(records[middle]) < target) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    const current = records[low];
    const previous = low > 0 ? records[low - 1] : null;
    if (!previous) {
      return current;
    }
    return Math.abs(xValueFor(previous) - target) <= Math.abs(xValueFor(current) - target)
      ? previous
      : current;
  }

  function showHover(samples, xValue, clientX, clientY, focusedMetric, colorByTag) {
    const comparisonActive = samples.length > 1;
    const axisText = state.axis === "time"
      ? "时间 " + xValue.toFixed(3) + " s"
      : "采集点 " + Math.round(xValue);
    const metricLabels = focusedMetric
      ? metricDisplayLabel(focusedMetric)
      : samples[0].result.metrics.map(metricDisplayLabel).join(" · ");
    const rows = [];

    samples.forEach((sample, sampleIndex) => {
      sample.result.tags.forEach((tag) => {
        if (!sample.visibleTags.has(tag)) {
          return;
        }
        const record = nearestRecord(sample.recordsByTag.get(tag), xValue);
        if (!record) {
          return;
        }
        const metrics = focusedMetric ? [focusedMetric] : sample.result.metrics;
        const values = metrics.map((metric) => {
          const config = METRIC_CONFIG[metric];
          return "<span>" + escapeHtml(metricDisplayLabel(metric)) + " " +
            escapeHtml(formatValue(metricValue(record, metric), config.decimals)) + "</span>";
        }).join("");
        const sampleBadge = comparisonActive
          ? "<span class=\"tooltip-sample-badge\" style=\"--sample-color:" +
            (sampleIndex === 0 ? "#087f83" : "#d2762b") + "\">" +
            (sampleIndex === 0 ? "A" : "B") + "</span>"
          : "";
        const color = colorByTag ? colorByTag.get(tag) : sample.colorByTag.get(tag);
        rows.push(
          "<div class=\"tooltip-row" + (comparisonActive ? " is-comparison" : "") + "\">" +
            sampleBadge +
            "<span class=\"tag-swatch\" style=\"--tag-color:" + escapeHtml(color) + "\"></span>" +
            "<strong>" + escapeHtml(tag) + "</strong>" +
            "<span class=\"tooltip-values\">" + values + "</span>" +
          "</div>"
        );
      });
    });

    const heading = comparisonActive
      ? "重叠对比 · " + axisText
      : samples[0].fileName + " · " + axisText;
    refs.chartTooltip.innerHTML =
      "<div class=\"tooltip-heading\"><span>" + escapeHtml(heading) + "</span><span>" +
      escapeHtml(metricLabels) + "</span></div>" + rows.join("");
    refs.chartTooltip.hidden = false;

    state.chartContexts.forEach((context) => {
      const cursorX = context.xScale(xValue);
      context.cursor.setAttribute("x1", cursorX);
      context.cursor.setAttribute("x2", cursorX);
      context.cursor.setAttribute("visibility", "visible");
      context.dots.forEach((entry) => {
        const record = nearestRecord(entry.sample.recordsByTag.get(entry.tag), xValue);
        const value = record ? metricValue(record, context.metric) : null;
        if (value === null || !Number.isFinite(value)) {
          entry.dot.setAttribute("visibility", "hidden");
          return;
        }
        entry.dot.setAttribute("cx", context.xScale(xValueFor(record)));
        entry.dot.setAttribute("cy", context.yScale(value));
        entry.dot.setAttribute("visibility", "visible");
      });
    });

    const tooltipRect = refs.chartTooltip.getBoundingClientRect();
    let left = clientX + 14;
    let top = clientY + 14;
    if (left + tooltipRect.width > window.innerWidth - 10) {
      left = clientX - tooltipRect.width - 14;
    }
    if (top + tooltipRect.height > window.innerHeight - 10) {
      top = clientY - tooltipRect.height - 14;
    }
    refs.chartTooltip.style.left = Math.max(10, left) + "px";
    refs.chartTooltip.style.top = Math.max(10, top) + "px";
  }

  function hideHover() {
    refs.chartTooltip.hidden = true;
    state.chartContexts.forEach((context) => {
      context.cursor.setAttribute("visibility", "hidden");
      context.dots.forEach((entry) => entry.dot.setAttribute("visibility", "hidden"));
    });
  }

  function setAxis(axis) {
    if (axis !== "time" && axis !== "point") {
      return;
    }
    const supportedAxes = supportedAxesForView();
    if (!supportedAxes.includes(axis)) {
      return;
    }
    if (state.axis !== axis) {
      state.axis = axis;
      state.zoomDomain = null;
    }
    updateAxisControl();
    updateZoomControl();
    if (currentSample()) {
      window.requestAnimationFrame(renderVisibleCharts);
    }
  }

  function setPhaseMode(mode) {
    if ((mode !== "raw" && mode !== "unwrapped") || state.phaseMode === mode) {
      return;
    }
    state.phaseMode = mode;
    hideHover();
    window.requestAnimationFrame(renderVisibleCharts);
  }

  function supportedAxesForView() {
    const samples = state.compareMode ? comparisonSamples() : [currentSample()].filter(Boolean);
    if (!samples.length) {
      return ["time", "point"];
    }
    return ["time", "point"].filter((axis) =>
      samples.every((sample) => sample.result.axes.includes(axis))
    );
  }

  function updateAxisControl() {
    const supportedAxes = supportedAxesForView();
    if (!supportedAxes.includes(state.axis)) {
      state.axis = supportedAxes[0];
    }
    document.querySelectorAll(".axis-button").forEach((button) => {
      const supported = supportedAxes.includes(button.dataset.axis);
      const active = button.dataset.axis === state.axis;
      button.disabled = !supported;
      button.title = supported ? "" : "该格式没有时间戳，只能使用采集点横轴";
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  refs.fileInput.addEventListener("change", (event) => loadFiles(event.target.files));
  refs.dropTarget.addEventListener("click", () => refs.fileInput.click());
  refs.sidebarDropTarget.addEventListener("click", () => refs.fileInput.click());
  refs.clearButton.addEventListener("click", clearSamples);
  refs.compareButton.addEventListener("click", () => setCompareMode(!state.compareMode));
  refs.compareSelectA.addEventListener("change", (event) => setComparisonSample(0, event.target.value));
  refs.compareSelectB.addEventListener("change", (event) => setComparisonSample(1, event.target.value));
  refs.sideBySideButton.addEventListener("click", () => setComparisonLayout("side-by-side"));
  refs.overlayButton.addEventListener("click", () => setComparisonLayout("overlay"));
  refs.zoomResetButton.addEventListener("click", resetZoom);
  refs.toggleAllTags.addEventListener("click", () => {
    const sample = currentSample();
    if (!sample) {
      return;
    }
    if (sample.visibleTags.size) {
      sample.visibleTags.clear();
    } else {
      sample.result.tags.forEach((tag) => sample.visibleTags.add(tag));
    }
    renderTags(sample);
    window.requestAnimationFrame(() => renderCharts(sample));
  });

  document.querySelectorAll(".axis-button").forEach((button) => {
    button.addEventListener("click", () => setAxis(button.dataset.axis));
  });

  document.addEventListener("dragenter", (event) => {
    if (!event.dataTransfer || !Array.from(event.dataTransfer.types).includes("Files")) {
      return;
    }
    event.preventDefault();
    state.dragDepth += 1;
    refs.dropOverlay.hidden = false;
  });
  document.addEventListener("dragover", (event) => {
    if (event.dataTransfer) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }
  });
  document.addEventListener("dragleave", (event) => {
    event.preventDefault();
    state.dragDepth = Math.max(0, state.dragDepth - 1);
    if (state.dragDepth === 0) {
      refs.dropOverlay.hidden = true;
    }
  });
  document.addEventListener("drop", (event) => {
    event.preventDefault();
    state.dragDepth = 0;
    refs.dropOverlay.hidden = true;
    if (event.dataTransfer) {
      loadFiles(event.dataTransfer.files);
    }
  });

  window.addEventListener("resize", () => {
    window.clearTimeout(state.resizeTimer);
    state.resizeTimer = window.setTimeout(() => {
      if (currentSample()) {
        renderVisibleCharts();
      }
    }, 120);
  });

  render();
})();
