import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { timingSafeEqual } from "node:crypto";

const CATEGORIES = new Set(["machine_modules", "air_sensors", "online_dosers", "air_conditioners"]);
const DEVICE_KEY = "hitest:web:devices";
const EVENT_KEY = "hitest:web:events";
const STATUS_KEY = "hitest:web:device-status";
const DEVICE_HISTORY_KEY_PREFIX = "hitest:web:device-history:";
const MAX_DEVICES = 100;
const DEFAULT_EVENT_PAGE_SIZE = 50;
const MAX_EVENT_PAGE_SIZE = 100;
const DEVICE_TIMEOUT_MS = 4000;
const STATUS_CONCURRENCY = 50;

function respond(response, status, body) {
  response.status(status).json(body);
}

async function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    const error = new Error("Configure o armazenamento Redis pela integração Upstash na Vercel.");
    error.status = 503;
    throw error;
  }
  const { Redis } = await import("@upstash/redis");
  return new Redis({ url, token });
}

function authorize(request) {
  const expected = process.env.HITEST_API_TOKEN || "";
  const supplied = request.headers.authorization?.startsWith("Bearer ")
    ? request.headers.authorization.slice(7)
    : "";
  if (expected.length < 32 || expected.startsWith("replace-")) {
    const error = new Error("O token HITEST_API_TOKEN precisa ter pelo menos 32 caracteres.");
    error.status = 503;
    throw error;
  }
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  if (expectedBuffer.length !== suppliedBuffer.length || !timingSafeEqual(expectedBuffer, suppliedBuffer)) {
    const error = new Error("Token de acesso inválido.");
    error.status = 401;
    throw error;
  }
}

function validateEndpoint(value) {
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("Informe uma URL válida para o dispositivo.");
  }
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new Error("Use HTTP ou HTTPS sem credenciais na URL.");
  }
  const hostname = endpoint.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const addressFamily = isIP(hostname);
  if (addressFamily) {
    if (!isPublicAddress(hostname)) {
      throw new Error("O IP do dispositivo precisa ser público e roteável pela internet.");
    }
    if (endpoint.port) {
      throw new Error("Use a porta padrão do dispositivo: 80 para HTTP ou 443 para HTTPS.");
    }
    if (endpoint.protocol === "http:" && addressFamily !== 4) {
      throw new Error("Para IP público IPv6, configure HTTPS com certificado válido.");
    }
  } else {
    if (endpoint.protocol !== "https:" || (endpoint.port && endpoint.port !== "443")) {
      throw new Error("Domínios precisam usar HTTPS na porta padrão 443.");
    }
    if (!hostname.includes(".") || hostname === "localhost" || hostname.endsWith(".localhost")
      || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
      throw new Error("Use um domínio público com certificado HTTPS válido.");
    }
  }
  endpoint.hash = "";
  return endpoint.toString().replace(/\/$/, "");
}

function isPublicAddress(address) {
  const normalized = address.toLowerCase().split("%")[0];
  if (isIP(normalized) === 4) {
    const octets = normalized.split(".").map(Number);
    const [a, b] = octets;
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && octets[2] === 100)
      || (a === 192 && b === 88 && octets[2] === 99)
      || (a === 203 && b === 0 && octets[2] === 113));
  }
  if (isIP(normalized) === 6) {
    const first = Number.parseInt(normalized.split(":")[0] || "0", 16);
    return (first & 0xe000) === 0x2000 && !normalized.startsWith("2001:db8:");
  }
  return false;
}

function isValidDeviceIp(address) {
  if (isIP(address) !== 4) return false;
  const octets = address.split(".").map(Number);
  const [a, b] = octets;
  const privateAddress = a === 10
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168);
  return privateAddress || isPublicAddress(address);
}

async function checkedDeviceUrl(endpoint, path) {
  const parsed = new URL(endpoint);
  let addresses;
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  const family = isIP(hostname);
  if (family) {
    addresses = [{ address: hostname, family }];
  } else {
    try {
      addresses = await lookup(hostname, { all: true, verbatim: true });
    } catch {
      throw new Error("Não foi possível resolver o domínio HTTPS do dispositivo.");
    }
  }
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error("O dispositivo precisa usar um IP público ou domínio que resolva apenas para endereços públicos.");
  }
  return { url: new URL(path, `${endpoint.replace(/\/+$/, "")}/`), addresses };
}

async function deviceRequest(device, path) {
  const { url, addresses } = await checkedDeviceUrl(device.endpoint, path);
  const address = addresses.find(({ family }) => family === 4) || addresses[0];
  return new Promise((resolve, reject) => {
    const makeRequest = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = makeRequest(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, addresses);
        else callback(null, address.address, address.family);
      },
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > 65536) {
          request.destroy(new Error("A resposta do dispositivo excede o limite permitido."));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        if (response.statusCode >= 300 && response.statusCode < 400) {
          reject(new Error("Redirecionamentos de dispositivos não são permitidos."));
        } else if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`O dispositivo respondeu HTTP ${response.statusCode}.`));
        } else {
          resolve({ status: response.statusCode, body: Buffer.concat(chunks) });
        }
      });
      response.on("error", reject);
    });
    request.setTimeout(DEVICE_TIMEOUT_MS, () => request.destroy(new Error("Tempo limite ao consultar dispositivo.")));
    request.on("error", reject);
    request.end();
  });
}

