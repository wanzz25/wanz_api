const axios = require("axios");
const crypto = require("crypto");

// ---------- Provider 1: savetube (via y2mate.net.co) ----------
function getSavetubeKeyHex() {
  return "C5D58EF67A7584E4A29F6C35BBC4EB12";
}

function decryptSavetube(encryptedBase64) {
  const key = Buffer.from(getSavetubeKeyHex(), "hex");
  const encryptedBuffer = Buffer.from(encryptedBase64.replace(/\s/g, ""), "base64");
  const iv = encryptedBuffer.subarray(0, 16);
  const ciphertext = encryptedBuffer.subarray(16);
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
  let decrypted = decipher.update(ciphertext, null, "utf8");
  decrypted += decipher.final("utf8");
  return JSON.parse(decrypted);
}

const savetubeHeaders = {
  "host": "cdn403.savetube.vip",
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:153.0) Gecko/20100101 Firefox/153.0",
  "accept": "application/json, text/plain, */*",
  "content-type": "application/json",
  "origin": "https://y2mate.net.co",
  "referer": "https://y2mate.net.co/"
};

async function fromSavetube(url, quality = "320", timeoutMs = 12000) {
  const infoRes = await axios.post("https://cdn403.savetube.vip/v2/info", { url }, { headers: savetubeHeaders, timeout: timeoutMs });
  if (!infoRes?.data?.data) throw new Error("savetube: gagal ambil info");

  const meta = decryptSavetube(infoRes.data.data);
  if (!meta?.key) throw new Error("savetube: key kosong");

  const dl = await axios.post("https://cdn403.savetube.vip/download", { downloadType: "audio", quality, key: meta.key }, {
    headers: { ...savetubeHeaders, accept: "*/*" },
    timeout: timeoutMs
  });

  const downloadUrl = dl?.data?.data?.downloadUrl;
  if (!downloadUrl) throw new Error("savetube: downloadUrl kosong");

  return { provider: "savetube", title: meta.title, duration: meta.durationLabel, downloadUrl };
}

// ---------- Provider 2: opa-shan (content-service worker) ----------
const opaHeaders = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
  "content-type": "application/json",
  "accept": "*/*",
  "origin": "https://www.y2mate.rest",
  "referer": "https://www.y2mate.rest/"
};

async function fromOpaShan(url, timeoutMs = 12000) {
  const API = "https://content-service.opa-shan.workers.dev";
  const post = await axios.post(`${API}/api/v1/downloads`, { url, format: "mp3" }, { headers: opaHeaders, timeout: timeoutMs, validateStatus: () => true });

  if (!post.data?.job_id) throw new Error("opa-shan: gagal buat job");

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1500));
    const get = await axios.get(`${API}/api/v1/downloads/${post.data.job_id}`, { headers: opaHeaders, timeout: timeoutMs, validateStatus: () => true });
    if (get.data?.status === "ready") {
      return { provider: "opa-shan", title: get.data.title || null, downloadUrl: get.data.download_url || get.data.url || get.data.link };
    }
    if (get.data?.status === "failed" || get.data?.status === "error") throw new Error("opa-shan: job gagal");
  }
  throw new Error("opa-shan: timeout polling");
}

// ---------- Provider 3: insvid ----------
function extractVideoId(input) {
  try {
    const url = new URL(input);
    if (url.hostname === "youtu.be") return url.pathname.substring(1);
    if (url.pathname.startsWith("/shorts/")) return url.pathname.split("/")[2];
    if (url.pathname.startsWith("/embed/")) return url.pathname.split("/")[2];
    return url.searchParams.get("v");
  } catch {
    return /^[A-Za-z0-9_-]{11}$/.test(input) ? input : null;
  }
}

async function fromInsvid(url, timeoutMs = 12000) {
  const videoId = extractVideoId(url);
  if (!videoId) throw new Error("insvid: URL/ID tidak valid");

  const headers = {
    "host": "ac.insvid.com",
    "accept": "*/*",
    "content-type": "application/json",
    "origin": "https://ac.insvid.com",
    "referer": `https://ac.insvid.com/widget?url=https://www.youtube.com/watch?v=${videoId}&el=147`,
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"
  };

  const response = await axios.post("https://ac.insvid.com/converter", { id: videoId, fileType: "MP3" }, { headers, timeout: timeoutMs });

  if (response.data?.status === "ok" && response.data.link) {
    return { provider: "insvid", title: null, downloadUrl: response.data.link };
  }
  throw new Error("insvid: link kosong");
}

/**
 * Coba beberapa provider berurutan, pakai yang paling cepat berhasil duluan.
 * Berhenti di percobaan pertama yang sukses.
 */
async function downloadAudioWithFallback(url, quality = "320") {
  const providers = [
    () => fromSavetube(url, quality),
    () => fromOpaShan(url),
    () => fromInsvid(url)
  ];

  const errors = [];
  for (const attempt of providers) {
    try {
      return await attempt();
    } catch (err) {
      errors.push(err.message || String(err));
    }
  }

  throw new Error(`Semua provider gagal: ${errors.join(" | ")}`);
}

module.exports = { fromSavetube, fromOpaShan, fromInsvid, downloadAudioWithFallback };
