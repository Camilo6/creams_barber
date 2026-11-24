import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createServer } from "../server.js";

function nextWeekday(daysAhead = 2) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + daysAhead);
  while (date.getDay() === 0) date.setDate(date.getDate() + 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

test("public booking returns availability and prevents overlapping reservations", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "navaja-norte-"));
  const databasePath = join(directory, "test.sqlite");
  const server = createServer({ dbPath: databasePath });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const servicesResponse = await fetch(`${baseUrl}/api/services`);
  const barbersResponse = await fetch(`${baseUrl}/api/barbers`);
  assert.equal(servicesResponse.status, 200);
  assert.equal(barbersResponse.status, 200);
  const services = await servicesResponse.json();
  const barbers = await barbersResponse.json();
  const appointmentDate = nextWeekday();
  const service = services.find((item) => item.id === "corte-clasico");
  const barber = barbers.find((item) => item.id === "andres");
  const query = new URLSearchParams({ date: appointmentDate, serviceId: service.id, barberId: barber.id });
  const availability = await fetch(`${baseUrl}/api/availability?${query}`);
  const { slots } = await availability.json();
  assert.ok(slots.includes("09:00"));

  const booking = {
    name: "Cliente de prueba",
    phone: "+573001234567",
    consent: true,
    serviceId: service.id,
    barberId: barber.id,
    date: appointmentDate,
    time: "09:00",
  };
  const createdResponse = await fetch(`${baseUrl}/api/appointments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(booking),
  });
  assert.equal(createdResponse.status, 201);
  const { appointment, cancelToken } = await createdResponse.json();
  assert.equal(appointment.name, booking.name);
  assert.equal(appointment.status, "Confirmada");
  assert.match(cancelToken, /^[A-Za-z0-9_-]{43}$/);

  const cancellationDetails = await fetch(`${baseUrl}/api/cancellations/${cancelToken}`);
  assert.equal(cancellationDetails.status, 200);
  assert.equal((await cancellationDetails.json()).canCancel, true);

  const availabilityAfterBooking = await fetch(`${baseUrl}/api/availability?${query}`);
  const updatedSlots = await availabilityAfterBooking.json();
  assert.ok(!updatedSlots.slots.includes("09:00"));

  const duplicateResponse = await fetch(`${baseUrl}/api/appointments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(booking),
  });
  assert.equal(duplicateResponse.status, 409);

  const overlappingLongService = await fetch(`${baseUrl}/api/appointments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...booking, serviceId: "corte-barba" }),
  });
  assert.equal(overlappingLongService.status, 409);

  const cancelledResponse = await fetch(`${baseUrl}/api/cancellations/${cancelToken}`, { method: "POST" });
  assert.equal(cancelledResponse.status, 200);
  assert.equal((await cancelledResponse.json()).appointment.status, "Cancelada");

  const repeatedCancellation = await fetch(`${baseUrl}/api/cancellations/${cancelToken}`, { method: "POST" });
  assert.equal(repeatedCancellation.status, 200);

  const availableAgain = await fetch(`${baseUrl}/api/availability?${query}`);
  assert.ok((await availableAgain.json()).slots.includes("09:00"));

  const replacementBookingResponse = await fetch(`${baseUrl}/api/appointments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...booking, name: "Cliente de reemplazo" }),
  });
  assert.equal(replacementBookingResponse.status, 201);
  const { appointment: replacementBooking } = await replacementBookingResponse.json();
  const barberCancellation = await fetch(`${baseUrl}/api/admin/appointments/${replacementBooking.id}/cancel`, {
    method: "POST",
  });
  assert.equal(barberCancellation.status, 200);

  const appointmentsResponse = await fetch(`${baseUrl}/api/appointments?from=${appointmentDate}&to=${appointmentDate}`);
  const appointments = await appointmentsResponse.json();
  assert.equal(appointments.appointments.length, 2);
  assert.equal(appointments.appointments.find((item) => item.id === appointment.id).cancelledBy, "customer");
  assert.equal(appointments.appointments.find((item) => item.id === replacementBooking.id).cancelledBy, "barber");
});