function validateDevices(input) {
  if (!Array.isArray(input) || input.length > MAX_DEVICES) {
    throw new Error(`A configuração deve ser uma lista com até ${MAX_DEVICES} dispositivos.`);
  }
  const seen = new Set();
  return input.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Dispositivo inválido.");
    const id = typeof value.id === "string" ? value.id.trim() : "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id) || seen.has(id)) {
      throw new Error("Os identificadores devem ser únicos e conter apenas letras, números, ponto, hífen ou sublinhado.");
    }
    if (!CATEGORIES.has(value.category)) throw new Error(`Categoria inválida para ${id}.`);
    seen.add(id);
    if (value.category === "air_conditioners") {
      const ip = typeof value.ip === "string" ? value.ip.trim() : "";
      if (!isValidDeviceIp(ip)) {
        throw new Error(`Informe um endereço IPv4 local ou público válido para ${id}.`);
      }
      return { id, category: value.category, ip };
    }
    return { id, category: value.category, endpoint: validateEndpoint(value.endpoint) };
  });
}

async function appendEvent(redis, event) {
  await redis.lpush(EVENT_KEY, JSON.stringify({ ...event, timestamp: new Date().toISOString() }));
}

async function getDevices(redis) {
  return (await redis.get(DEVICE_KEY)) || [];
}

async function getStatus(redis, devices, probeDevice = deviceRequest) {
  const previousStatuses = await redis.hgetall(STATUS_KEY) || {};
  const statusUpdates = {};
  const historyWrites = [];
  const transitions = [];
  const results = [];
  for (let offset = 0; offset < devices.length; offset += STATUS_CONCURRENCY) {
    const batch = devices.slice(offset, offset + STATUS_CONCURRENCY);
    results.push(...await Promise.all(batch.map(async (device) => {
      if (device.category === "air_conditioners") {
        const status = { ...device, status: "local_only", checkedAt: null, lastSeen: null };
        statusUpdates[device.id] = JSON.stringify(status);
        return status;
      }
      const stored = previousStatuses[device.id];
      const previous = typeof stored === "string" ? JSON.parse(stored) : stored;
      const checkedAt = new Date().toISOString();
      try {
        const response = await probeDevice(device, "/heartbeat");
        const payload = JSON.parse(response.body.toString("utf8"));
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Resposta de heartbeat inválida.");
        const status = {
          ...device,
          status: "online",
          version: typeof payload.version === "string" ? payload.version : null,
          uptime: typeof payload.uptime === "string" || typeof payload.uptime === "number" ? String(payload.uptime) : null,
          device_status: typeof payload.status === "string" ? payload.status : null,
          checkedAt,
          lastSeen: checkedAt,
        };
        historyWrites.push({
          key: `${DEVICE_HISTORY_KEY_PREFIX}${device.id}`,
          record: JSON.stringify({ checkedAt, status: "online", payload }),
        });
        statusUpdates[device.id] = JSON.stringify(status);
        if (previous?.status !== "online") transitions.push({ type: "device_online", device: device.id, description: `${device.id} está online.` });
        return status;
      } catch (error) {
        const status = {
          ...device,
          status: "offline",
          version: previous?.version || null,
          uptime: previous?.uptime || null,
          device_status: previous?.device_status || null,
          checkedAt,
          lastSeen: previous?.lastSeen || null,
          error: error.message,
        };
        historyWrites.push({
          key: `${DEVICE_HISTORY_KEY_PREFIX}${device.id}`,
          record: JSON.stringify({ checkedAt, status: "offline", error: error.message }),
        });
        statusUpdates[device.id] = JSON.stringify(status);
        if (previous?.status !== "offline") transitions.push({ type: "device_offline", device: device.id, description: `${device.id} está offline.` });
        return status;
      }
    })));
  }
  if (Object.keys(statusUpdates).length) await redis.hset(STATUS_KEY, statusUpdates);
  await Promise.all(historyWrites.map(({ key, record }) => redis.lpush(key, record)));
  for (const transition of transitions) await appendEvent(redis, transition);
  return results;
}

function getPageParameters(query) {
  const offset = Number(query?.offset ?? 0);
  const requestedLimit = Number(query?.limit ?? DEFAULT_EVENT_PAGE_SIZE);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
    const error = new Error("A paginação de eventos é inválida.");
    error.status = 400;
    throw error;
  }
  return { offset, limit: Math.min(requestedLimit, MAX_EVENT_PAGE_SIZE) };
}

async function getEventPage(redis, offset, limit) {
  const [events, total] = await Promise.all([
    redis.lrange(EVENT_KEY, offset, offset + limit - 1),
    redis.llen(EVENT_KEY),
  ]);
  return {
    events: events.map((event) => typeof event === "string" ? JSON.parse(event) : event),
    total,
    offset,
    hasMore: offset + events.length < total,
  };
}

