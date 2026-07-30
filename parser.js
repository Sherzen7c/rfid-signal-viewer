(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.RfidParser = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const SPEED_LABELS = Object.freeze({
    "1": "慢速",
    "2": "正常",
    "3": "快速"
  });

  const GAIT_LABELS = Object.freeze({
    "1": "自然",
    "2": "大步",
    "3": "小步",
    "4": "外八"
  });

  const FORMAT_LABELS = Object.freeze({
    gait: "GaitDatasetCapture",
    dataset: "DatasetCapture",
    hello: "HelloOctaneSdk",
    rfui: "RF-UI data40user"
  });

  const NUMBER_PATTERN = "[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?";
  const HELLO_PATTERN = new RegExp(
    "^EPC:\\s+(.+?)\\s+antenna:\\s+(\\d+)\\s+first:\\s+(\\d+)" +
      "\\s+last:\\s+(\\d+)\\s+peak_rssi:\\s+(" + NUMBER_PATTERN + ")" +
      "\\s+chan_MHz:\\s+(" + NUMBER_PATTERN + ")" +
      "\\s+phase angle:\\s+(" + NUMBER_PATTERN + ")$"
  );

  function toFiniteNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function parseColumnLine(line, format) {
    const values = line.trim().split(/\s+/);
    const expectedColumns = format === "dataset" ? 7 : 6;

    if (values.length !== expectedColumns) {
      return { error: "应为 " + expectedColumns + " 列，实际为 " + values.length + " 列" };
    }

    const timestamp = toFiniteNumber(values[2]);
    const df = toFiniteNumber(values[3]);
    const rssi = toFiniteNumber(values[4]);
    const phase = toFiniteNumber(values[5]);

    if (timestamp === null || df === null || rssi === null || phase === null) {
      return { error: "timestamp、DF、RSSI 或 Phase 不是有效数字" };
    }

    return {
      record: {
        sampleId: values[0],
        tagId: values[1],
        epc: null,
        timestamp: timestamp,
        firstTimestamp: null,
        df: df,
        rssi: rssi,
        phase: phase,
        label: format === "dataset" ? values[6] : null,
        antenna: null,
        channel: null
      }
    };
  }

  function parseHelloLine(line) {
    const match = line.trim().match(HELLO_PATTERN);
    if (!match) {
      return { error: "不符合 HelloOctaneSdk 字段格式" };
    }

    const epc = match[1].trim().replace(/\s+/g, " ");
    const antenna = toFiniteNumber(match[2]);
    const firstTimestamp = toFiniteNumber(match[3]);
    const timestamp = toFiniteNumber(match[4]);
    const rssi = toFiniteNumber(match[5]);
    const channel = toFiniteNumber(match[6]);
    const phase = toFiniteNumber(match[7]);

    if ([antenna, firstTimestamp, timestamp, rssi, channel, phase].includes(null)) {
      return { error: "HelloOctaneSdk 行中存在无效数字" };
    }

    const compactEpc = epc.replace(/\s+/g, "");
    return {
      record: {
        sampleId: null,
        tagId: compactEpc.slice(-4),
        epc: epc,
        timestamp: timestamp,
        firstTimestamp: firstTimestamp,
        df: null,
        rssi: rssi,
        phase: phase,
        label: null,
        antenna: antenna,
        channel: channel
      }
    };
  }

  function parseRfuiLine(line) {
    const values = line.trim().split(",").map((value) => value.trim());
    if (values.length !== 5) {
      return { error: "RF-UI CSV 应为 5 列，实际为 " + values.length + " 列" };
    }

    const phase = toFiniteNumber(values[0]);
    const rssi = toFiniteNumber(values[1]);
    const df = toFiniteNumber(values[2]);
    const tag = toFiniteNumber(values[3]);
    const pointIndex = toFiniteNumber(values[4]);

    if ([phase, rssi, df, tag, pointIndex].includes(null)) {
      return { error: "Phase、RSSI、Doppler、Tag ID 或采集序号不是有效数字" };
    }
    if (!Number.isInteger(tag) || !Number.isInteger(pointIndex) || pointIndex < 0) {
      return { error: "Tag ID 和采集序号必须是非负整数" };
    }
    if (tag === 1021) {
      return { ignored: true };
    }
    if (tag < 1001 || tag > 1009) {
      return { error: "RF-UI Tag ID 应位于 1001–1009" };
    }

    return {
      record: {
        sampleId: null,
        tagId: String(tag),
        epc: null,
        timestamp: null,
        firstTimestamp: null,
        df: df,
        rssi: rssi,
        phase: phase,
        label: null,
        antenna: null,
        channel: null,
        pointIndex: pointIndex
      }
    };
  }

  function detectFormat(lines) {
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      if (/^EPC:\s+/i.test(trimmed)) {
        return "hello";
      }

      const csvValues = trimmed.split(",").map((value) => value.trim());
      if (
        csvValues.length === 5 &&
        csvValues.every((value) => Number.isFinite(Number(value))) &&
        Number.isInteger(Number(csvValues[3])) &&
        Number.isInteger(Number(csvValues[4]))
      ) {
        return "rfui";
      }

      const values = trimmed.split(/\s+/);
      if (values.length === 6 && values.slice(2).every((value) => Number.isFinite(Number(value)))) {
        return "gait";
      }
      if (
        values.length === 7 &&
        values.slice(2, 6).every((value) => Number.isFinite(Number(value)))
      ) {
        return "dataset";
      }
    }
    return null;
  }

  function parseFilename(fileName, format) {
    const baseName = String(fileName || "未命名文件").replace(/\.[^.]+$/, "");
    const metadata = { baseName: baseName };

    if (format === "gait") {
      const match = baseName.match(/^(\d+)_([1-3])_([1-4])$/);
      if (match) {
        metadata.sampleIndex = match[1];
        metadata.speed = match[2];
        metadata.speedLabel = SPEED_LABELS[match[2]];
        metadata.gait = match[3];
        metadata.gaitLabel = GAIT_LABELS[match[3]];
      }
    } else if (format === "dataset") {
      const match = baseName.match(/^(\d+)_(-?\d+)$/);
      if (match) {
        metadata.sampleIndex = match[1];
        metadata.label = match[2];
      }
    } else if (format === "rfui") {
      const match = baseName.match(/^(.+?)(\d+)$/);
      if (match) {
        metadata.user = match[1];
        metadata.trial = match[2];
      }
    }

    return metadata;
  }

  function uniqueValues(records, field) {
    const values = [];
    const seen = new Set();
    records.forEach((record) => {
      const value = record[field];
      if (value !== null && value !== undefined && !seen.has(value)) {
        seen.add(value);
        values.push(value);
      }
    });
    return values;
  }

  function unwrapPhaseValues(values) {
    const result = [];
    let previousRaw = null;
    let previousUnwrapped = null;

    values.forEach((value) => {
      if (value === null || value === undefined || !Number.isFinite(value)) {
        result.push(null);
        previousRaw = null;
        previousUnwrapped = null;
        return;
      }

      if (previousRaw === null) {
        result.push(value);
        previousRaw = value;
        previousUnwrapped = value;
        return;
      }

      let delta = value - previousRaw;
      while (delta > Math.PI) {
        delta -= 2 * Math.PI;
      }
      while (delta < -Math.PI) {
        delta += 2 * Math.PI;
      }

      previousUnwrapped += delta;
      result.push(previousUnwrapped);
      previousRaw = value;
    });

    return result;
  }

  function parseRfidText(text, fileName) {
    if (typeof text !== "string") {
      throw new TypeError("文件内容必须是文本");
    }

    const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
    const format = detectFormat(lines);
    if (!format) {
      throw new Error("无法识别文件格式，请检查是否来自支持的 RFID 采集程序");
    }

    const records = [];
    const errors = [];
    let invalidLines = 0;
    let ignoredLines = 0;

    lines.forEach((line, index) => {
      if (!line.trim()) {
        return;
      }

      const parsed = format === "hello"
        ? parseHelloLine(line)
        : format === "rfui"
          ? parseRfuiLine(line)
          : parseColumnLine(line, format);
      if (parsed.ignored) {
        ignoredLines += 1;
        return;
      }
      if (parsed.error) {
        invalidLines += 1;
        if (errors.length < 5) {
          errors.push({ line: index + 1, message: parsed.error });
        }
        return;
      }

      parsed.record.sourceLine = index + 1;
      parsed.record.fileIndex = records.length + 1;
      records.push(parsed.record);
    });

    if (!records.length) {
      throw new Error("文件格式已识别，但没有可用于绘图的有效数据行");
    }

    const tagCounters = new Map();
    let timestampMin = null;
    let timestampMax = null;

    if (format === "rfui") {
      records.sort((left, right) => left.pointIndex - right.pointIndex);
      records.forEach((record) => {
        tagCounters.set(record.tagId, (tagCounters.get(record.tagId) || 0) + 1);
        record.elapsedSec = null;
      });
    } else {
      const timestamps = records.map((record) => record.timestamp);
      timestampMin = Math.min.apply(null, timestamps);
      timestampMax = Math.max.apply(null, timestamps);
      records.forEach((record) => {
        const nextPoint = (tagCounters.get(record.tagId) || 0) + 1;
        tagCounters.set(record.tagId, nextPoint);
        record.pointIndex = nextPoint;
        record.elapsedSec = (record.timestamp - timestampMin) / 1000000;
      });
    }

    const pointIndices = records.map((record) => record.pointIndex);
    const pointIndexMin = Math.min.apply(null, pointIndices);
    const pointIndexMax = Math.max.apply(null, pointIndices);

    const metrics = ["rssi", "phase"];
    if (records.some((record) => record.df !== null)) {
      metrics.push("df");
    }
    if (records.some((record) => record.channel !== null)) {
      metrics.push("channel");
    }

    return {
      fileName: fileName || "未命名文件",
      format: format,
      formatLabel: FORMAT_LABELS[format],
      records: records,
      tags: Array.from(tagCounters.keys()),
      metrics: metrics,
      invalidLines: invalidLines,
      ignoredLines: ignoredLines,
      errors: errors,
      timestampMin: timestampMin,
      timestampMax: timestampMax,
      durationSec: timestampMin === null ? null : (timestampMax - timestampMin) / 1000000,
      pointIndexMin: pointIndexMin,
      pointIndexMax: pointIndexMax,
      axes: format === "rfui" ? ["point"] : ["time", "point"],
      metadata: parseFilename(fileName, format),
      sampleIds: uniqueValues(records, "sampleId"),
      labels: uniqueValues(records, "label"),
      antennas: uniqueValues(records, "antenna"),
      channels: uniqueValues(records, "channel")
    };
  }

  return {
    SPEED_LABELS: SPEED_LABELS,
    GAIT_LABELS: GAIT_LABELS,
    parseFilename: parseFilename,
    parseRfidText: parseRfidText,
    unwrapPhaseValues: unwrapPhaseValues
  };
});