test("booking rejects a Sunday and a phone number that is too short", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "navaja-norte-"));
  const databasePath = join(directory, "test.sqlite");
  const server = createServer({ dbPath: databasePath });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const sunday = new Date();
  sunday.setHours(12, 0, 0, 0);
  do sunday.setDate(sunday.getDate() + 1); while (sunday.getDay() !== 0);
  const sundayString = `${sunday.getFullYear()}-${String(sunday.getMonth() + 1).padStart(2, "0")}-${String(sunday.getDate()).padStart(2, "0")}`;
  const sundayAvailability = await fetch(`${baseUrl}/api/availability?${new URLSearchParams({
    date: sundayString,
    serviceId: "corte-clasico",
    barberId: "andres",
  })}`);
  assert.equal(sundayAvailability.status, 400);

  const invalidPhone = await fetch(`${baseUrl}/api/appointments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Cliente de prueba",
      phone: "123",
      consent: true,
      serviceId: "corte-clasico",
      barberId: "andres",
      date: nextWeekday(),
      time: "09:00",
    }),
  });
  assert.equal(invalidPhone.status, 400);

  const validBooking = await fetch(`${baseUrl}/api/appointments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Cliente de prueba",
      phone: "+573001234567",
      consent: true,
      serviceId: "corte-clasico",
      barberId: "andres",
      date: nextWeekday(),
      time: "09:00",
    }),
  });
  const { appointment, cancelToken } = await validBooking.json();
  assert.equal(validBooking.status, 201);

  const database = new DatabaseSync(databasePath);
  const nearStart = new Date(Date.now() + 60 * 60 * 1000);
  const nearDate = `${nearStart.getFullYear()}-${String(nearStart.getMonth() + 1).padStart(2, "0")}-${String(nearStart.getDate()).padStart(2, "0")}`;
  const nearTime = `${String(nearStart.getHours()).padStart(2, "0")}:${String(nearStart.getMinutes()).padStart(2, "0")}`;
  database.prepare("UPDATE appointments SET start_at = ? WHERE id = ?").run(`${nearDate}T${nearTime}`, appointment.id);
  database.close();

  const lateCancellation = await fetch(`${baseUrl}/api/cancellations/${cancelToken}`, { method: "POST" });
  assert.equal(lateCancellation.status, 409);
  assert.match((await lateCancellation.json()).error, /2 horas/);
});

test("any available barber booking assigns a free barber atomically", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "the-creams-"));
  const databasePath = join(directory, "test.sqlite");
  const server = createServer({ dbPath: databasePath });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const barbersResponse = await fetch(`${baseUrl}/api/barbers`);
  const barbers = await barbersResponse.json();
  assert.equal(barbers.find((barber) => barber.id === "any").name, "Cualquiera disponible");
  assert.deepEqual(
    barbers.filter((barber) => barber.id !== "any").map((barber) => barber.name).sort(),
    ["Brayan", "Kevin", "Marlon"],
  );

  const bookingDate = nextWeekday();
  const availabilityQuery = new URLSearchParams({
    date: bookingDate,
    serviceId: "corte-clasico",
    barberId: "any",
  });
  const initialAvailability = await fetch(`${baseUrl}/api/availability?${availabilityQuery}`);
  assert.ok((await initialAvailability.json()).slots.includes("09:00"));

  const assignedBarbers = new Set();
  for (let index = 0; index < 3; index += 1) {
    const response = await fetch(`${baseUrl}/api/appointments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: `Cliente ${index + 1}`,
        phone: "+573001234567",
        consent: true,
        serviceId: "corte-clasico",
        barberId: "any",
        date: bookingDate,
        time: "09:00",
      }),
    });
    assert.equal(response.status, 201);
    assignedBarbers.add((await response.json()).appointment.barber);
  }
  assert.deepEqual([...assignedBarbers].sort(), ["Brayan", "Kevin", "Marlon"]);

  const fullAvailability = await fetch(`${baseUrl}/api/availability?${availabilityQuery}`);
  assert.ok(!(await fullAvailability.json()).slots.includes("09:00"));

  const fullBooking = await fetch(`${baseUrl}/api/appointments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Cliente 4",
      phone: "+573001234567",
      consent: true,
      serviceId: "corte-clasico",
      barberId: "any",
      date: bookingDate,
      time: "09:00",
    }),
  });
  assert.equal(fullBooking.status, 409);
});