async function getDeviceHistoryPage(redis, deviceId, offset, limit) {
  const key = `${DEVICE_HISTORY_KEY_PREFIX}${deviceId}`;
  const [records, total] = await Promise.all([
    redis.lrange(key, offset, offset + limit - 1),
    redis.llen(key),
  ]);
  return {
    records: records.map((record) => typeof record === "string" ? JSON.parse(record) : record),
    total,
    offset,
    hasMore: offset + records.length < total,
  };
}

function decodePath(path) {
  if (Array.isArray(path)) return path.map((part) => decodeURIComponent(part));
  if (typeof path === "string") return path.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  return [];
}

export {
  appendEvent,
  decodePath,
  getDeviceHistoryPage,
  getEventPage,
  getPageParameters,
  getStatus,
  isPublicAddress,
  validateDevices,
};

export default async function handler(request, response) {
  try {
    authorize(request);
    const redis = await getRedis();
    const path = decodePath(request.query.path);
    if (path.length === 1 && path[0] === "devices" && request.method === "GET") {
      return respond(response, 200, { devices: await getDevices(redis) });
    }
    if (path.length === 1 && path[0] === "devices" && request.method === "PUT") {
      let devices;
      try {
        devices = validateDevices(request.body?.devices);
      } catch (error) {
        return respond(response, 400, { detail: error.message });
      }
      await redis.set(DEVICE_KEY, devices);
      await appendEvent(redis, { type: "configuration_updated", description: "Lista de dispositivos atualizada." });
      return respond(response, 200, { devices });
    }
    if (path.length === 1 && path[0] === "status" && request.method === "GET") {
      return respond(response, 200, { devices: await getStatus(redis, await getDevices(redis)) });
    }
    if (path.length === 1 && path[0] === "events" && request.method === "GET") {
      const { offset, limit } = getPageParameters(request.query);
      return respond(response, 200, await getEventPage(redis, offset, limit));
    }
    if (path.length === 3 && path[0] === "devices" && path[2] === "history" && request.method === "GET") {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(path[1])) {
        return respond(response, 400, { detail: "Identificador de dispositivo inválido." });
      }
      const { offset, limit } = getPageParameters(request.query);
      return respond(response, 200, await getDeviceHistoryPage(redis, path[1], offset, limit));
    }
    if (path.length === 3 && path[0] === "devices" && path[2] === "heartbeat" && request.method === "GET") {
      const device = (await getDevices(redis)).find(({ id }) => id === path[1]);
      if (!device) return respond(response, 404, { detail: "Dispositivo não encontrado." });
      if (device.category === "air_conditioners") {
        return respond(response, 400, { detail: "O equipamento é acessado diretamente pelo navegador na rede local." });
      }
      return respond(response, 200, (await getStatus(redis, [device]))[0]);
    }
    if (path.length === 3 && path[0] === "devices" && path[2] === "command" && request.method === "POST") {
      const device = (await getDevices(redis)).find(({ id }) => id === path[1]);
      if (!device) return respond(response, 404, { detail: "Dispositivo não encontrado." });
      if (device.category === "air_conditioners") {
        return respond(response, 400, { detail: "Use o comando local /airon1 pelo navegador na rede do equipamento." });
      }
      if (device.category === "air_sensors") return respond(response, 400, { detail: "Esta categoria não oferece o comando /lb." });
      try {
        const result = await deviceRequest(device, "/lb");
        await appendEvent(redis, { type: "command_sent", device: device.id, description: `Comando /lb enviado para ${device.id}.` });
        return respond(response, 200, { device: device.id, status: "command_sent", http_status: result.status });
      } catch (error) {
        await appendEvent(redis, { type: "command_failed", device: device.id, description: `Falha no comando para ${device.id}: ${error.message}` });
        return respond(response, 502, { detail: error.message });
      }
    }
    if (path.length === 3 && path[0] === "devices" && path[2] === "local-command" && request.method === "POST") {
      const device = (await getDevices(redis)).find(({ id }) => id === path[1]);
      if (!device) return respond(response, 404, { detail: "Dispositivo não encontrado." });
      if (device.category !== "air_conditioners") {
        return respond(response, 400, { detail: "O comando local /airon1 está disponível apenas para ar-condicionado." });
      }
      await appendEvent(redis, {
        type: "local_command_opened",
        device: device.id,
        description: `Comando GET /airon1 aberto no navegador para ${device.id} (${device.ip}).`,
      });
      return respond(response, 200, { device: device.id, status: "local_command_opened" });
    }
    if (request.method !== "GET" && request.method !== "PUT" && request.method !== "POST") {
      response.setHeader("Allow", "GET, PUT, POST");
      return respond(response, 405, { detail: "Método não permitido." });
    }
    return respond(response, 404, { detail: "Rota não encontrada." });
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 500;
    return respond(response, status, { detail: status === 500 ? "Falha interna da API HITEST." : error.message });
  }
}
