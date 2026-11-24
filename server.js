import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFile } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = dirname(fileURLToPath(import.meta.url));
const openingMinute = 9 * 60;
const closingMinute = 20 * 60;
const bookingWindowDays = 60;
const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
};
const staticFiles = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/reservar", "reservar.html"],
  ["/reservar/", "reservar.html"],
  ["/reservar.html", "reservar.html"],
  ["/sucursal", "sucursal.html"],
  ["/sucursal/", "sucursal.html"],
  ["/sucursal.html", "sucursal.html"],
  ["/logo-the-creams.png", "logo-the-creams.png"],
  ["/the-creams-shop.png", "the-creams-shop.png"],
  ["/cancelar", "cancelar.html"],
  ["/cancelar/", "cancelar.html"],
  ["/cancelar.html", "cancelar.html"],
  ["/styles.css", "styles.css"],
  ["/sucursal.css", "sucursal.css"],
  ["/app.js", "app.js"],
  ["/booking.css", "booking.css"],
  ["/booking.js", "booking.js"],
  ["/cancel.css", "cancel.css"],
  ["/cancel.js", "cancel.js"],
]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function addDays(dateString, days) {
  const [year, month, day] = dateString.split("-").map(Number);
  const date = new Date(year, month - 1, day + days, 12);
  return localDate(date);
}

function isValidDate(dateString) {
  if (typeof dateString !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateString)) return false;
  const [year, month, day] = dateString.split("-").map(Number);
  const date = new Date(year, month - 1, day, 12);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function validateBookableDate(dateString) {
  if (!isValidDate(dateString)) throw new HttpError(400, "Selecciona una fecha válida.");
  const today = localDate();
  if (dateString < today || dateString > addDays(today, bookingWindowDays)) {
    throw new HttpError(400, `Puedes reservar desde hoy y hasta ${bookingWindowDays} días adelante.`);
  }
  const dayOfWeek = new Date(`${dateString}T12:00:00`).getDay();
  if (dayOfWeek === 0) throw new HttpError(400, "La barbería está cerrada los domingos.");
}

function createDatabase(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS services (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
      price_cop INTEGER NOT NULL CHECK (price_cop >= 0),
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS barbers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS appointments (
      id TEXT PRIMARY KEY,
      client_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT,
      service_id TEXT NOT NULL REFERENCES services(id),
      barber_id TEXT NOT NULL REFERENCES barbers(id),
      start_at TEXT NOT NULL,
      duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
      status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled')),
      consented_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      cancel_token_hash TEXT,
      cancelled_at TEXT,
      cancelled_by TEXT
    );
    CREATE INDEX IF NOT EXISTS appointments_by_barber_and_start
      ON appointments (barber_id, start_at, status);
  `);
  const appointmentColumns = new Set(db.prepare("PRAGMA table_info(appointments)").all().map((column) => column.name));
  [
    ["consented_at", "TEXT"],
    ["cancel_token_hash", "TEXT"],
    ["cancelled_at", "TEXT"],
    ["cancelled_by", "TEXT"],
  ].forEach(([name, type]) => {
    if (!appointmentColumns.has(name)) db.exec(`ALTER TABLE appointments ADD COLUMN ${name} ${type}`);
  });
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS appointments_by_cancel_token
      ON appointments (cancel_token_hash) WHERE cancel_token_hash IS NOT NULL;
  `);

  const insertService = db.prepare(`
    INSERT OR IGNORE INTO services (id, name, duration_minutes, price_cop)
    VALUES (?, ?, ?, ?)
  `);
  [
    ["corte-clasico", "Corte clásico", 30, 35000],
    ["corte-barba", "Corte + barba", 60, 55000],
    ["arreglo-barba", "Arreglo de barba", 30, 25000],
    ["corte-infantil", "Corte infantil", 30, 30000],
  ].forEach((service) => insertService.run(...service));

  const insertBarber = db.prepare("INSERT OR IGNORE INTO barbers (id, name) VALUES (?, ?)");
  const barbers = [["andres", "Kevin"], ["mateo", "Brayan"], ["sebastian", "Marlon"]];
  barbers.forEach(([id, name]) => {
    insertBarber.run(id, name);
    db.prepare("UPDATE barbers SET name = ? WHERE id = ?").run(name, id);
  });

  return db;
}

function readAppointmentsForDay(db, barberId, date) {
  return db.prepare(`
    SELECT start_at, duration_minutes
    FROM appointments
    WHERE barber_id = ? AND status = 'confirmed'
      AND start_at >= ? AND start_at < ?
  `).all(barberId, `${date}T00:00`, `${addDays(date, 1)}T00:00`);
}

function availableSlots(db, date, service, barberId) {
  const dayAppointments = readAppointmentsForDay(db, barberId, date);
  const duration = service.duration_minutes;
  const slots = [];

  for (let startMinute = openingMinute; startMinute + duration <= closingMinute; startMinute += 30) {
    const endMinute = startMinute + duration;
    const overlaps = dayAppointments.some((appointment) => {
      const startAt = appointment.start_at.slice(11, 16).split(":").map(Number);
      const bookedStart = startAt[0] * 60 + startAt[1];
      const bookedEnd = bookedStart + appointment.duration_minutes;
      return startMinute < bookedEnd && bookedStart < endMinute;
    });
    if (!overlaps) {
      slots.push(`${String(Math.floor(startMinute / 60)).padStart(2, "0")}:${String(startMinute % 60).padStart(2, "0")}`);
    }
  }
  return slots;
}

function requiredText(value, label, maxLength) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    throw new HttpError(400, `Escribe ${label} (máximo ${maxLength} caracteres).`);
  }
  return value.trim();
}

function normalizePhone(value) {
  if (typeof value !== "string") throw new HttpError(400, "Escribe un teléfono válido.");
  const phone = value.replace(/[\s()-]/g, "");
  if (!/^\+?\d{7,15}$/.test(phone)) throw new HttpError(400, "Escribe un teléfono válido con código de país si aplica.");
  return phone;
}

function normalizeEmail(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw new HttpError(400, "Escribe un correo electrónico válido o deja el campo vacío.");
  }
  return value.trim().toLowerCase();
}

function validateTime(time, duration) {
  if (typeof time !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new HttpError(400, "Selecciona una hora válida.");
  }
  const [hour, minute] = time.split(":").map(Number);
  const startMinute = hour * 60 + minute;
  if (minute % 30 !== 0 || startMinute < openingMinute || startMinute + duration > closingMinute) {
    throw new HttpError(400, "La hora seleccionada está fuera del horario de atención.");
  }
  return startMinute;
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 16_384) throw new HttpError(413, "La solicitud es demasiado grande.");
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new HttpError(400, "La solicitud no contiene datos válidos.");
  }
}

function sendJson(response, status, data) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(data));
}

function getService(db, id) {
  if (typeof id !== "string") throw new HttpError(400, "Selecciona un servicio disponible.");
  const service = db.prepare("SELECT * FROM services WHERE id = ? AND active = 1").get(id);
  if (!service) throw new HttpError(400, "Selecciona un servicio disponible.");
  return service;
}

function getBarber(db, id) {
  if (typeof id !== "string") throw new HttpError(400, "Selecciona un barbero disponible.");
  const barber = db.prepare("SELECT * FROM barbers WHERE id = ? AND active = 1").get(id);
  if (!barber) throw new HttpError(400, "Selecciona un barbero disponible.");
  return barber;
}

function getActiveBarbers(db) {
  return db.prepare("SELECT id, name FROM barbers WHERE active = 1 ORDER BY name").all();
}

function createAppointment(db, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "Completa los datos de la reserva.");
  }
  if (body.consent !== true) throw new HttpError(400, "Debes aceptar el uso de tus datos para gestionar la cita.");
  const clientName = requiredText(body.name, "tu nombre", 100);
  const phone = normalizePhone(body.phone);
  const email = normalizeEmail(body.email);
  const service = getService(db, body.serviceId);
  const requestedBarber = body.barberId === "any" ? null : getBarber(db, body.barberId);
  validateBookableDate(body.date);
  const startMinute = validateTime(body.time, service.duration_minutes);

  if (body.date === localDate()) {
    const now = new Date();
    if (startMinute <= now.getHours() * 60 + now.getMinutes()) {
      throw new HttpError(400, "Selecciona una hora futura para hoy.");
    }
  }

  const startAt = `${body.date}T${body.time}`;
  const id = randomUUID();
  const cancelToken = randomBytes(32).toString("base64url");
  const cancelTokenHash = createHash("sha256").update(cancelToken).digest("hex");
  const createdAt = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  let barber = requestedBarber;
  try {
    const candidates = requestedBarber ? [requestedBarber] : getActiveBarbers(db);
    barber = candidates.find((candidate) =>
      availableSlots(db, body.date, service, candidate.id).includes(body.time));
    if (!barber) {
      throw new HttpError(409, "Ese horario acaba de ocuparse. Elige otra hora disponible.");
    }
    db.prepare(`
      INSERT INTO appointments
        (id, client_name, phone, email, service_id, barber_id, start_at, duration_minutes, consented_at, created_at, cancel_token_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, clientName, phone, email, service.id, barber.id, startAt,
      service.duration_minutes, createdAt, createdAt, cancelTokenHash,
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return {
    id,
    date: body.date,
    time: body.time,
    name: clientName,
    service: service.name,
    barber: barber.name,
    price: service.price_cop,
    durationMinutes: service.duration_minutes,
    status: "Confirmada",
    cancelToken,
  };
}

function getAppointments(db, from, to) {
  if (!isValidDate(from) || !isValidDate(to) || from > to || to > addDays(localDate(), bookingWindowDays)) {
    throw new HttpError(400, "El rango de fechas no es válido.");
  }
  return db.prepare(`
    SELECT a.id, a.client_name AS name, a.start_at, a.duration_minutes,
      a.status, a.cancelled_by, s.name AS service, s.price_cop AS price, b.name AS barber
    FROM appointments a
    JOIN services s ON s.id = a.service_id
    JOIN barbers b ON b.id = a.barber_id
    WHERE a.start_at >= ? AND a.start_at < ?
    ORDER BY a.start_at
  `).all(`${from}T00:00`, `${addDays(to, 1)}T00:00`).map((row) => ({
    id: row.id,
    date: row.start_at.slice(0, 10),
    time: row.start_at.slice(11, 16),
    name: row.name,
    service: row.service,
    barber: row.barber,
    price: row.price,
    durationMinutes: row.duration_minutes,
    status: row.status === "confirmed" ? "Confirmada" : "Cancelada",
    cancelledBy: row.cancelled_by,
  }));
}

function getCancellation(db, token) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new HttpError(404, "El enlace de cancelación no es válido.");
  }
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const row = db.prepare(`
    SELECT a.id, a.client_name, a.start_at, a.status,
      s.name AS service, b.name AS barber
    FROM appointments a
    JOIN services s ON s.id = a.service_id
    JOIN barbers b ON b.id = a.barber_id
    WHERE a.cancel_token_hash = ?
  `).get(tokenHash);
  if (!row) throw new HttpError(404, "No encontramos una cita asociada a este enlace.");

  const startsAt = new Date(`${row.start_at}:00`);
  const canCancel = row.status === "confirmed" && startsAt.getTime() - Date.now() >= 2 * 60 * 60 * 1000;
  return {
    appointment: {
      date: row.start_at.slice(0, 10),
      time: row.start_at.slice(11, 16),
      service: row.service,
      barber: row.barber,
      status: row.status === "confirmed" ? "Confirmada" : "Cancelada",
    },
    canCancel,
  };
}

function cancelAppointmentByCustomer(db, token) {
  const cancellation = getCancellation(db, token);
  if (cancellation.appointment.status === "Cancelada") return cancellation.appointment;
  if (!cancellation.canCancel) {
    throw new HttpError(409, "La cancelación en línea debe hacerse al menos 2 horas antes de la cita. Comunícate directamente con la barbería.");
  }

  const tokenHash = createHash("sha256").update(token).digest("hex");
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = db.prepare(`
      UPDATE appointments
      SET status = 'cancelled', cancelled_at = ?, cancelled_by = 'customer'
      WHERE cancel_token_hash = ? AND status = 'confirmed'
    `).run(new Date().toISOString(), tokenHash);
    if (result.changes === 0) {
      const current = getCancellation(db, token);
      if (current.appointment.status !== "Cancelada") {
        throw new HttpError(409, "No se pudo cancelar la cita. Recarga e inténtalo de nuevo.");
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { ...cancellation.appointment, status: "Cancelada" };
}

function cancelAppointmentByBarber(db, id) {
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) {
    throw new HttpError(404, "No encontramos esa cita.");
  }
  const appointment = db.prepare("SELECT status FROM appointments WHERE id = ?").get(id);
  if (!appointment) throw new HttpError(404, "No encontramos esa cita.");
  if (appointment.status === "cancelled") return { id, status: "Cancelada" };

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      UPDATE appointments
      SET status = 'cancelled', cancelled_at = ?, cancelled_by = 'barber'
      WHERE id = ? AND status = 'confirmed'
    `).run(new Date().toISOString(), id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { id, status: "Cancelada" };
}

export function createServer({ dbPath = resolve(root, "data", "barbershop.sqlite") } = {}) {
  const db = createDatabase(dbPath);

  const server = createHttpServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

    try {
      const url = new URL(request.url, "http://localhost");
      if (request.method === "GET" && url.pathname === "/api/services") {
        const services = db.prepare(`
          SELECT id, name, duration_minutes AS durationMinutes, price_cop AS price
          FROM services WHERE active = 1 ORDER BY name
        `).all();
        return sendJson(response, 200, services);
      }

      if (request.method === "GET" && url.pathname === "/api/barbers") {
        return sendJson(response, 200, [
          { id: "any", name: "Cualquiera disponible" },
          ...getActiveBarbers(db),
        ]);
      }

      if (request.method === "GET" && url.pathname === "/api/availability") {
        const date = url.searchParams.get("date") || "";
        const serviceId = url.searchParams.get("serviceId") || "";
        const barberId = url.searchParams.get("barberId") || "";
        validateBookableDate(date);
        const service = getService(db, serviceId);
        const selectedBarbers = barberId === "any" ? getActiveBarbers(db) : [getBarber(db, barberId)];
        const slots = [...new Set(selectedBarbers.flatMap((barber) =>
          availableSlots(db, date, service, barber.id)))].sort();
        return sendJson(response, 200, {
          date,
          serviceId,
          barberId,
          slots: slots.filter((time) => {
            if (date !== localDate()) return true;
            const [hour, minute] = time.split(":").map(Number);
            const now = new Date();
            return hour * 60 + minute > now.getHours() * 60 + now.getMinutes();
          }),
        });
      }

      if (request.method === "POST" && url.pathname === "/api/appointments") {
        const body = await readJson(request);
        const appointment = createAppointment(db, body);
        const { cancelToken, ...publicAppointment } = appointment;
        return sendJson(response, 201, { appointment: publicAppointment, cancelToken });
      }

      if (request.method === "GET" && url.pathname === "/api/appointments") {
        const from = url.searchParams.get("from") || localDate();
        const to = url.searchParams.get("to") || addDays(from, bookingWindowDays);
        return sendJson(response, 200, { appointments: getAppointments(db, from, to) });
      }

      const cancellationMatch = url.pathname.match(/^\/api\/cancellations\/([A-Za-z0-9_-]+)$/);
      if (request.method === "GET" && cancellationMatch) {
        return sendJson(response, 200, getCancellation(db, cancellationMatch[1]));
      }

      if (request.method === "POST" && cancellationMatch) {
        const appointment = cancelAppointmentByCustomer(db, cancellationMatch[1]);
        return sendJson(response, 200, { appointment });
      }

      const adminCancellationMatch = url.pathname.match(/^\/api\/admin\/appointments\/([0-9a-f-]+)\/cancel$/i);
      if (request.method === "POST" && adminCancellationMatch) {
        return sendJson(response, 200, {
          appointment: cancelAppointmentByBarber(db, adminCancellationMatch[1]),
        });
      }

      if (request.method !== "GET") throw new HttpError(405, "Método no permitido.");
      const filename = staticFiles.get(url.pathname);
      if (!filename) throw new HttpError(404, "No encontramos esa página.");
      const filePath = join(root, filename);
      readFile(filePath, (error, content) => {
        if (error) {
          console.error(`No se pudo leer ${filePath}:`, error);
          if (!response.headersSent) sendJson(response, 500, { error: "No se pudo cargar la página." });
          return;
        }
        response.writeHead(200, {
          "Content-Type": mimeTypes[extname(filename)] || "application/octet-stream",
          "Cache-Control": "no-cache",
        });
        response.end(content);
      });
    } catch (error) {
      if (error instanceof HttpError) return sendJson(response, error.status, { error: error.message });
      console.error("Error procesando la solicitud:", error);
      return sendJson(response, 500, { error: "Ocurrió un error interno. Inténtalo de nuevo." });
    }
  });

  server.on("close", () => db.close());
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const server = createServer({ dbPath: process.env.BARBERSHOP_DB_PATH || resolve(root, "data", "barbershop.sqlite") });
  server.listen(port, "127.0.0.1", () => {
    console.log(`Propuesta The Creams Barber & Grooming disponible en http://127.0.0.1:${port}`);
    console.log("El panel y las reservas solo son accesibles desde este computador.");
  });
}
